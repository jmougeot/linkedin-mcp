# Déploiement sur le VPS partagé (Claude Code + Cowork)

Même schéma que `azerit-app` : un conteneur Docker sur le réseau `ruby_default`,
routé en HTTPS par le **ruby-caddy** existant via son nom de conteneur. Le
serveur devient un **connecteur MCP distant** pour Claude Code comme pour
Cowork ; l'**extension Chrome locale** (sur votre poste) fait le vrai travail
dans votre session LinkedIn.

```
Claude Code / Cowork ──HTTPS──▶ ruby-caddy ──▶ linkedin-mcp:3210  /mcp/<TOKEN>
Votre Chrome+extension ──HTTPS──▶ ruby-caddy ──▶ linkedin-mcp:3210  /api/li/* (Bearer)
                                                     └──▶ agit sur LinkedIn (VOTRE session)
```

## 1. DNS

Faites pointer **`linkedin.azerit.tech`** vers le VPS (enregistrement A, comme
`app.azerit.tech`).

## 2. Copier le projet sur le VPS

Le projet vit dans **`/opt/linkedin-mcp`** sur le VPS (`ssh ruby`). Ce n'est
pas un dépôt git : on y copie les fichiers avec `rsync` (sans `node_modules/`
ni `data/` — le build Docker s'en occupe) :

```sh
rsync -av --exclude node_modules --exclude data --exclude .env --exclude .git \
  --exclude .claude ~/Desktop/Azerit/Linkedin_mcp/ ruby:/opt/linkedin-mcp/
```

## 3. `.env`

```sh
cd /opt/linkedin-mcp
cp .env.example .env
# génère un jeton et colle-le dans LI_TOKEN :
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

`.env` doit au minimum contenir `LI_TOKEN=<votre jeton>`. (`LI_TRANSPORT`,
`LI_MCP_PORT`, `LI_BIND` sont déjà fixés par le compose.) Les quotas et délais
sont optionnels : `.env.example` les liste tous, commentés, avec leur valeur
par défaut. Un changement du `.env` demande de recréer le conteneur (§ 8).

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

## 6. Ajouter le connecteur dans Claude Code / Cowork

**Cowork** — **claude.ai → Customize → Connectors → Add custom connector** :

- **URL** : `https://linkedin.azerit.tech/mcp/<LI_TOKEN>`
- Auth : laissez **vide** (le jeton est dans l'URL, protégé par HTTPS).

Activez le connecteur dans Cowork → les outils `linkedin_send_message`,
`linkedin_read_messages`, etc. apparaissent.

**Claude Code** — même URL, en transport HTTP :

```sh
claude mcp add --scope user --transport http linkedin https://linkedin.azerit.tech/mcp/<LI_TOKEN>
```

Dans le dossier `Linkedin_mcp`, ajoutez-la aussi en scope local (même commande
sans `--scope user`) : sinon le serveur stdio de `.mcp.json` prend le pas. Voir
le [README](README.md#installation).

## 7. Configurer l'extension (sur VOTRE poste)

L'extension reste locale (c'est elle qui a votre session LinkedIn). Dans son
popup :

- **Adresse du serveur** : `https://linkedin.azerit.tech`
- **Jeton d'accès** : `<LI_TOKEN>`

Après ~30 s le popup affiche les quotas, et `linkedin_status` (côté Claude Code
ou Cowork) indique `extension.connected: true`.

## 8. Mises à jour

**`server.js`** (ou `Dockerfile`, `package.json`, `.env`) : recopiez (§ 2) puis
reconstruisez.

```sh
rsync -av --exclude node_modules --exclude data --exclude .env --exclude .git \
  --exclude .claude ~/Desktop/Azerit/Linkedin_mcp/ ruby:/opt/linkedin-mcp/
ssh ruby 'cd /opt/linkedin-mcp && docker compose -f docker-compose.server.yml up -d --build'
```

Le redémarrage vide ce qui vit en mémoire : file d'attente, plafonds horaires,
historique des résultats (les compteurs du jour, eux, sont sur le volume).
Évitez donc de redéployer avec des actions en file. Les clients MCP se
reconnectent seuls (le serveur répond 404 sur une session inconnue, ce qui
déclenche une nouvelle initialisation).

**`extension/`** : rien à déployer — elle tourne sur votre poste. Rechargez-la
dans `chrome://extensions` (↻), sinon Chrome continue de servir l'ancienne
version en cache.

## Sécurité

- Le **jeton** est le seul rempart d'accès à votre LinkedIn : gardez-le secret,
  `.env` est git-ignoré.
- Le conteneur n'expose rien publiquement ; seul ruby-caddy (443) le route.
- Chrome + extension doivent rester ouverts sur votre poste pour que ça agisse ;
  un seul poste extension par serveur (sinon deux navigateurs se partagent la
  file).
