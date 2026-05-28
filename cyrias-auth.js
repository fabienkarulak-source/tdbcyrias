/**
 * cyrias-auth.js — Authentification Planning Cyrias
 * ═══════════════════════════════════════════════════
 * Deux modes de connexion :
 *   1. Microsoft 365 SSO  — compte @cyrias.com, popup Microsoft
 *   2. Magic link email   — saisir son @cyrias.com, cliquer le lien reçu
 *
 * Dépend de MS_CONFIG défini dans index.html.
 * Expose les fonctions utilisées par le HTML :
 *   init(), loginWithMicrosoft(), loginWithMagicLink(),
 *   logout(), scheduleSave()
 */

'use strict';

// ── AUTH STATE ────────────────────────────────────────────────────────
let msIdToken   = sessionStorage.getItem('ms_id_token')    || null;
let mlToken     = sessionStorage.getItem('ml_session')     || null; // magic link session
let authMethod  = sessionStorage.getItem('auth_method')    || null; // 'ms' | 'ml'
let msUser      = null;   // { email, name }
let userRole    = null;   // 'admin' | 'editor' | 'viewer' | null
let dataSha     = null;
let saveTimeout = null;

// ── UTILS ─────────────────────────────────────────────────────────────
function isValidCyriasEmail(email) {
  return /^[^\s@]+@cyrias\.com$/i.test(email.trim());
}

// ── WORKER API ────────────────────────────────────────────────────────
async function workerPost(endpoint, body = {}) {
  const authPayload = authMethod === 'ml'
    ? { ml_token: mlToken }
    : { id_token: msIdToken };

  const res = await fetch(`${MS_CONFIG.WORKER_URL}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...body, ...authPayload }),
  });

  if (res.status === 401) {
    logout();
    throw new Error('Session expirée — reconnectez-vous');
  }
  return res;
}

// ── MICROSOFT SSO (PKCE — sans client_secret) ─────────────────────────
async function generatePKCE() {
  const arr      = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...arr))
    .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=/g, '');
  const data     = new TextEncoder().encode(verifier);
  const digest   = await crypto.subtle.digest('SHA-256', data);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=/g, '');
  return { verifier, challenge };
}

async function loginWithMicrosoft() {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('ms_state',      state);

  const params = new URLSearchParams({
    client_id:             MS_CONFIG.CLIENT_ID,
    response_type:         'code',
    redirect_uri:          MS_CONFIG.REDIRECT_URI,
    scope:                 MS_CONFIG.SCOPES.join(' '),
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    response_mode:         'query',
  });
  location.href = `https://login.microsoftonline.com/${MS_CONFIG.TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

async function handleMsCallback() {
  const params = new URLSearchParams(location.search);
  const code   = params.get('code');
  if (!code) return false;

  if (params.get('state') !== sessionStorage.getItem('ms_state')) {
    showLoginScreen('Erreur de sécurité (state mismatch). Veuillez réessayer.');
    return false;
  }

  history.replaceState({}, '', location.pathname);
  showLoginScreen('Connexion Microsoft en cours…', true);

  try {
    const verifier  = sessionStorage.getItem('pkce_verifier');
    const tokenRes  = await fetch(
      `https://login.microsoftonline.com/${MS_CONFIG.TENANT_ID}/oauth2/v2.0/token`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     MS_CONFIG.CLIENT_ID,
          grant_type:    'authorization_code',
          code,
          redirect_uri:  MS_CONFIG.REDIRECT_URI,
          code_verifier: verifier,
          scope:         MS_CONFIG.SCOPES.join(' '),
        }),
      }
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}));
      throw new Error(err.error_description || `HTTP ${tokenRes.status}`);
    }

    const tokens = await tokenRes.json();
    msIdToken    = tokens.id_token;
    authMethod   = 'ms';
    sessionStorage.setItem('ms_id_token', msIdToken);
    sessionStorage.setItem('auth_method', 'ms');
    sessionStorage.removeItem('pkce_verifier');
    sessionStorage.removeItem('ms_state');
    return true;

  } catch (e) {
    showLoginScreen(`Erreur Microsoft : ${e.message}`);
    return false;
  }
}

// ── MAGIC LINK ────────────────────────────────────────────────────────
// Flux :
//   1. Utilisateur saisit son @cyrias.com → POST /magic-link/request au Worker
//   2. Worker génère un token HMAC signé + l'écrit dans KV (TTL 15 min)
//      + envoie l'email via Microsoft Graph (compte no-reply de l'app)
//   3. Utilisateur clique le lien → ?magic_token=xxx dans l'URL
//   4. handleMagicCallback() → POST /magic-link/verify au Worker
//   5. Worker vérifie le token KV, lit users.json → renvoie { session_token, role, email }
//   6. session_token stocké en sessionStorage, utilisé pour /read et /write

async function loginWithMagicLink(email) {
  email = email.trim().toLowerCase();

  if (!isValidCyriasEmail(email)) {
    showLoginScreen('Seules les adresses @cyrias.com sont autorisées.', false, true);
    return;
  }

  showLoginScreen(`Envoi du lien à ${email}…`, true);

  try {
    const res = await fetch(`${MS_CONFIG.WORKER_URL}/magic-link/request`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email }),
    });

    const data = await res.json();

    if (!res.ok) {
      // 403 = email non dans users.json
      if (res.status === 403) {
        showLoginScreen(
          `<span style="color:#fca5a5;">⛔ <strong>${email}</strong> n'est pas autorisé.<br>
           Contactez un administrateur Cyrias.</span>`,
          false, true
        );
      } else {
        showLoginScreen(`Erreur : ${data.error || res.status}`, false, true);
      }
      return;
    }

    // Succès → afficher confirmation
    showLoginScreen(
      `<div style="text-align:center;">
        <div style="font-size:28px;margin-bottom:8px;">📬</div>
        <div style="font-weight:600;color:var(--cyrias-blue-dark);margin-bottom:4px;">
          Lien envoyé !
        </div>
        <div style="font-size:12px;color:var(--text3);line-height:1.5;">
          Vérifiez votre boîte <strong>${email}</strong><br>
          Le lien est valable <strong>15 minutes</strong>.
        </div>
      </div>`,
      false, true
    );

  } catch (e) {
    showLoginScreen(`Erreur réseau : ${e.message}`, false, true);
  }
}

async function handleMagicCallback() {
  const params      = new URLSearchParams(location.search);
  const magicToken  = params.get('magic_token');
  if (!magicToken) return false;

  history.replaceState({}, '', location.pathname);
  showLoginScreen('Vérification du lien…', true);

  try {
    const res  = await fetch(`${MS_CONFIG.WORKER_URL}/magic-link/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: magicToken }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = res.status === 410
        ? 'Ce lien a expiré ou a déjà été utilisé. Demandez-en un nouveau.'
        : `Lien invalide : ${data.error || res.status}`;
      showLoginScreen(msg, false, true);
      return false;
    }

    // Stocker la session magic link
    mlToken    = data.session_token;
    authMethod = 'ml';
    sessionStorage.setItem('ml_session',  mlToken);
    sessionStorage.setItem('auth_method', 'ml');

    // Pré-remplir msUser depuis la réponse du Worker
    msUser = { email: data.email, name: data.name || data.email.split('@')[0] };
    userRole = data.role;
    return true;

  } catch (e) {
    showLoginScreen(`Erreur vérification : ${e.message}`, false, true);
    return false;
  }
}

// ── PROFIL & RÔLE ─────────────────────────────────────────────────────
async function fetchUserAndRole() {
  if (authMethod === 'ml') {
    // Déjà rempli lors du handleMagicCallback — juste re-vérifier la session
    const res  = await workerPost('/auth');
    if (!res.ok) throw new Error(`Session invalide (${res.status})`);
    const data = await res.json();
    userRole   = data.role;
    msUser     = { email: data.email, name: data.name || data.email };
    return;
  }

  // Méthode Microsoft SSO : décoder le JWT localement pour email/nom
  const parts   = msIdToken.split('.');
  const pad     = parts[1].replace(/[-]/g, '+').replace(/[_]/g, '/');
  const raw     = atob(pad.padEnd(pad.length + (4 - pad.length % 4) % 4, '='));
  const payload = JSON.parse(raw);
  msUser = {
    email: payload.email || payload.preferred_username || '',
    name:  payload.name  || '',
  };

  // Appel Worker /auth pour obtenir le rôle depuis users.json
  const res  = await fetch(`${MS_CONFIG.WORKER_URL}/auth`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ id_token: msIdToken }),
  });

  if (!res.ok) {
    if (res.status === 403) { userRole = null; return; }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Worker ${res.status}`);
  }

  const data = await res.json();
  userRole   = data.role;
  msUser.name = data.name || msUser.name;
}

// ── DÉCONNEXION ───────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('ms_id_token');
  sessionStorage.removeItem('ml_session');
  sessionStorage.removeItem('auth_method');
  msIdToken  = null;
  mlToken    = null;
  authMethod = null;
  msUser     = null;
  userRole   = null;
  dataSha    = null;
  showLoginScreen();
}

// ── LECTURE / ÉCRITURE VIA WORKER ────────────────────────────────────
async function loadFromStorage() {
  try {
    const res  = await workerPost('/read');
    if (!res.ok) throw new Error(`Worker /read: ${res.status}`);
    const data = await res.json();
    dataSha    = data.sha;
    return data.content;
  } catch (e) {
    dataSha = null;
    return null;
  }
}

async function saveToStorage(data) {
  setSyncing(true);
  try {
    const res = await workerPost('/write', { data, sha: dataSha });

    if (res.status === 409) {
      toast('⚠️ Conflit — rechargement…');
      const fresh = await loadFromStorage();
      if (fresh) { window.state = fresh; render(); }
      saveTimeout = setTimeout(() => saveToStorage(window.state), 2000);
      return;
    }

    if (!res.ok) throw new Error(`Worker /write: ${res.status}`);
    const result = await res.json();
    dataSha = result.sha;
    setSyncing(false);

  } catch (e) {
    setSyncing(false, true);
    console.error('Save error:', e);
  }
}

function scheduleSave() {
  if (userRole === 'viewer') return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveToStorage(window.state), 2500);
}

// ── UI LOGIN ──────────────────────────────────────────────────────────
// showLoginScreen(msg, loading, showEmailForm)
function showLoginScreen(msg = '', loading = false, showEmailForm = false) {
  document.getElementById('appShell').style.display = 'none';
  const el = document.getElementById('loginScreen');
  el.style.display = 'flex';

  document.getElementById('loginMsg').innerHTML      = msg;
  document.getElementById('loginSpinner').style.display  = loading ? 'block' : 'none';
  document.getElementById('loginBtn').style.display      = loading ? 'none'  : 'flex';
  document.getElementById('loginDivider').style.display  = loading ? 'none'  : 'flex';
  document.getElementById('loginEmailForm').style.display = (loading || !showEmailForm) ? 'none' : 'block';

  // Basculer vers le formulaire email si showEmailForm
  if (showEmailForm && !loading) {
    document.getElementById('loginEmailInput').focus();
  }
}

function hideLoginScreen() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display    = '';
}

// ── BADGE UTILISATEUR (topbar) ────────────────────────────────────────
function renderUserBadge() {
  const bar      = document.getElementById('topbar-right');
  const existing = document.getElementById('userBadge');
  if (existing) existing.remove();

  const roleLabel = { admin: 'Admin', editor: 'Éditeur', viewer: 'Lecteur' }[userRole] || '—';
  const roleColor = {
    admin:  'var(--cyrias-green)',
    editor: 'rgba(255,255,255,.7)',
    viewer: '#f59e0b',
  }[userRole] || '#fff';

  const methodIcon = authMethod === 'ml' ? '✉️' : '🔷';

  const badge = document.createElement('div');
  badge.id = 'userBadge';
  badge.style.cssText = [
    'display:flex', 'align-items:center', 'gap:8px',
    'padding:4px 10px 4px 8px',
    'background:rgba(255,255,255,.1)',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:20px',
    'cursor:pointer',
    'transition:background .15s',
  ].join(';');

  badge.title = `${msUser.email} · ${roleLabel} · connexion ${authMethod === 'ml' ? 'magic link' : 'Microsoft SSO'}\nCliquer pour se déconnecter`;

  // Avatar initiales
  const initStr = (msUser.name || msUser.email).split(/[\s@.]/)[0].slice(0, 2).toUpperCase();
  badge.innerHTML = `
    <div style="
      width:22px;height:22px;border-radius:50%;
      background:rgba(255,255,255,.22);
      display:flex;align-items:center;justify-content:center;
      font-size:9px;font-weight:700;color:#fff;flex-shrink:0;
    ">${initStr}</div>
    <div style="line-height:1.2;">
      <div style="font-size:12px;font-weight:600;color:#fff;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${msUser.name || msUser.email.split('@')[0]}
      </div>
      <div style="font-size:10px;color:${roleColor};font-weight:500;">
        ${methodIcon} ${roleLabel}
      </div>
    </div>
  `;

  badge.addEventListener('mouseenter', () => badge.style.background = 'rgba(255,255,255,.18)');
  badge.addEventListener('mouseleave', () => badge.style.background = 'rgba(255,255,255,.10)');
  badge.addEventListener('click', () => {
    if (confirm(`Se déconnecter ?\n${msUser.email}`)) logout();
  });

  bar.insertBefore(badge, bar.firstChild);
}

// ── APPLICATION DES RÔLES ─────────────────────────────────────────────
function applyRole() {
  if (!userRole) {
    document.getElementById('appShell').style.display = 'none';
    const el = document.getElementById('loginScreen');
    el.style.display = 'flex';
    document.getElementById('loginMsg').innerHTML = `
      <span style="color:#fca5a5;">
        ⛔ <strong>${msUser ? msUser.email : ''}</strong> n'est pas autorisé.<br>
        Contactez un administrateur Cyrias.
      </span>`;
    document.getElementById('loginSpinner').style.display  = 'none';
    document.getElementById('loginBtn').style.display      = 'flex';
    document.getElementById('loginDivider').style.display  = 'flex';
    document.getElementById('loginEmailForm').style.display = 'none';
    return false;
  }

  const isAdmin  = userRole === 'admin';
  const canWrite = userRole !== 'viewer';

  if (!canWrite) {
    document.querySelectorAll('.presence-cell,.presence-empty,.row-dup-btn').forEach(el => {
      el.style.pointerEvents = 'none';
      el.style.opacity       = '0.55';
      el.title               = 'Lecture seule';
    });
  }

  document.getElementById('settingsBtn').style.display      = isAdmin ? '' : 'none';
  document.getElementById('addPersonSideBtn').style.display = isAdmin ? '' : 'none';
  document.getElementById('exportBtn').style.display        = isAdmin ? '' : 'none';
  document.getElementById('actionsBtn').style.display       = isAdmin ? '' : 'none';

  return true;
}

// ── SYNC BADGE ────────────────────────────────────────────────────────
function setSyncing(syncing, err) {
  const dot = document.getElementById('syncDot');
  const lbl = document.getElementById('syncLabel');
  if (syncing) {
    dot.className   = 'sync-dot syncing';
    lbl.textContent = 'Synchronisation…';
  } else if (err) {
    dot.className        = 'sync-dot';
    dot.style.background = '#ef4444';
    lbl.textContent      = 'Erreur sync';
  } else {
    dot.className        = 'sync-dot';
    dot.style.background = 'var(--cyrias-green)';
    lbl.textContent      = 'Synchronisé';
  }
}

// ── INIT ──────────────────────────────────────────────────────────────
async function init() {

  // 1. Callback magic link ? (?magic_token=…)
  if (location.search.includes('magic_token=')) {
    const ok = await handleMagicCallback();
    if (!ok) return;
    // msUser et userRole déjà remplis par handleMagicCallback
    hideLoginScreen();
    renderUserBadge();
    if (!applyRole()) return;
    await _loadAndRender();
    return;
  }

  // 2. Callback Microsoft SSO ? (?code=…)
  if (location.search.includes('code=')) {
    const ok = await handleMsCallback();
    if (!ok) return;
  }

  // 3. Session déjà active (rechargement de page) ?
  const hasSession = (authMethod === 'ms' && msIdToken) ||
                     (authMethod === 'ml' && mlToken);

  if (!hasSession) {
    showLoginScreen('', false, false);
    return;
  }

  // 4. Charger le profil et le rôle depuis le Worker
  showLoginScreen('Chargement…', true);
  try {
    await fetchUserAndRole();
  } catch (e) {
    showLoginScreen(`Erreur : ${e.message}`, false, true);
    return;
  }

  // 5. Vérifier les droits
  hideLoginScreen();
  renderUserBadge();
  if (!applyRole()) return;

  // 6. Charger le planning
  await _loadAndRender();
}

async function _loadAndRender() {
  setSyncing(true);
  try {
    const saved = await loadFromStorage();
    if (saved && saved.persons && saved.lieux) {
      window.state = saved;
      if (!window.state.feries)
        window.state.feries = JSON.parse(JSON.stringify(FR_FERIES_DEFAULT));
      if (!window.state.siteGroups) window.state.siteGroups = [];
      if (window.state.solidarite === undefined) window.state.solidarite = null;
    }
  } catch (e) {
    toast('⚠️ Impossible de charger le planning');
  }
  render();
  setSyncing(false);

  // Auto-refresh 60s
  setInterval(async () => {
    if (document.hidden || !userRole) return;
    try {
      const fresh = await loadFromStorage();
      if (fresh && fresh.persons && fresh.lieux && !saveTimeout) {
        window.state = fresh;
        if (!window.state.feries)
          window.state.feries = JSON.parse(JSON.stringify(FR_FERIES_DEFAULT));
        if (!window.state.siteGroups) window.state.siteGroups = [];
        if (window.state.solidarite === undefined) window.state.solidarite = null;
        render();
      }
    } catch (e) { /* silencieux */ }
  }, 60_000);
}

// ── WIRING DES BOUTONS DU LOGIN ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Bouton Microsoft SSO
  document.getElementById('loginBtn')
    .addEventListener('click', loginWithMicrosoft);

  // Bouton "Connexion par email" → bascule vers le formulaire
  document.getElementById('loginEmailToggle')
    .addEventListener('click', () => {
      showLoginScreen('', false, true);
    });

  // Retour depuis le formulaire email
  document.getElementById('loginEmailBack')
    .addEventListener('click', () => {
      showLoginScreen('', false, false);
    });

  // Soumission du formulaire email
  async function submitMagicLink() {
    const email = document.getElementById('loginEmailInput').value.trim();
    if (!email) return;
    await loginWithMagicLink(email);
  }

  document.getElementById('loginEmailSendBtn')
    .addEventListener('click', submitMagicLink);

  document.getElementById('loginEmailInput')
    .addEventListener('keydown', e => { if (e.key === 'Enter') submitMagicLink(); });

  // Lancer l'init
  init();
});
