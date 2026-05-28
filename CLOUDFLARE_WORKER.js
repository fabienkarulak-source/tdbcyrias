/**
 * CYRIAS PLANNING — Cloudflare Worker (proxy OAuth GitHub)
 * ─────────────────────────────────────────────────────────
 * Ce Worker échange le code OAuth GitHub contre un access_token
 * sans exposer le CLIENT_SECRET côté navigateur.
 *
 * DÉPLOIEMENT (5 min) :
 * 1. Aller sur https://workers.cloudflare.com → créer un Worker
 * 2. Coller ce code
 * 3. Dans "Settings > Variables" ajouter :
 *      GH_CLIENT_ID     → votre OAuth App Client ID
 *      GH_CLIENT_SECRET → votre OAuth App Client Secret  (chiffré !)
 *      ALLOWED_ORIGIN   → URL exacte où est hébergé le planning HTML
 *                         ex: https://fabienkarulak-source.github.io
 * 4. Déployer → copier l'URL du Worker dans GH_CONFIG.WORKER_URL du HTML
 *
 * CRÉER L'OAUTH APP GITHUB :
 * → https://github.com/settings/developers > "New OAuth App"
 *   Homepage URL     : URL de votre page HTML
 *   Callback URL     : même URL (le code revient dans ?code=…)
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';

    // Répondre aux preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowed),
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let code;
    try {
      const body = await request.json();
      code = body.code;
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, allowed);
    }

    if (!code) {
      return jsonResponse({ error: 'Missing code' }, 400, allowed);
    }

    // Échange code → access_token auprès de GitHub
    const ghRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id:     env.GH_CLIENT_ID,
        client_secret: env.GH_CLIENT_SECRET,
        code,
      }),
    });

    if (!ghRes.ok) {
      return jsonResponse({ error: 'GitHub unreachable' }, 502, allowed);
    }

    const data = await ghRes.json();

    // GitHub renvoie error dans un 200 — on le propage proprement
    if (data.error) {
      return jsonResponse({ error: data.error, description: data.error_description }, 400, allowed);
    }

    return jsonResponse({ access_token: data.access_token }, 200, allowed);
  },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}
