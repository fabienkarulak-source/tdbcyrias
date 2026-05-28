/**
 * CYRIAS PLANNING — Cloudflare Worker v3
 * ═══════════════════════════════════════
 * Auth double mode :
 *   • Microsoft SSO  : vérifie l'id_token JWT Microsoft
 *   • Magic link     : génère + envoie + vérifie des tokens éphémères
 *
 * VARIABLES D'ENVIRONNEMENT (Settings > Variables) :
 * ┌──────────────────┬────────────────────────────────────────────────────┐
 * │ MS_TENANT_ID     │ Directory (tenant) ID Azure                        │
 * │ MS_CLIENT_ID     │ Application (client) ID Azure                      │
 * │ MS_CLIENT_SECRET │ Secret Azure (pour Graph API mail) — CHIFFRÉ       │
 * │ MAIL_FROM        │ ex: planning@cyrias.com (expéditeur des liens)     │
 * │ APP_URL          │ URL de l'app ex: https://....github.io/cyrias-...  │
 * │ GH_PAT           │ Personal Access Token GitHub — CHIFFRÉ             │
 * │ GH_REPO          │ ex: fabienkarulak-source/cyrias-planning-data      │
 * │ MAGIC_SECRET     │ Chaîne aléatoire 32+ chars pour signer les tokens  │
 * │ ALLOWED_ORIGIN   │ URL exacte de l'app (CORS)                         │
 * └──────────────────┴────────────────────────────────────────────────────┘
 *
 * KV NAMESPACE :
 *   Créer un KV namespace "CYRIAS_TOKENS" dans Cloudflare
 *   et le lier à ce Worker (Settings > Bindings > KV Namespace)
 *   Variable name : CYRIAS_TOKENS
 *
 * PERMISSIONS AZURE supplémentaires requises pour l'envoi d'email :
 *   API permissions > Microsoft Graph > Application > Mail.Send
 *   + Admin consent accordé
 */

const TOKEN_TTL_SECONDS   = 15 * 60;      // magic link valable 15 min
const SESSION_TTL_SECONDS = 8 * 60 * 60;  // session magic link 8h

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(allowed) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, allowed);
    }

    const path = new URL(request.url).pathname;
    let body;
    try { body = await request.json(); } catch { body = {}; }

    // ── /magic-link/request ──────────────────────────────────────────
    if (path === '/magic-link/request') {
      const email = (body.email || '').trim().toLowerCase();

      if (!email || !/^[^\s@]+@cyrias\.com$/i.test(email)) {
        return json({ error: 'Adresse @cyrias.com requise' }, 400, allowed);
      }

      const users = await readUsersJson(env);
      if (!users) return json({ error: 'Erreur lecture users.json' }, 500, allowed);

      const role = getRoleFromUsers(users, email);
      if (!role) return json({ error: 'Email non autorisé' }, 403, allowed);

      // Token signé HMAC-SHA256
      const raw       = `${email}:${Date.now()}:${crypto.randomUUID()}`;
      const signature = await hmacSign(env.MAGIC_SECRET, raw);
      const token     = `${btoa(raw)}.${signature}`;

      await env.CYRIAS_TOKENS.put(
        `ml:${token}`,
        JSON.stringify({ email, role, created: Date.now() }),
        { expirationTtl: TOKEN_TTL_SECONDS }
      );

      const magicUrl = `${env.APP_URL}?magic_token=${encodeURIComponent(token)}`;
      const sent     = await sendMagicEmail(env, email, magicUrl);
      if (!sent) return json({ error: 'Erreur envoi email' }, 500, allowed);

      return new Response(null, { status: 204, headers: cors(allowed) });
    }

    // ── /magic-link/verify ───────────────────────────────────────────
    if (path === '/magic-link/verify') {
      const { token } = body;
      if (!token) return json({ error: 'Token manquant' }, 400, allowed);

      const stored = await env.CYRIAS_TOKENS.get(`ml:${token}`);
      if (!stored) return json({ error: 'Token invalide ou expiré' }, 410, allowed);

      const { email, role } = JSON.parse(stored);
      await env.CYRIAS_TOKENS.delete(`ml:${token}`); // usage unique

      const sessionToken = crypto.randomUUID();
      const name = email.split('@')[0].replace('.', ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

      await env.CYRIAS_TOKENS.put(
        `session:${sessionToken}`,
        JSON.stringify({ email, role, name, created: Date.now() }),
        { expirationTtl: SESSION_TTL_SECONDS }
      );

      return json({ session_token: sessionToken, role, email, name }, 200, allowed);
    }

    // ── Résolution de l'identité ─────────────────────────────────────
    let callerEmail, callerRole, callerName;

    if (body.ml_token) {
      const stored = await env.CYRIAS_TOKENS.get(`session:${body.ml_token}`);
      if (!stored) return json({ error: 'Session expirée' }, 401, allowed);
      const s = JSON.parse(stored);
      callerEmail = s.email; callerRole = s.role; callerName = s.name;

    } else if (body.id_token) {
      let payload;
      try {
        const parts  = body.id_token.split('.');
        const padded = parts[1].replace(/[-]/g, '+').replace(/[_]/g, '/');
        payload = JSON.parse(atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '=')));
      } catch { return json({ error: 'Token invalide' }, 401, allowed); }

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) return json({ error: 'Token expiré' }, 401, allowed);
      if (payload.tid !== env.MS_TENANT_ID)  return json({ error: 'Tenant non autorisé' }, 403, allowed);

      callerEmail = (payload.email || payload.preferred_username || '').toLowerCase();
      callerName  = payload.name || callerEmail;
      if (!callerEmail) return json({ error: 'Email absent du token' }, 400, allowed);

      const users = await readUsersJson(env);
      if (!users) return json({ error: 'Erreur users.json' }, 500, allowed);
      callerRole = getRoleFromUsers(users, callerEmail);
      if (!callerRole) return json({ error: 'Accès refusé', email: callerEmail }, 403, allowed);

    } else {
      return json({ error: 'Authentification requise' }, 401, allowed);
    }

    // ── /auth ─────────────────────────────────────────────────────────
    if (path === '/auth') {
      return json({ role: callerRole, email: callerEmail, name: callerName }, 200, allowed);
    }

    // ── /read ─────────────────────────────────────────────────────────
    if (path === '/read') {
      const res = await ghRead(env, 'planning.json');
      if (!res.ok) return json({ error: 'GitHub read failed' }, 500, allowed);
      const data = await res.json();
      return json({ content: JSON.parse(atob(data.content.replace(/\n/g, ''))), sha: data.sha }, 200, allowed);
    }

    // ── /write ────────────────────────────────────────────────────────
    if (path === '/write') {
      if (callerRole === 'viewer') return json({ error: 'Lecture seule' }, 403, allowed);
      const { data, sha } = body;
      if (!data) return json({ error: 'Données manquantes' }, 400, allowed);
      const msg = `Planning mis à jour par ${callerEmail} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const res = await ghWrite(env, 'planning.json', data, sha, msg);
      if (res.status === 409) return json({ error: 'conflict' }, 409, allowed);
      if (!res.ok) return json({ error: 'GitHub write failed' }, 500, allowed);
      const result = await res.json();
      return json({ sha: result.content.sha }, 200, allowed);
    }

    return json({ error: 'Not found' }, 404, allowed);
  },
};

// ── HMAC-SHA256 ───────────────────────────────────────────────────────
async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=/g, '');
}

// ── USERS.JSON ────────────────────────────────────────────────────────
async function readUsersJson(env) {
  try {
    const res = await ghRead(env, 'users.json');
    if (!res.ok) return null;
    const d = await res.json();
    return JSON.parse(atob(d.content.replace(/\n/g, '')));
  } catch { return null; }
}

function getRoleFromUsers(users, email) {
  const e = email.toLowerCase();
  if ((users.admins  || []).map(x => x.toLowerCase()).includes(e)) return 'admin';
  if ((users.editors || []).map(x => x.toLowerCase()).includes(e)) return 'editor';
  if ((users.viewers || []).map(x => x.toLowerCase()).includes(e)) return 'viewer';
  return null;
}

// ── MICROSOFT GRAPH EMAIL ─────────────────────────────────────────────
async function getGraphToken(env) {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  if (!res.ok) return null;
  return (await res.json()).access_token;
}

async function sendMagicEmail(env, toEmail, magicUrl) {
  const token = await getGraphToken(env);
  if (!token) return false;
  const firstName = toEmail.split('@')[0].split('.')[0];
  const capFirst  = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  const from      = env.MAIL_FROM || 'planning@cyrias.com';
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: '🔗 Votre lien de connexion — Planning Cyrias',
          body: { contentType: 'HTML', content: emailHtml(capFirst, magicUrl) },
          toRecipients: [{ emailAddress: { address: toEmail } }],
          from: { emailAddress: { address: from } },
        },
        saveToSentItems: false,
      }),
    }
  );
  return res.status === 202;
}

function emailHtml(firstName, url) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f6f7fa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fa;padding:40px 20px;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
<tr><td style="background:#1B3F73;padding:24px 32px;border-bottom:3px solid #95C11F;">
  <img src="https://www.cyrias.com/wp-content/uploads/2023/01/logo-cyrias-blanc.svg" alt="Cyrias" height="28" style="display:block;">
</td></tr>
<tr><td style="padding:32px;">
  <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0F2C54;">Bonjour ${firstName},</p>
  <p style="margin:0 0 24px;font-size:14px;color:#5a6478;line-height:1.6;">
    Voici votre lien de connexion au <strong>Planning de présence Cyrias</strong>.<br>
    Il est valable <strong>15 minutes</strong> et à usage unique.
  </p>
  <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
  <tr><td style="background:#95C11F;border-radius:8px;">
    <a href="${url}" style="display:block;padding:14px 32px;font-size:15px;font-weight:700;color:#0F2C54;text-decoration:none;">→ Accéder au planning</a>
  </td></tr></table>
  <p style="margin:0 0 24px;font-size:11px;color:#9098a8;word-break:break-all;background:#f6f7fa;padding:10px;border-radius:6px;">${url}</p>
  <p style="margin:0;font-size:12px;color:#9098a8;line-height:1.5;border-top:1px solid #e2e6ee;padding-top:16px;">
    Si vous n'avez pas demandé ce lien, ignorez cet email.
  </p>
</td></tr>
<tr><td style="background:#f6f7fa;padding:16px 32px;text-align:center;font-size:11px;color:#9098a8;">
  Cyrias Value Across Technology &nbsp;·&nbsp; <a href="https://www.cyrias.com" style="color:#1B3F73;">cyrias.com</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

// ── GITHUB ────────────────────────────────────────────────────────────
const ghH = env => ({
  Authorization: `Bearer ${env.GH_PAT}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});
function ghRead(env, file) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${file}?ref=main`, { headers: ghH(env) });
}
function ghWrite(env, file, data, sha, message) {
  const body = { message, content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))), branch: 'main' };
  if (sha) body.sha = sha;
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${file}`,
    { method: 'PUT', headers: { ...ghH(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── CORS / JSON ───────────────────────────────────────────────────────
const cors = o => ({
  'Access-Control-Allow-Origin': o,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});
const json = (d, s, o) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json', ...cors(o) }
});
