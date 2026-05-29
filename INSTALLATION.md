# CYRIAS Planning — base de données GitHub + portail partagé

Le planning peut maintenant utiliser un dépôt GitHub comme **base de données** (fichiers JSON, sans SQL), avec un **portail partagé** et des **droits par rôle**.

## Les deux "tables" (fichiers JSON dans le dépôt)

| Fichier | Rôle | Lecture | Écriture |
|---|---|---|---|
| `users.json` | Accès / rôles | directe (dépôt public) | manuelle (commit) |
| `data.json` | Planning complet | directe (dépôt public) | via le Worker |

`users.json` (déjà géré) — chaque email autorisé, son rôle, et la personne liée (`personId`) :
```json
{ "users": [
  { "email": "admin@cyrias.com", "role": "admin",  "nom": "Admin",       "personId": null },
  { "email": "j.dupont@cyrias.com", "role": "editor", "nom": "Jean Dupont", "personId": "p1" },
  { "email": "audit@cyrias.com",  "role": "viewer", "nom": "Audit",        "personId": null }
] }
```

## Console d'administration des accès (admin uniquement)

Dans **⚙ Paramètres → onglet Utilisateurs**, un admin peut, sans toucher au code :

- **Ajouter un compte** : email + rôle + (optionnel) la personne du planning à lier.
- **Changer le rôle** d'un compte via le menu déroulant (admin / éditeur / lecteur).
- **Lier / délier** un compte à une personne via le menu « Personne liée ».
- **Supprimer** un compte.
- **Exporter `users.json`** (bouton dédié) pour le committer dans le dépôt en mode `local`.

Garde-fous intégrés : on ne peut pas rétrograder ni supprimer le **dernier admin**, et les emails en double sont refusés.

### Lier une personne à un compte — comment ça marche

Chaque personne du planning a un identifiant interne (`id`, ex. `p1`). Lier un compte enregistre cet `id` dans `personId`. Un éditeur ne peut alors modifier **que la ligne de cette personne** (les cellules des autres lignes ne sont pas cliquables ; un badge « vous » apparaît sur sa ligne).

Ce lien par `id` est robuste : si la personne est renommée, le compte reste lié. En l'absence de `personId`, l'application retombe sur une correspondance par nom (`nom` du compte = `nom` de la personne).

### Persistance des changements de la console

- **Mode `local`** : les modifications sont enregistrées dans la base locale ; utilisez **Exporter `users.json`** puis committez le fichier dans le dépôt pour les rendre effectives au prochain chargement partagé.
- **Mode `github`** (Worker configuré) : la console écrit directement `users.json` dans le dépôt (commit automatique). Les changements sont actifs pour tous au rechargement / au rafraîchissement 60 s.

## Les 3 rôles

- **admin** — tout : planning, personnes, lieux, utilisateurs, export.
- **editor** — modifie **uniquement sa propre ligne** (le `nom` de `users.json` doit correspondre exactement au nom de la personne dans le planning). Un badge « vous » s'affiche sur sa ligne.
- **viewer** — lecture seule.

La restriction « saisie limitée à sa ligne » est appliquée côté interface (les cellules des autres lignes ne sont pas cliquables pour un editor).

## Pourquoi un Worker pour l'écriture ?

Écrire sur GitHub nécessite un **token**. Sur un portail **partagé**, ce token ne doit JAMAIS être dans la page (tout le monde le verrait). Le mini Worker Cloudflare garde le token côté serveur ; la page lui envoie seulement les données à enregistrer.

Sans Worker (`workerUrl` vide) → le portail fonctionne en **lecture seule partagée**.

## Mise en place (≈ 10 min)

1. **Dépôt GitHub** (public) avec, à la racine : `index.html` (ce fichier), `users.json`. `data.json` sera créé au premier enregistrement (ou déposez-le via le bouton **Export JSON**).
2. **GitHub Pages** : Settings → Pages → branche `main` / `/root`.
3. **Worker Cloudflare** (gratuit) : créez un Worker, collez `worker.js`, puis dans *Settings → Variables* :
   - `GITHUB_TOKEN` *(secret)* — token fine-grained, permission **Contents: Read & Write** sur ce dépôt uniquement.
   - `OWNER`, `REPO`, `BRANCH` (`main`), `DATA_PATH` (`data.json`), `USERS_PATH` (`users.json`).
   - `ALLOW_ORIGIN` — l'URL Pages, ex. `https://fabienkarulak-source.github.io`.
   - `PORTAL_KEY` *(optionnel)* — petit secret anti-bots.
4. **Dans `index.html`**, bloc `AUTH_CONFIG` :
   ```js
   mode: 'github',
   github: {
     owner: 'fabienkarulak-source', repo: 'cyrias-planning', branch: 'main',
     dataPath: 'data.json', usersPath: 'users.json',
     workerUrl: 'https://VOTRE-worker.workers.dev',
   }
   ```

## Comment ça marche au quotidien

- Chaque utilisateur ouvre l'URL Pages, saisit son email (vérifié dans `users.json`).
- Lecture du planning : directe depuis GitHub. Rafraîchissement automatique toutes les 60 s → tout le monde voit les mises à jour.
- Enregistrement (admin/editor) : envoyé au Worker, qui *commit* `data.json`. Une copie locale de secours est gardée dans le navigateur.

## Limites à connaître

- **Concurrence** : enregistrement « dernier qui écrit gagne » sur le fichier entier. Adapté à une petite équipe ; si deux personnes enregistrent dans la même seconde, la dernière prime.
- **Sécurité des rôles** : appliquée côté interface. Pour une garantie stricte côté serveur, il faudrait authentifier chaque requête dans le Worker (non inclus ici).
- Le mode `local` (défaut) reste disponible pour tester sans aucune infrastructure.
