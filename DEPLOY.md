# Déploiement sur le VPS partagé (pour Claude Cowork)

Même schéma que `azerit-app` : un conteneur Docker sur le réseau `ruby_default`,
routé en HTTPS par le **ruby-caddy** existant via son nom de conteneur. Le
serveur devient un **connecteur MCP distant** pour Cowork ; l'**extension Chrome
locale** (sur votre poste) fait le vrai travail dans votre session LinkedIn.

```
Cowork (cloud) ──HTTPS──▶ ruby-caddy ──▶ linkedin-mcp:3210  /mcp/<TOKEN>
Votre Chrome+extension ──HTTPS──▶ ruby-caddy ──▶ linkedin-mcp:3210  /api/li/* (Bearer)
                                                     └──▶ agit sur LinkedIn (VOTRE session)
```

## 1. DNS

Faites pointer **`linkedin.azerit.tech`** vers le VPS (enregistrement A, comme
`app.azerit.tech`).

## 2. Copier le projet sur le VPS

Copiez le dossier `Linkedin_mcp` sur le serveur (sans `node_modules/` ni
`data/` — le build Docker s'en occupe). Par ex. à côté des autres stacks.

## 3. `.env`

```sh
cp .env.example .env
# génère un jeton et colle-le dans LI_TOKEN :
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

`.env` doit au minimum contenir `LI_TOKEN=<votre jeton>`. (`LI_TRANSPORT`,
`LI_MCP_PORT`, `LI_BIND` sont déjà fixés par le compose.)

## 4. Lancer le conteneur

```sh
docker compose -f docker-compose.server.yml up -d --build
docker logs -f linkedin-mcp   # doit afficher "endpoint MCP distant : /mcp/<TOKEN>"
```

Le port 3210 n'est **pas publié** : il n'est joignable que par ruby-caddy via le
réseau `ruby_default`.

## 5. Router via ruby-caddy

Ajoutez le bloc de `caddy-snippet.txt` au Caddyfile de ruby-caddy
(`/opt/ruby/docker/Caddyfile`), puis rechargez :

```sh
docker exec ruby-caddy caddy reload --config /etc/caddy/Caddyfile
```

Vérifiez (401 = le serveur répond et exige le jeton, donc TLS + routage OK) :

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://linkedin.azerit.tech/api/li/next
```

## 6. Ajouter le connecteur dans Claude / Cowork

**claude.ai → Customize → Connectors → Add custom connector** :

- **URL** : `https://linkedin.azerit.tech/mcp/<LI_TOKEN>`
- Auth : laissez **vide** (le jeton est dans l'URL, protégé par HTTPS).

Activez le connecteur dans Cowork → les outils `linkedin_send_message`,
`linkedin_read_messages`, etc. apparaissent.

## 7. Configurer l'extension (sur VOTRE poste)

L'extension reste locale (c'est elle qui a votre session LinkedIn). Dans son
popup :

- **Adresse du serveur** : `https://linkedin.azerit.tech`
- **Jeton d'accès** : `<LI_TOKEN>`

Après ~30 s le popup affiche les quotas, et `linkedin_status` côté Cowork indique
`extension.connected: true`.

## 8. Mises à jour

```sh
git pull   # ou re-copier le dossier
docker compose -f docker-compose.server.yml up -d --build
```

## Sécurité

- Le **jeton** est le seul rempart d'accès à votre LinkedIn : gardez-le secret,
  `.env` est git-ignoré.
- Le conteneur n'expose rien publiquement ; seul ruby-caddy (443) le route.
- Chrome + extension doivent rester ouverts sur votre poste pour que ça agisse ;
  un seul poste extension par serveur (sinon deux navigateurs se partagent la
  file).
