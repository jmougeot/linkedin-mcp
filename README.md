# LinkedIn MCP — Claude envoie sur LinkedIn

Adapté de l'extension *Sequence Mail* (`Ruby/prospection`). Permet à **Claude**
(Claude Code) d'envoyer des **messages** et des **invitations** LinkedIn, dans
**votre propre session LinkedIn**, via une extension Chrome.

```
Claude ──(outils MCP)──▶ server.js ──(file + quotas + délais)──▶ extension Chrome ──▶ LinkedIn
```

- `server.js` : serveur MCP + serveur HTTP qui joue le rôle qu'avait l'app
  Sequence Mail : file d'attente, quotas journaliers, délai aléatoire entre
  actions, pause de sécurité.
- `extension/` : l'extension Chrome adaptée — elle interroge le serveur
  (long-poll, envoi quasi immédiat) et joue le geste en pilotant la vraie
  interface LinkedIn (clic, saisie, envoi, lecture du DOM). Le `content.js` est
  très proche de l'original.

## Deux modes

| | **Local (Claude Code)** | **VM (Claude Cowork)** |
|---|---|---|
| Transport MCP | stdio (lancé par Claude Code) | Streamable HTTP (connecteur distant) |
| `LI_TRANSPORT` | `stdio` (défaut) | `http` |
| Serveur | `127.0.0.1:3210`, sans jeton | VM publique HTTPS + `LI_TOKEN` |
| Extension pointe sur | `http://127.0.0.1:3210` | `https://votre-domaine` + jeton |
| Mise en place | rien (voir ci-dessous) | **[DEPLOY.md](DEPLOY.md)** |

Le reste de ce README décrit le mode **local**. Pour Cowork, suivez
**[DEPLOY.md](DEPLOY.md)** (résumé dans [COWORK.md](COWORK.md)).

## Le principe anti-ban (inchangé)

**L'extension n'envoie jamais quand elle veut.** Le serveur applique :

- **plafonds journaliers** : 20 invitations, 40 messages par défaut ;
- **délai aléatoire** entre deux actions (45–120 s) ;
- **pause de sécurité** : 10 min après un échec, 60 min si LinkedIn affiche un
  contrôle de sécurité / captcha ;
- le geste est joué dans la vraie interface, pas via l'API interne.

Réglages via variables d'environnement (dans `.mcp.json`, champ `env`) :
`LI_MCP_PORT`, `LI_CAP_INVITE`, `LI_CAP_MESSAGE`, `LI_MIN_GAP_S`, `LI_MAX_GAP_S`,
`LI_READ_MIN_GAP_S`, `LI_READ_MAX_GAP_S`, `LI_FAIL_PAUSE_MIN`,
`LI_CHECKPOINT_PAUSE_MIN`, `LI_TOOL_WAIT_S`, `LI_BATCH_WAIT_S`,
`LI_MAX_PROFILES_PER_CALL`.
**Les baisser est sûr ; les gonfler augmente le risque de restriction du compte.**

### Rythme anti-détection

Ce qui fait repérer un compte, ce n'est pas tant le volume que la **régularité** :
une boucle qui enchaîne des actions à intervalle constant, sans pause, à toute
heure, est le motif le plus facile à détecter. Le serveur impose donc trois
garde-fous en plus des délais entre actions :

| Garde-fou | Variables | Défaut |
| --- | --- | --- |
| Plafonds journaliers (lectures incluses) | `LI_CAP_VIEW`, `LI_CAP_READ` | 80 profils, 150 lectures |
| Plafonds horaires (fenêtre glissante 60 min) | `LI_CAP_HOUR`, `LI_CAP_HOUR_VIEW` | 40 actions, 15 profils |
| Micro-pauses entre séries | `LI_BURST_MIN`/`MAX`, `LI_BREAK_MIN_S`/`MAX_S` | pause 1 min 30–4 min toutes les 8–16 actions |
| Plage horaire d'activité | `LI_ACTIVE_START`, `LI_ACTIVE_END`, `LI_TZ`, `LI_SKIP_WEEKEND` | 8h–20h, Europe/Paris |

Les délais entre deux actions dépendent de la classe : envoi
`LI_MIN_GAP_S`–`LI_MAX_GAP_S` (45–120 s), visite de profil
`LI_VIEW_MIN_GAP_S`–`LI_VIEW_MAX_GAP_S` (20–60 s), lecture légère
`LI_READ_MIN_GAP_S`–`LI_READ_MAX_GAP_S` (4–12 s).

La **plage horaire ne s'applique qu'aux envois et aux visites de profil** :
consulter sa messagerie le soir n'a rien d'anormal, enchaîner des visites de
profil à 3 h du matin si. Mettre `LI_ACTIVE_START` et `LI_ACTIVE_END` à la même
valeur désactive la plage.

Conséquence pratique : les lots de profils s'étalent sur plusieurs minutes.
`linkedin_view_profile` rend alors des `pending: [{ url, id }]` — rappelez-le
avec `collect_ids: [...]` pour récupérer le résultat **sans rouvrir les pages**.
Ne relancez jamais les mêmes URL pour « réessayer » : cela double l'exposition.

`linkedin_status` affiche les compteurs du jour, ceux de la dernière heure, la
micro-pause en cours et l'état de la plage horaire. Les plafonds horaires vivent
en mémoire : un redémarrage du serveur les remet à zéro (les plafonds
journaliers, eux, sont persistés dans `data/state.json`).

## Installation

1. **Dépendances** (déjà fait si `node_modules/` existe) :
   ```sh
   cd ~/Desktop/Azerit/Linkedin_mcp && npm install
   ```
2. **Extension Chrome** :
   - Connectez-vous à LinkedIn dans Chrome (session normale).
   - `chrome://extensions` → **Mode développeur** → **Charger l'extension non
     empaquetée** → choisissez le dossier `Linkedin_mcp/extension`.
   - Épinglez l'icône. Le popup montre l'état, les quotas du jour et un bouton
     pause/activation. Adresse du serveur par défaut : `http://127.0.0.1:3210`.
3. **Serveur MCP** : déjà déclaré dans `.mcp.json` à la racine du projet.
   Ouvrez une session Claude Code **dans ce dossier** et approuvez le serveur
   `linkedin` quand Claude Code le propose (ou vérifiez avec `/mcp`).

> Le serveur MCP ne tourne que pendant une session Claude ouverte dans ce
> projet. Extension « serveur injoignable » = pas de session Claude en cours.

## Usage depuis Claude

Demandez simplement, par exemple :

> Envoie un message LinkedIn à https://www.linkedin.com/in/jean-dupont/ pour lui
> proposer un échange sur X.

Outils disponibles :

| Outil | Rôle |
|---|---|
| `linkedin_send_message` | Envoyer un message (relations de 1er niveau uniquement) |
| `linkedin_send_invitation` | Envoyer une invitation, note optionnelle (≤ 200 car.) |
| `linkedin_read_messages` | Lire l'historique d'une conversation avec un profil (`/in/...`) |
| `linkedin_list_conversations` | Lister les conversations récentes de la messagerie |
| `linkedin_view_profile` | Voir un ou plusieurs profils (`/in/...`) : nom, titre, à propos, expériences… |
| `linkedin_status` | Extension connectée ? quotas, file, pause, derniers résultats |
| `linkedin_cancel` | Vider la file d'attente |

**Lecture** : `linkedin_read_messages` ouvre le profil et extrait le fil de
discussion (retourne `{ messages: [{ sender, time, text }] }`, du plus ancien au
plus récent). `linkedin_list_conversations` va sur la page messagerie et liste
les conversations (`{ conversations: [{ name, snippet, time, unread }] }`) ;
enchaînez avec `linkedin_read_messages` pour le détail.
`linkedin_view_profile` ouvre la page du profil et extrait les informations
visibles (`{ profile: { name, headline, location, degree, connections,
followers, about, experience, education } }` — les champs vides sont omis
(économie de tokens) ; sur un profil hors réseau l'extraction peut être
partielle). Il accepte une **liste** d'URL (`profile_urls`, 20 max par défaut,
`LI_MAX_PROFILES_PER_CALL`) — un seul appel suffit pour tout un lot : les
profils sont mis en file et lus l'un après l'autre, puis rendus ensemble sous la
forme `{ profiles: [{ url, profile }], errors: [{ url, error }], pending: [{ url,
id }] }`. Une URL invalide ou un profil en 404 n'interrompt pas le lot (il
atterrit dans `errors`) ; si le lot dépasse l'attente maximale
(`LI_BATCH_WAIT_S`, 600 s), les profils non encore lus restent en file et
figurent dans `pending` — `linkedin_status` suit leur avancement.
Les lectures ne consomment **pas** de quota journalier et n'ont
qu'un petit délai (2–6 s) entre elles, mais restent séquentielles et
déclenchent la pause de sécurité si LinkedIn affiche un captcha.

**URL inexistante (404)** : si la page cible n'existe pas (profil supprimé ou
renommé, faute de frappe dans le slug), l'outil échoue immédiatement avec
« page LinkedIn introuvable (404) » — sans attendre les timeouts et **sans**
déclencher de pause de sécurité (ce n'est pas un signal de détection).

L'outil attend le verdict jusqu'à ~90 s ; au-delà (délai anti-détection en
cours, extension déconnectée…), il répond « en file » et `linkedin_status`
permet de suivre le résultat.

## Limites à connaître

- **Messages** : LinkedIn ne les délivre qu'aux **relations de 1er niveau**.
  Pour un inconnu, il faut d'abord une invitation acceptée.
- **Invitations** : plafonnées par LinkedIn lui-même (~100–200/semaine).
- Laissez un **onglet Chrome ouvert** (l'extension en crée un sur LinkedIn en
  arrière-plan si besoin).
- **Maintenance** : LinkedIn change ses libellés/structure. Si un envoi échoue
  avec « bouton introuvable », ajustez les sélecteurs dans
  `extension/content.js` (section « ZONE À MAINTENIR »).
- Un seul serveur à la fois sur le port 3210 : si deux sessions Claude sont
  ouvertes sur ce projet, la seconde signalera le port occupé.
