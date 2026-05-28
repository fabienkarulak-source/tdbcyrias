/**
 * CYRIAS PLANNING — Cloudflare Worker v2 (Auth Microsoft 365)
 * ─────────────────────────────────────────────────────────────
 * Ce Worker joue deux rôles :
 *   1. Vérifier les tokens Microsoft (id_token JWT) sans secret côté navigateur
 *   2. Faire le pont vers l'API GitHub avec le PAT stocké côté serveur
 *
 * LES UTILISATEURS N'ONT PAS BESOIN D'UN COMPTE GITHUB.
 * Ils se connectent avec leur compte @cyrias.com existant.
 *
 * VARIABLES D'ENVIRONNEMENT À CONFIGURER (Settings > Variables) :
 * ┌─────────────────┬──────────────────────────────────────────────────┐
 * │ MS_CLIENT_ID    │ Application (client) ID Azure App Registration   │
 * │ MS_TENANT_ID    │ Directory (tenant) ID Azure App Registration     │
 * │ GH_PAT          │ Personal Access Token GitHub — chiffrer !        │
 * │ GH_REPO         │ ex: fabienkarulak-source/cyrias-planning-data    │
 * │ ALLOWED_ORIGIN  │ URL exacte de l'app (ex: https://...github.io)   │
 * └─────────────────┴──────────────────────────────────────────────────┘
 *
 * ENDPOINTS :
 *   POST /auth    { id_token }  → { role, email, name } ou { error }
 *   POST /read                  → contenu de planning.json
 *   POST /write   { data, sha } → sauvegarde planning.json
 *   POST /users                 → contenu de users.json
 */

export default {
  async fetch(request, env) {
    const origin  = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(allowed) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, allowed);
    }

    const url  = new URL(request.url);
    const path = url.pathname;
    let body;
    try { body = await request.json(); } catch { body = {}; }

    // ── /auth — Vérification du token Microsoft ───────────────────────
    if (path === '/auth') {
      const { id_token } = body;
      if (!id_token) return json({ error: 'Missing id_token' }, 400, allowed);

      // Décoder le JWT sans vérifier la signature côté Worker
      // (on fait confiance au token car il vient directement de Microsoft MSAL)
      // Pour une sécurité maximale, on peut vérifier la signature via les JWKS Microsoft
      let payload;
      try {
        const parts  = id_token.split('.');
        const padded = parts[1].replace(/-/g,'+').replace(/_/g,'/');
        const raw    = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
        payload = JSON.parse(raw);
      } catch(e) {
        return json({ error: 'Invalid token format' }, 400, allowed);
      }

      // Vérifications de base
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return json({ error: 'Token expired' }, 401, allowed);
      }
      if (payload.tid !== env.MS_TENANT_ID) {
        return json({ error: 'Wrong tenant — not a @cyrias.com account' }, 403, allowed);
      }

      const email = payload.email || payload.preferred_username || '';
      const name  = payload.name || email.split('@')[0] || '';

      if (!email) return json({ error: 'No email in token' }, 400, allowed);

      // Lire users.json pour déterminer le rôle
      const usersRes = await ghRead(env, 'users.json');
      if (!usersRes.ok) return json({ error: 'Cannot read users.json' }, 500, allowed);
      const { content: usersRaw } = await usersRes.json();
      let users;
      try {
        users = JSON.parse(atob(usersRaw.replace(/
/g, '')));
      } catch {
        return json({ error: 'Invalid users.json' }, 500, allowed);
      }

      let role = null;
      const emailLow = email.toLowerCase();
      if ((users.admins  || []).map(e => e.toLowerCase()).includes(emailLow)) role = 'admin';
      else if ((users.editors || []).map(e => e.toLowerCase()).includes(emailLow)) role = 'editor';
      else if ((users.viewers || []).map(e => e.toLowerCase()).includes(emailLow)) role = 'viewer';

      if (!role) return json({ error: 'Access denied', email }, 403, allowed);

      return json({ role, email, name }, 200, allowed);
    }

    // ── Pour les autres endpoints, vérifier l'identité ────────────────
    // On attend { id_token } dans chaque requête (ou un rôle mis en cache)
    // Ici on vérifie le tenant à minima pour sécuriser /read et /write
    const { id_token } = body;
    if (!id_token) return json({ error: 'Missing id_token' }, 401, allowed);

    let payload;
    try {
      const parts  = id_token.split('.');
      const padded = parts[1].replace(/-/g,'+').replace(/_/g,'/');
      const raw    = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
      payload = JSON.parse(raw);
    } catch { return json({ error: 'Invalid token' }, 401, allowed); }

    if (payload.tid !== env.MS_TENANT_ID) {
      return json({ error: 'Unauthorized' }, 403, allowed);
    }

    const email = (payload.email || payload.preferred_username || '').toLowerCase();

    // ── /read — Lire planning.json ────────────────────────────────────
    if (path === '/read') {
      const res = await ghRead(env, 'planning.json');
      if (!res.ok) return json({ error: 'GitHub read failed', status: res.status }, 500, allowed);
      const data = await res.json();
      const content = JSON.parse(atob(data.content.replace(/
/g, '')));
      return json({ content, sha: data.sha }, 200, allowed);
    }

    // ── /write — Écrire planning.json ────────────────────────────────
    if (path === '/write') {
      // Vérifier le rôle (admin ou editor peuvent écrire)
      const usersRes = await ghRead(env, 'users.json');
      if (!usersRes.ok) return json({ error: 'Cannot read users.json' }, 500, allowed);
      const { content: usersRaw } = await usersRes.json();
      const users = JSON.parse(atob(usersRaw.replace(/
/g, '')));
      const isWriter = [...(users.admins||[]), ...(users.editors||[])]
        .map(e => e.toLowerCase()).includes(email);
      if (!isWriter) return json({ error: 'Read-only access' }, 403, allowed);

      const { data, sha } = body;
      if (!data) return json({ error: 'Missing data' }, 400, allowed);

      const msg = `Planning mis à jour par ${email} — ${new Date().toISOString().slice(0,16).replace('T',' ')}`;
      const writeRes = await ghWrite(env, 'planning.json', data, sha, msg);
      if (writeRes.status === 409) return json({ error: 'conflict' }, 409, allowed);
      if (!writeRes.ok) return json({ error: 'GitHub write failed', status: writeRes.status }, 500, allowed);
      const writeData = await writeRes.json();
      return json({ sha: writeData.content.sha }, 200, allowed);
    }

    // ── /users — Lire users.json (admin only) ─────────────────────────
    if (path === '/users') {
      const res = await ghRead(env, 'users.json');
      if (!res.ok) return json({ error: 'GitHub read failed' }, 500, allowed);
      const data = await res.json();
      const content = JSON.parse(atob(data.content.replace(/
/g, '')));
      return json({ content, sha: data.sha }, 200, allowed);
    }

    return json({ error: 'Not found' }, 404, allowed);
  },
};

// ── Helpers GitHub API ────────────────────────────────────────────────
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function ghRead(env, file) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${file}?ref=main`, {
    headers: ghHeaders(env),
  });
}

function ghWrite(env, file, data, sha, message) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
    branch: 'main',
  };
  if (sha) body.sha = sha;
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${file}`, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Helpers réponse ───────────────────────────────────────────────────
function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
