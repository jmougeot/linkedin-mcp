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
`LI_FAIL_PAUSE_MIN`, `LI_CHECKPOINT_PAUSE_MIN`, `LI_TOOL_WAIT_S`.
**Les baisser est sûr ; les gonfler augmente le risque de restriction du compte.**

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
| `linkedin_status` | Extension connectée ? quotas, file, pause, derniers résultats |
| `linkedin_cancel` | Vider la file d'attente |

**Lecture** : `linkedin_read_messages` ouvre le profil et extrait le fil de
discussion (retourne `{ messages: [{ sender, time, text }] }`, du plus ancien au
plus récent). `linkedin_list_conversations` va sur la page messagerie et liste
les conversations (`{ conversations: [{ name, snippet, time, unread }] }`) ;
enchaînez avec `linkedin_read_messages` pour le détail. Les lectures ne
consomment **pas** de quota journalier et n'ont qu'un petit délai (5–15 s) entre
elles, mais restent séquentielles et déclenchent la pause de sécurité si
LinkedIn affiche un captcha.

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
