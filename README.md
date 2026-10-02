# LinkedIn MCP — Claude agit sur LinkedIn

Adapté de l'extension *Sequence Mail* (`Ruby/prospection`). Permet à **Claude**
(Claude Code ou Cowork) d'envoyer des **messages** et des **invitations**
LinkedIn, de **lire la messagerie**, de **consulter des profils** et de
**rechercher des personnes**, dans **votre propre session LinkedIn**, via une
extension Chrome.

```
Claude ──(outils MCP)──▶ server.js ──(file + quotas + délais)──▶ extension Chrome ──▶ LinkedIn
```

- `server.js` : serveur MCP + serveur HTTP qui joue le rôle qu'avait l'app
  Sequence Mail : file d'attente, quotas journaliers et horaires, délai
  aléatoire entre actions, micro-pauses, plage horaire, pause de sécurité.
- `extension/` : l'extension Chrome adaptée — elle interroge le serveur
  (long-poll, envoi quasi immédiat) et joue le geste en pilotant la vraie
  interface LinkedIn (clic, saisie, envoi, lecture du DOM).

## Deux modes

| | **Serveur déployé (mode utilisé)** | **Local stdio (dev / test)** |
|---|---|---|
| Clients | Claude Code **et** Cowork | Claude Code ouvert dans ce dossier |
| Transport MCP | Streamable HTTP (connecteur distant) | stdio (lancé par Claude Code via `.mcp.json`) |
| `LI_TRANSPORT` | `http` | `stdio` (défaut) |
| Serveur | `https://linkedin.azerit.tech` (VPS, Docker) + `LI_TOKEN` | `127.0.0.1:3210`, sans jeton |
| Extension pointe sur | `https://linkedin.azerit.tech` + jeton | `http://127.0.0.1:3210` |
| Mise en place | **[DEPLOY.md](DEPLOY.md)** | rien (voir « Mode local » plus bas) |

Le mode utilisé au quotidien est le **serveur déployé** : l'extension Chrome est
réglée sur `https://linkedin.azerit.tech` et ne contacte jamais le serveur
local — une action mise en file par un serveur stdio local ne serait donc jamais
exécutée. Déploiement : **[DEPLOY.md](DEPLOY.md)** (résumé Cowork dans
[COWORK.md](COWORK.md)).

## Le principe anti-ban

**L'extension n'agit jamais quand elle veut.** Le serveur applique :

- **plafonds journaliers** : 20 invitations, 40 messages par défaut (et des
  plafonds pour les lectures, voir plus bas) ;
- **délai aléatoire** entre deux envois (45–120 s) ;
- **pause de sécurité** : 10 min après un envoi en échec, 1 min après une
  lecture en échec, 60 min si LinkedIn affiche un contrôle de sécurité /
  captcha, aucune sur une page 404 ;
- le geste est joué dans la vraie interface, pas via l'API interne ;
- **une seule action à la fois**, toutes classes confondues.

Toutes les valeurs se règlent par variables d'environnement — en mode déployé
dans le `.env` du VPS (modèle commenté : [`.env.example`](.env.example)), en
mode local dans `.mcp.json` (champ `env`).
**Les baisser est sûr ; les gonfler augmente le risque de restriction du compte.**

### Rythme anti-détection

Ce qui fait repérer un compte, ce n'est pas tant le volume que la **régularité** :
une boucle qui enchaîne des actions à intervalle constant, sans pause, à toute
heure, est le motif le plus facile à détecter. Le serveur impose donc, en plus
des délais entre actions :

| Garde-fou | Variables | Défaut |
| --- | --- | --- |
| Plafonds journaliers des envois | `LI_CAP_INVITE`, `LI_CAP_MESSAGE` | 20 invitations, 40 messages |
| Plafonds journaliers des lectures | `LI_CAP_VIEW`, `LI_CAP_SEARCH`, `LI_CAP_READ` | 80 profils, 30 pages de recherche, 150 lectures |
| Plafonds horaires (fenêtre glissante 60 min) | `LI_CAP_HOUR`, `LI_CAP_HOUR_VIEW` | 40 actions, 15 profils |
| Micro-pauses entre séries | `LI_BURST_MIN`/`MAX`, `LI_BREAK_MIN_S`/`MAX_S` | pause 1 min 30–4 min toutes les 8–16 actions |
| Plage horaire d'activité | `LI_ACTIVE_START`, `LI_ACTIVE_END`, `LI_TZ`, `LI_SKIP_WEEKEND` | 8h–20h, Europe/Paris |
| Pauses de sécurité | `LI_FAIL_PAUSE_MIN`, `LI_CHECKPOINT_PAUSE_MIN` | 10 min (envoi en échec), 60 min (captcha) |

Les délais entre deux actions dépendent de la classe :

| Classe | Outils | Délai | Variables |
| --- | --- | --- | --- |
| envoi | `send_message`, `send_invitation` | 45–120 s | `LI_MIN_GAP_S`, `LI_MAX_GAP_S` |
| visite | `view_profile`, `search_people` | 6–10 s | `LI_VIEW_MIN_GAP_S`, `LI_VIEW_MAX_GAP_S` |
| lecture légère | `read_messages`, `list_conversations` | 4–12 s | `LI_READ_MIN_GAP_S`, `LI_READ_MAX_GAP_S` |

**Tout compte dans les plafonds journaliers**, lectures comprises : un envoi
n'est compté que s'il a abouti, une lecture ou une visite l'est dans tous les
cas (la page a été ouverte, LinkedIn l'a vue).

La **plage horaire ne s'applique qu'aux envois, aux visites de profil et aux
recherches** : consulter sa messagerie le soir n'a rien d'anormal, enchaîner
des visites de profil à 3 h du matin si. Mettre `LI_ACTIVE_START` et
`LI_ACTIVE_END` à la même valeur désactive la plage. Une action hors plage reste
en file et part à la réouverture ; une lecture légère passe devant elle.

Conséquence pratique : les lots de profils s'étalent sur plusieurs minutes.
`linkedin_view_profile` rend alors des `pending: [{ url, id }]` — rappelez-le
avec `collect_ids: [...]` pour récupérer le résultat **sans rouvrir les pages**
(idem `linkedin_status` avec `result_id` pour les autres lectures).
Ne relancez jamais les mêmes URL pour « réessayer » : cela double l'exposition.

`linkedin_status` affiche les compteurs du jour, ceux de la dernière heure, la
file, la pause de sécurité ou micro-pause en cours et l'état de la plage
horaire. Les plafonds journaliers sont persistés dans `data/state.json`
(volume Docker en mode déployé) ; **tout le reste vit en mémoire** — file
d'attente, plafonds horaires, 50 derniers résultats — et disparaît au
redémarrage du serveur.

## Installation

1. **Serveur** : déployé sur le VPS — voir **[DEPLOY.md](DEPLOY.md)**.
2. **Extension Chrome** (sur votre poste) :
   - Connectez-vous à LinkedIn dans Chrome (session normale).
   - `chrome://extensions` → **Mode développeur** → **Charger l'extension non
     empaquetée** → choisissez le dossier `Linkedin_mcp/extension`.
   - Épinglez l'icône. Dans le popup : **Adresse du serveur**
     `https://linkedin.azerit.tech`, **Jeton d'accès** `<LI_TOKEN>`. Le popup
     montre ensuite l'état, les quotas du jour et un bouton pause/activation.
3. **Claude Code** : déclarez le connecteur distant.
   ```sh
   # partout (tous les projets) :
   claude mcp add --scope user --transport http linkedin https://linkedin.azerit.tech/mcp/<LI_TOKEN>
   # et, lancé DANS ce dossier, en scope local : sinon le serveur stdio
   # « linkedin » de .mcp.json (scope projet) prend le pas sur le scope user.
   claude mcp add --transport http linkedin https://linkedin.azerit.tech/mcp/<LI_TOKEN>
   ```
   Vérifiez avec `/mcp` : `linkedin` doit pointer sur `https://linkedin.azerit.tech`.
4. **Cowork** : voir [DEPLOY.md](DEPLOY.md) § 6.

> ⚠️ **Après toute modification de `extension/`**, rechargez l'extension
> (`chrome://extensions` → ↻ sur « LinkedIn MCP — Claude »). Chrome sert sinon
> une copie en cache et les exécutions alternent entre ancien et nouveau code.

### Mode local (dev / test)

`.mcp.json` lance `server.js` en stdio. Pour l'utiliser : retirez le connecteur
distant en scope local (`claude mcp remove --scope local linkedin`), ouvrez
Claude Code dans ce dossier, approuvez le serveur `linkedin`, et réglez le
popup de l'extension sur `http://127.0.0.1:3210` sans jeton. Le serveur ne
tourne alors que pendant la session Claude ; si le port 3210 est déjà pris (une
autre session ouverte sur ce projet), il retente toutes les 5 s et le reprend
dès qu'il se libère.

## Usage depuis Claude

Demandez simplement, par exemple :

> Envoie un message LinkedIn à https://www.linkedin.com/in/jean-dupont/ pour lui
> proposer un échange sur X.

Outils disponibles :

| Outil | Rôle |
|---|---|
| `linkedin_send_message` | Envoyer un message (relations de 1er niveau uniquement) |
| `linkedin_send_invitation` | Envoyer une invitation, note optionnelle (≤ 200 car.) |
| `linkedin_read_messages` | Lire une conversation (25 derniers messages par défaut, `limit` ≤ 100) |
| `linkedin_list_conversations` | Lister les conversations récentes de la messagerie (15 par défaut, `limit` ≤ 50) |
| `linkedin_view_profile` | Voir un ou plusieurs profils (`/in/...`) : nom, titre, à propos, expériences… |
| `linkedin_search_people` | Rechercher des personnes (mots-clés, nom, poste, entreprise, école, niveau de relation) |
| `linkedin_status` | Extension connectée ? quotas, file, pauses, derniers résultats — ou résultat d'une lecture en attente (`result_id`) |
| `linkedin_cancel` | Vider la file d'attente (l'action en cours n'est pas interrompue) |

**Cible d'un message ou d'une lecture** (`linkedin_send_message`,
`linkedin_read_messages`) — une seule à la fois :

- `conversation_name` : nom exact vu dans `linkedin_list_conversations` ;
  l'extension ouvre la messagerie, clique la conversation et **vérifie que le
  bon fil est ouvert** avant d'écrire (sinon : échec, rien n'est envoyé) ;
- `thread_url` : fil existant (`/messaging/thread/...`) ;
- `profile_url` : profil (`/in/...`), pour un nouveau contact ;
- `use_open_conversation: true` : la conversation ouverte à l'écran, sans
  aucune navigation.

**Messagerie** : `linkedin_list_conversations` rend
`{ conversations: [{ name, thread_url, profile_url, snippet, time, unread }] }`
(`profile_url` parfois absent de la liste) ; `linkedin_read_messages` rend
`{ messages: [{ sender, time, text }] }`, du plus ancien au plus récent.

**Profils** : `linkedin_view_profile` ouvre chaque profil et extrait
`{ name, headline, location, degree, connections, followers, about, experience,
education }` (champs vides omis pour économiser des tokens ; `about` tronqué à
3 000 caractères). Si ni expérience ni formation n'ont pu être lues, un champ
`debug` est joint (`longueur_texte` ≈ 0 : page pas rendue, fenêtre cachée ?
`sections_detectees` vide : libellés à mettre à jour), et `page_text` si même
le découpage du texte a échoué. Il accepte une **liste** d'URL (`profile_urls`, 10 max par
défaut, `LI_MAX_PROFILES_PER_CALL`) ou une seule (`profile_url`) — un seul appel
suffit pour tout un lot : les profils sont dédoublonnés, mis en file, lus l'un
après l'autre, puis rendus ensemble sous la forme
`{ profiles: [{ url, profile }], errors: [{ url, error }], pending: [{ url, id }] }`.
Une URL invalide ou un profil en 404 n'interrompt pas le lot (il atterrit dans
`errors`) ; si le lot dépasse l'attente maximale (`LI_BATCH_WAIT_S`, 1 200 s),
les profils non encore lus restent en file et figurent dans `pending` —
récupérez-les avec `collect_ids`.

Les visites et recherches s'ouvrent dans une **fenêtre de travail** dédiée :
petite fenêtre sans barre d'onglets, calée dans le coin bas-droit, qui ne prend
jamais le focus. LinkedIn ne rend les sections du profil que sur une page
visible : si la fenêtre est entièrement recouverte, elle passe brièvement
devant le temps de la lecture, puis le focus revient à votre fenêtre. Vous
pouvez la fermer, elle est recréée à la demande.

**Recherche** : `linkedin_search_people` ouvre la recherche « Personnes » de
LinkedIn dans la fenêtre de travail et rend une page de résultats :
`{ page, total, has_next, results: [{ name, url, degree, headline, location,
summary }] }` (10 profils max ; `total` et `has_next` omis s'ils ne sont pas
lisibles). Critères combinables : `keywords` (texte libre, on peut y glisser une
ville), `first_name`, `last_name`, `title`, `company`, `school` (champs texte du
panneau « Tous les filtres »), `network` (`["1","2","3"]` = niveaux de
relation) et `page` (1 à 10). Chaque page compte comme une recherche
(`LI_CAP_SEARCH`, 30/jour) — LinkedIn plafonne en plus les recherches des
comptes gratuits (« limite d'utilisation commerciale », remontée en erreur).
Affinez les critères plutôt que de parcourir dix pages, puis passez les URL
retenues à `linkedin_view_profile` en un seul appel.

**URL inexistante (404)** : si la page cible n'existe pas (profil supprimé ou
renommé, faute de frappe dans le slug), l'outil échoue immédiatement avec
« page LinkedIn introuvable (404) » — sans attendre les timeouts et **sans**
déclencher de pause de sécurité (ce n'est pas un signal de détection).

Chaque outil attend le verdict jusqu'à 90 s (`LI_TOOL_WAIT_S`) ; au-delà (délai
anti-détection, micro-pause, extension déconnectée…), il répond « en file » avec
l'id de l'action, et `linkedin_status` avec `result_id` rend le résultat dès
qu'il est arrivé.

## Limites à connaître

- **Messages** : LinkedIn ne les délivre qu'aux **relations de 1er niveau**.
  Pour un inconnu, il faut d'abord une invitation acceptée.
- **Invitations** : plafonnées par LinkedIn lui-même (~100–200/semaine). Un
  profil déjà en relation ou déjà invité est ignoré (succès avec une note).
- **Chrome doit rester ouvert** avec l'extension active. Envois et lectures de
  messagerie réutilisent un onglet LinkedIn existant (l'onglet actif en
  priorité) ou en créent un en arrière-plan.
- **Un seul poste extension par serveur** : deux navigateurs se partageraient
  la file.
- **Redémarrage du serveur** (redéploiement) : la file et l'historique des
  résultats sont perdus ; les clients MCP se reconnectent seuls (le serveur
  répond 404 sur une session inconnue).
- **Maintenance** : LinkedIn change ses libellés/structure. Si une action échoue
  avec « bouton introuvable » ou « sélecteurs à mettre à jour », ajustez
  `extension/content.js` (sections « ZONE À MAINTENIR »), puis rechargez
  l'extension.
