/**
 * CYRIAS Planning — proxy GitHub (Cloudflare Worker)
 * ---------------------------------------------------
 * Rôle : faire office d'écriture sécurisée vers la "base de données" GitHub.
 *        Le TOKEN GitHub reste ici (secret du Worker) et n'apparaît JAMAIS
 *        dans la page partagée.
 *
 * Endpoints :
 *   GET  /data   -> { data: <objet planning>, sha }
 *   POST /data   -> body { data, sha?, email?, role? } ; commit data.json ; renvoie { sha }
 *   GET  /users  -> { data: <objet users>, sha }
 *   POST /users  -> body { data:{users:[...]}, email?, role? } ; commit users.json
 *
 * Variables d'environnement (Settings > Variables du Worker) :
 *   GITHUB_TOKEN  (secret)  Personal Access Token "fine-grained" avec
 *                           Contents: Read & Write sur le dépôt.
 *   OWNER         ex: fabienkarulak-source
 *   REPO          ex: cyrias-planning
 *   BRANCH        ex: main
 *   DATA_PATH     ex: data.json
 *   USERS_PATH    ex: users.json
 *   ALLOW_ORIGIN  ex: https://fabienkarulak-source.github.io   (ou * en test)
 *   PORTAL_KEY    (optionnel) secret partagé attendu dans l'en-tête X-Portal-Key
 */

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin':  origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Portal-Key',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    // Route -> fichier GitHub correspondant
    let path = null;
    if (url.pathname.endsWith('/data'))  path = env.DATA_PATH  || 'data.json';
    if (url.pathname.endsWith('/users')) path = env.USERS_PATH || 'users.json';
    if (!path) return json({ error: 'not found' }, 404);

    const owner  = env.OWNER, repo = env.REPO;
    const branch = env.BRANCH || 'main';
    const api    = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github+json',
      'User-Agent':    'cyrias-planning-worker',
    };

    // ── Lecture ──────────────────────────────────────────────
    if (request.method === 'GET') {
      const r = await fetch(`${api}?ref=${branch}&t=${Date.now()}`, { headers: ghHeaders });
      if (r.status === 404) return json({ data: null, sha: null });
      if (!r.ok) return json({ error: 'github ' + r.status }, 502);
      const f = await r.json();
      let data = null;
      try { data = JSON.parse(b64ToUtf8(f.content || '')); } catch (e) {}
      return json({ data, sha: f.sha || null });
    }

    // ── Écriture ─────────────────────────────────────────────
    if (request.method === 'POST') {
      // Garde-fou optionnel (anti-bots) : clé partagée
      if (env.PORTAL_KEY && request.headers.get('X-Portal-Key') !== env.PORTAL_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!body || typeof body.data !== 'object') return json({ error: 'no data' }, 400);

      // Récupère le sha courant (évite les conflits de sha périmé : last-write-wins)
      let sha = body.sha || null;
      try {
        const cur = await fetch(`${api}?ref=${branch}`, { headers: ghHeaders });
        if (cur.ok) { const cj = await cur.json(); sha = cj.sha || sha; }
      } catch (e) {}

      const who = body.email ? ` (${body.email}/${body.role || '?'})` : '';
      const put = await fetch(api, {
        method:  'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `MAJ ${path}${who} — ${new Date().toISOString()}`,
          content: utf8ToB64(JSON.stringify(body.data, null, 2)),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!put.ok) {
        const t = await put.text();
        return json({ error: 'github ' + put.status, detail: t.slice(0, 300) }, 502);
      }
      const pj = await put.json();
      return json({ sha: pj.content && pj.content.sha });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};

// Base64 <-> UTF-8 (compatible accents/emoji)
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob((b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
