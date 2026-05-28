# cyrias-planning-data

Base de données partagée du **Planning de présence Cyrias**.  
Repo privé — accès contrôlé par `users.json`.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `planning.json` | Données de l'application (lieux, personnes, planning) |
| `users.json` | Permissions par login GitHub |
| `CLOUDFLARE_WORKER.js` | Proxy OAuth à déployer sur Cloudflare Workers |

---

## Gestion des accès — `users.json`

```json
{
  "admins":  ["github-login-admin"],
  "editors": ["github-login-user1", "github-login-user2"],
  "viewers": ["github-login-lecteur"]
}
```

| Rôle | Droits |
|---|---|
| `admins` | Tout : planning + paramètres, lieux, personnes |
| `editors` | Remplir les cases du planning uniquement |
| `viewers` | Lecture seule, aucune modification |

> Pour ajouter quelqu'un : éditer `users.json` ici sur GitHub,  
> ajouter son login GitHub dans la liste correspondante, commiter.  
> La modification est prise en compte immédiatement à la prochaine connexion.

---

## Mise en production — 3 étapes

### 1. Cloudflare Worker (proxy OAuth)

1. Aller sur [workers.cloudflare.com](https://workers.cloudflare.com)
2. Créer un nouveau Worker, coller le contenu de `CLOUDFLARE_WORKER.js`
3. Dans **Settings › Variables**, ajouter (en chiffré pour le secret) :

| Variable | Valeur |
|---|---|
| `GH_CLIENT_ID` | Client ID de l'OAuth App |
| `GH_CLIENT_SECRET` | Client Secret de l'OAuth App (**chiffré**) |
| `ALLOWED_ORIGIN` | URL exacte du planning HTML hébergé |

4. Déployer — noter l'URL du Worker (ex: `https://cyrias-oauth.workers.dev`)

### 2. GitHub OAuth App

1. Aller sur [github.com/settings/developers](https://github.com/settings/developers)
2. Cliquer **New OAuth App** et remplir :
   - **Application name** : `Planning Cyrias`
   - **Homepage URL** : URL où est hébergé le planning HTML
   - **Authorization callback URL** : même URL
3. Générer un **Client Secret**
4. Noter le **Client ID** et le **Client Secret**

### 3. Configurer le fichier HTML

Dans `testplanningcyrias.html`, mettre à jour le bloc `GH_CONFIG` :

```js
const GH_CONFIG = {
  CLIENT_ID:  'Ov23liXXXXXXXXXXXXXX',          // GitHub OAuth App Client ID
  WORKER_URL: 'https://cyrias-oauth.workers.dev', // URL du Cloudflare Worker
  REPO:       'fabienkarulak-source/cyrias-planning-data',
  BRANCH:     'main',
  FILE_DATA:  'planning.json',
  FILE_USERS: 'users.json',
};
```

### 4. Héberger le HTML

Option la plus simple : **GitHub Pages**
1. Créer un repo public `fabienkarulak-source/cyrias-planning` 
2. Y mettre `testplanningcyrias.html` renommé en `index.html`
3. Activer GitHub Pages dans Settings › Pages (branch: main)
4. URL : `https://fabienkarulak-source.github.io/cyrias-planning`

---

## Flux d'authentification

```
Navigateur
  │
  ├─► github.com/login/oauth/authorize?client_id=…
  │         (GitHub demande confirmation à l'utilisateur)
  │
  ◄─── ?code=xxxxx  (redirect callback vers le planning)
  │
  ├─► Cloudflare Worker  POST { code }
  │         (échange code → access_token, CLIENT_SECRET jamais exposé)
  │
  ◄─── { access_token: "ghp_…" }
  │
  ├─► api.github.com/user  (récupère le login GitHub)
  ├─► api.github.com/repos/…/contents/users.json  (vérifie le rôle)
  └─► api.github.com/repos/…/contents/planning.json  (charge les données)
```

---

## Sécurité

- Le repo de données est **privé** : seuls les comptes avec un token valide peuvent y accéder
- Le `CLIENT_SECRET` n'est jamais dans le HTML, uniquement dans les variables chiffrées du Worker
- Les rôles sont vérifiés à chaque connexion depuis `users.json` dans ce repo
- Chaque commit de `planning.json` porte le login GitHub de l'auteur → historique complet
