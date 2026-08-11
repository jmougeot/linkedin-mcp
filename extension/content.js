/*
 * Content script injecté sur linkedin.com. Il exécute le geste demandé en
 * pilotant la VRAIE interface (clics, saisie, envoi) comme le ferait l'humain
 * connecté — c'est volontaire : c'est l'approche la moins détectable. Aucune
 * cadence ici : le serveur a déjà décidé qu'on avait le droit d'agir maintenant.
 *
 * ⚠️ ZONE À MAINTENIR : LinkedIn change régulièrement ses libellés et sa
 * structure. Si un envoi échoue avec « bouton introuvable », ce sont les
 * sélecteurs / textes ci-dessous (FR + EN) qu'il faut mettre à jour.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
// petite pause « humaine » entre deux gestes
const human = () => sleep(rand(700, 1800));

/** Attend qu'un élément satisfaisant `find()` apparaisse (polling), sinon null. */
async function waitFor(find, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const el = find();
    if (el) return el;
    await sleep(300);
  }
  return null;
}

/** Premier bouton/lien cliquable dont le texte OU l'aria-label matche la regex. */
function findClickable(re) {
  const nodes = document.querySelectorAll('button, a, [role="button"]');
  for (const el of nodes) {
    if (el.disabled || el.offsetParent === null) continue; // ignore masqués/désactivés
    const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim();
    if (re.test(label)) return el;
  }
  return null;
}

// --- Simulation « souris humaine » -------------------------------------------
// Un bot se trahit par : clic pile au centre, au pixel près, sans déplacement de
// curseur, avec un appui instantané. On corrige les trois : point aléatoire dans
// l'élément, trajectoire de curseur en plusieurs paliers, durée de pression
// variable. On garde en mémoire la dernière position pour enchaîner les gestes
// de façon cohérente (le curseur ne se téléporte pas).
let _lastPointer = { x: null, y: null };

/** Point légèrement aléatoire dans l'élément — jamais deux fois le même pixel. */
function jitterPoint(el) {
  const r = el.getBoundingClientRect();
  const padX = Math.min(r.width * 0.32, 14);
  const padY = Math.min(r.height * 0.32, 10);
  return {
    x: Math.round(r.left + r.width / 2 + rand(-padX, padX)),
    y: Math.round(r.top + r.height / 2 + rand(-padY, padY)),
  };
}

/** Déplace le curseur vers (x,y) en quelques mousemove intermédiaires, avec une
 *  trajectoire adoucie (smoothstep) et un léger bruit — comme une vraie main. */
async function moveMouseTo(x, y) {
  const from = _lastPointer.x == null
    ? { x: x - rand(80, 240), y: y - rand(60, 180) } // 1re fois : départ plausible hors cible
    : { x: _lastPointer.x, y: _lastPointer.y };
  const steps = 3 + Math.floor(rand(0, 4)); // 3 à 6 paliers
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // smoothstep : accélère puis ralentit
    const px = Math.round(from.x + (x - from.x) * ease + rand(-2, 2));
    const py = Math.round(from.y + (y - from.y) * ease + rand(-2, 2));
    const el = document.elementFromPoint(px, py) || document.body;
    const o = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py };
    el.dispatchEvent(new PointerEvent("pointermove", { ...o, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousemove", o));
    await sleep(rand(12, 45));
  }
  _lastPointer = { x, y };
}

/** Appui souris « humain » sur (x,y) SANS le click final : survol → appui →
 *  durée de pression → relâche. Le déclenchement se fait ensuite au choix de
 *  l'appelant (click natif proven pour les boutons, click synthétique pour la
 *  liste de conversations où le natif n'a aucun effet). Évite tout double-tir. */
async function pressAt(el, x, y) {
  const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  const p = { ...o, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", p));
  el.dispatchEvent(new MouseEvent("mouseover", o));
  el.dispatchEvent(new PointerEvent("pointerdown", p));
  el.dispatchEvent(new MouseEvent("mousedown", o));
  try { el.focus && el.focus(); } catch {}
  await sleep(rand(80, 170)); // temps de pression
  el.dispatchEvent(new PointerEvent("pointerup", p));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  return o;
}

/** Clic « humain » sur un vrai bouton (Message, Envoyer, Se connecter…) :
 *  défilement doux, déplacement du curseur vers un point aléatoire, hésitation,
 *  séquence d'appui souris, puis UN SEUL déclenchement via le .click() natif
 *  (celui qui a toujours fonctionné ici — pas de synthétique en plus, sinon on
 *  risquerait un double envoi). */
async function clickHuman(el) {
  try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  catch { el.scrollIntoView({ block: "center" }); }
  await sleep(rand(400, 950)); // laisse le défilement se stabiliser (coords fiables)
  const { x, y } = jitterPoint(el);
  await moveMouseTo(x, y);
  await sleep(rand(50, 160)); // petite hésitation avant d'appuyer
  await pressAt(el, x, y);
  await sleep(rand(20, 70));
  el.click(); // déclenchement unique et éprouvé
}

/** Saisit du texte dans un textarea ou un contenteditable, en déclenchant les events React. */
async function typeInto(el, text) {
  el.focus();
  await sleep(rand(200, 500));
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    setter.set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // contenteditable (éditeur LinkedIn) : on NE vide PAS via textContent (ça casse
    // la structure interne et laisse le modèle « vide » → bouton Envoyer grisé).
    // On efface proprement via l'éditeur, puis insertText, puis un InputEvent complet.
    try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch {}
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  }
  await sleep(rand(400, 900));
}

/** Repli : simule un COLLAGE. De nombreux éditeurs (React/Quill) n'activent le
 *  bouton Envoyer que sur un vrai `paste` — on efface puis on colle le texte. */
async function pasteInto(el, text) {
  el.focus();
  try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch {}
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  } catch {}
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: text }));
  await sleep(rand(400, 800));
}

// --- Libellés (FR + EN). À COMPLÉTER si LinkedIn change. ----------------------
const RE_CONNECT = /^(se connecter|connect|invitez|invite)\b/i;
const RE_MORE = /^(plus|more actions|more)\b/i;
const RE_MESSAGE = /(?:^|\b)(message|messagerie)\b/i;
const RE_ADD_NOTE = /(ajouter une note|add a note)/i;
const RE_SEND_NOTE = /(envoyer l.invitation|envoyer$|^envoyer\b|send invitation|^send$)/i;
const RE_SEND_NO_NOTE = /(envoyer sans note|send without)/i;
const RE_SEND_MSG = /(^envoyer$|^send$)/i;

/** Bouton « Message » DU PROFIL affiché — PAS le lien global « Messagerie » de
 *  la barre de navigation (en FR il matche le même mot et arrive plus tôt dans le
 *  DOM : on cliquait la mauvaise fenêtre → « zone de saisie introuvable »).
 *  On écarte donc tout lien vers /messaging/ (c'est la nav) et on privilégie le
 *  vrai bouton d'action du profil (« Message » / « Envoyer un message à … »). */
function findProfileMessageBtn() {
  const nodes = document.querySelectorAll('button, a, [role="button"]');
  for (const el of nodes) {
    if (el.disabled || el.offsetParent === null) continue;
    const href = el.getAttribute("href") || "";
    if (/\/messaging\b/.test(href)) continue; // lien de nav global → ignoré
    const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim();
    if (/^messagerie$/i.test(label)) continue; // libellé nav seul → ignoré
    if (/(?:^|\b)message\b/i.test(label) || /envoyer un message/i.test(label)) return el;
  }
  return null;
}

/** Bouton « Se connecter », éventuellement caché dans le menu « Plus ». */
async function findConnectButton() {
  let btn = findClickable(RE_CONNECT);
  if (btn) return btn;
  const more = findClickable(RE_MORE);
  if (more) {
    await clickHuman(more);
    await human();
    btn = await waitFor(() => findClickable(RE_CONNECT), 4000);
  }
  return btn;
}

/** Envoie une invitation (avec note optionnelle, tronquée à 200 caractères). */
async function doInvite(note) {
  // Déjà en relation / invitation déjà partie ? On considère l'action faite (pas d'erreur punitive).
  if (!findClickable(RE_CONNECT) && (findClickable(RE_MESSAGE) || findClickable(/en attente|pending/i))) {
    if (!(await findConnectButton())) return { ok: true, error: "déjà en relation ou invitation déjà envoyée (ignoré)" };
  }
  const connect = await findConnectButton();
  if (!connect) return { ok: false, error: "bouton « Se connecter » introuvable" };
  await clickHuman(connect);
  await human();

  const clean = (note || "").slice(0, 200).trim();
  if (clean) {
    const addNote = await waitFor(() => findClickable(RE_ADD_NOTE), 4000);
    if (addNote) {
      await clickHuman(addNote);
      const box = await waitFor(
        () => document.querySelector('textarea[name="message"], #custom-message, textarea#custom-message'),
        4000
      );
      if (!box) return { ok: false, error: "champ de note introuvable" };
      await typeInto(box, clean);
    }
  }
  // Envoyer (avec ou sans note)
  const send = await waitFor(() => findClickable(clean ? RE_SEND_NOTE : RE_SEND_NO_NOTE) || findClickable(RE_SEND_NOTE), 5000);
  if (!send) return { ok: false, error: "bouton « Envoyer » de l'invitation introuvable" };
  await clickHuman(send);
  await human();
  return { ok: true };
}

/** Envoie un message. Depuis un profil (le profil doit être une relation) ou,
 *  si inThread, directement dans un fil déjà ouvert (/messaging/thread/...). */
async function doMessage(text, inThread) {
  if (!text || !text.trim()) return { ok: false, error: "message vide" };
  if (!inThread) {
    const msgBtn = await waitFor(() => findProfileMessageBtn(), 6000);
    if (!msgBtn) return { ok: false, error: "bouton « Message » du profil introuvable" };
    await clickHuman(msgBtn);
    await human();
  }
  // Dans un fil, le champ de saisie est déjà présent — pas de bouton à cliquer.

  const editor = await waitFor(
    () => document.querySelector('.msg-form__contenteditable [contenteditable="true"], div[role="textbox"][contenteditable="true"]'),
    6000
  );
  if (!editor) return { ok: false, error: "zone de saisie du message introuvable" };

  // Saisie par COLLAGE (méthode principale : plus robuste et plus humaine — un
  // vrai éditeur active le bouton Envoyer sur un paste).
  await pasteInto(editor, text.trim());
  let send = await waitFor(() => document.querySelector('button.msg-form__send-button:not([disabled])'), 4000);
  if (!send) {
    // Repli : saisie directe si le collage n'a pas réveillé l'éditeur.
    await typeInto(editor, text.trim());
    send = await waitFor(() => document.querySelector('button.msg-form__send-button:not([disabled])'), 4000);
  }
  if (!send) send = findClickable(RE_SEND_MSG);
  if (!send) return { ok: false, error: "le champ n'a pas été reconnu par LinkedIn (bouton Envoyer resté désactivé après collage et saisie)" };
  await clickHuman(send);
  await human();
  return { ok: true };
}

/**
 * Lit la conversation avec le profil affiché : ouvre l'overlay de messagerie
 * (clic « Message ») puis extrait les derniers messages du fil.
 * ⚠️ ZONE À MAINTENIR : sélecteurs de la messagerie LinkedIn.
 */
async function doReadMessages(limit = 25, inThread) {
  if (!inThread) {
    const msgBtn = await waitFor(() => findProfileMessageBtn(), 6000);
    if (!msgBtn) return { ok: false, error: "bouton « Message » du profil introuvable" };
    await clickHuman(msgBtn);
    await human();
  }
  // Dans un fil, le fil de discussion est déjà affiché.

  const list = await waitFor(
    () => document.querySelector(".msg-s-message-list, .msg-s-message-list-content"),
    8000
  );
  if (!list) return { ok: false, error: "fil de discussion introuvable (aucun historique avec ce profil ?)" };
  await sleep(rand(800, 1600)); // laisse charger les derniers messages

  // Les messages consécutifs d'un même expéditeur sont groupés : le nom
  // n'apparaît que sur le premier — on le propage aux suivants.
  // Sélecteur unique (les deux ci-dessous matchaient la même ligne = doublons).
  let events = [...document.querySelectorAll("li.msg-s-event-listitem")];
  if (!events.length) events = [...document.querySelectorAll(".msg-s-event-listitem, li.msg-s-message-list__event")];
  const out = [];
  let lastSender = null;
  let lastTime = null;
  for (const ev of events) {
    const nameEl = ev.querySelector(".msg-s-message-group__name");
    if (nameEl) lastSender = nameEl.textContent.trim();
    const timeEl = ev.querySelector(".msg-s-message-group__timestamp, time");
    if (timeEl) lastTime = timeEl.textContent.trim();
    for (const body of ev.querySelectorAll(".msg-s-event-listitem__body")) {
      const text = body.innerText.trim();
      if (text) out.push({ sender: lastSender, time: lastTime, text });
    }
  }
  if (!out.length) return { ok: false, error: "aucun message lisible dans le fil (sélecteurs à mettre à jour ?)" };
  return { ok: true, data: { messages: out.slice(-limit) } };
}

/**
 * Liste les conversations récentes (la page https://www.linkedin.com/messaging/
 * doit être affichée — le background s'en charge).
 * ⚠️ ZONE À MAINTENIR : sélecteurs de la liste de conversations.
 */
async function doListConversations(limit = 15) {
  const list = await waitFor(
    () => document.querySelector(".msg-conversations-container__conversations-list, ul.msg-conversations-container__conversations-list"),
    10000
  );
  if (!list) return { ok: false, error: "liste de conversations introuvable (page messagerie non chargée ?)" };
  await sleep(rand(800, 1600));

  const abs = (href) => {
    try { return href ? new URL(href, location.origin).href : null; } catch { return null; }
  };
  // Un seul niveau de sélection pour éviter les doublons (li + carte imbriquée
  // matchaient tous les deux la même conversation).
  let cards = [...document.querySelectorAll("li.msg-conversation-listitem")];
  if (!cards.length) cards = [...document.querySelectorAll(".msg-conversation-card")];
  const rows = cards.map((c) => {
    const threadA = c.querySelector('a[href*="/messaging/thread/"]') || (c.matches?.('a[href*="/messaging/thread/"]') ? c : null);
    const profA = c.querySelector('a[href*="/in/"]'); // parfois absent de la carte de liste
    return {
      name:
        c.querySelector(".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names")
          ?.innerText.trim() || null,
      // thread_url : le lien fiable dans la liste (répondre s'appuie dessus)
      thread_url: abs(threadA?.getAttribute("href")),
      profile_url: abs(profA?.getAttribute("href")),
      snippet: c.querySelector(".msg-conversation-card__message-snippet")?.innerText.trim() || null,
      time: c.querySelector(".msg-conversation-listitem__time-stamp, time")?.innerText.trim() || null,
      unread:
        !!c.querySelector(".notification-badge--show, .msg-conversation-card__unread-count") ||
        /unread/i.test(c.className || ""),
    };
  }).filter((c) => c.name);
  // Dédoublonnage de sécurité (par fil, sinon par nom+aperçu).
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    const key = c.thread_url || `${c.name}|${c.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  const trimmed = out.slice(0, limit);
  if (!trimmed.length) return { ok: false, error: "aucune conversation trouvée (sélecteurs à mettre à jour ?)" };
  return { ok: true, data: { conversations: trimmed } };
}

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Clic « musclé » qui déclenche vraiment la navigation SPA de LinkedIn.
 * LinkedIn n'expose ni lien ni id dans la liste : le fil s'ouvre au clic JS,
 * et le gestionnaire est sur un élément ENFANT — cliquer le <li> parent ne le
 * déclenche pas. On vise donc l'élément réellement sous le centre de la carte
 * (elementFromPoint) et on émet la séquence pointer+souris complète, qui remonte
 * jusqu'au bon gestionnaire.
 */
async function robustClick(container) {
  try { container.scrollIntoView({ block: "center", behavior: "smooth" }); }
  catch { container.scrollIntoView({ block: "center" }); }
  await sleep(rand(350, 750)); // stabilisation du défilement
  const r = container.getBoundingClientRect();
  // point aléatoire dans la moitié haute de la carte (là où se trouve le nom/handler),
  // jamais pile au centre : plus proche d'un vrai clic.
  const x = Math.round(r.left + rand(r.width * 0.2, r.width * 0.8));
  const y = Math.round(r.top + rand(8, Math.min(Math.max(r.height - 6, 10), 40)));
  let el = document.elementFromPoint(x, y);
  if (!el || !container.contains(el)) el = container;
  await moveMouseTo(x, y);            // déplacement de curseur humain vers la carte
  await sleep(rand(40, 140));         // hésitation
  const o = await pressAt(el, x, y);  // survol → appui → relâche (positions cohérentes)
  // ici le click SYNTHÉTIQUE est nécessaire : LinkedIn n'ouvre pas le fil sur un
  // .click() natif du <li> (le gestionnaire est sur un enfant, capté par elementFromPoint).
  el.dispatchEvent(new MouseEvent("click", o));
}

/** Nom du contact affiché dans l'en-tête du fil actuellement ouvert (best-effort). */
function openThreadName() {
  const sels = [
    ".msg-thread .msg-entity-lockup__entity-title",
    ".msg-title-bar__details h2",
    ".msg-title-bar h2",
    ".scaffold-layout__detail h2",
    ".msg-thread h2",
  ];
  for (const s of sels) {
    const e = document.querySelector(s);
    if (e && e.textContent.trim()) return e.textContent.trim();
  }
  return null;
}

/** Ouvre la conversation dont le participant correspond à `name`, sur la page
 *  messagerie déjà chargée (le background y a navigué). Vérifie que le fil s'est
 *  bien ouvert AVANT d'autoriser l'écriture — jamais d'envoi au mauvais contact. */
async function openConversationByName(name) {
  const list = await waitFor(
    () => document.querySelector(".msg-conversations-container__conversations-list, ul.msg-conversations-container__conversations-list"),
    10000
  );
  if (!list) return { ok: false, error: "messagerie non chargée" };
  await sleep(rand(800, 1600));

  const want = norm(name);
  const nameOf = (c) =>
    norm(c.querySelector(".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names")?.textContent);

  const pick = () => {
    const cards = [...document.querySelectorAll("li.msg-conversation-listitem")];
    return (
      cards.find((c) => nameOf(c) === want) ||
      cards.find((c) => nameOf(c).startsWith(want)) ||
      cards.find((c) => nameOf(c).includes(want)) ||
      null
    );
  };
  const card = await waitFor(pick, 6000);
  if (!card) return { ok: false, error: `conversation avec « ${name} » introuvable dans la liste` };

  await robustClick(card);
  await human();

  // Vérifie que le BON fil est ouvert : en-tête au nom voulu OU le panneau de
  // détail contient ce nom, ET le champ de saisie est présent.
  const ok = await waitFor(() => {
    const composer = document.querySelector('.msg-form__contenteditable [contenteditable="true"], div[role="textbox"][contenteditable="true"]');
    if (!composer) return false;
    const title = norm(openThreadName());
    if (title && (title === want || title.includes(want) || want.includes(title))) return true;
    const detail = document.querySelector(".msg-thread, .scaffold-layout__detail");
    return detail ? norm(detail.textContent).includes(want) : false;
  }, 9000);

  if (!ok) {
    return {
      ok: false,
      error: `impossible d'ouvrir la conversation de « ${name} » : LinkedIn n'a pas réagi au clic (il exige peut-être un vrai clic humain). Aucun message envoyé.`,
    };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "li-action") {
    const { action } = msg;
    (async () => {
      try {
        // Sécurité : si LinkedIn affiche un contrôle de sécurité / captcha, on s'arrête net.
        if (/checkpoint|captcha|challenge/i.test(location.href)) {
          sendResponse({ ok: false, error: "contrôle de sécurité LinkedIn détecté — pause" });
          return;
        }
        // Mode « conversation ouverte » (le plus fiable) : on agit directement
        // dans le fil affiché, sans navigation ni clic sur la liste.
        if (action.open && (action.type === "message" || action.type === "read_messages")) {
          if (!/\/messaging\//.test(location.href)) {
            sendResponse({ ok: false, error: "aucune conversation ouverte à l'écran (ouvre la conversation LinkedIn voulue d'abord)" });
            return;
          }
          const r = action.type === "read_messages"
            ? await doReadMessages(action.limit, true)
            : await doMessage(action.body, true);
          sendResponse(r);
          return;
        }
        // Ciblage par NOM (secondaire) : on ouvre la conversation puis on agit dans le fil.
        if (action.conv_name && (action.type === "message" || action.type === "read_messages")) {
          const opened = await openConversationByName(action.conv_name);
          if (!opened.ok) { sendResponse(opened); return; }
          const r = action.type === "read_messages"
            ? await doReadMessages(action.limit, true)
            : await doMessage(action.body, true);
          sendResponse(r);
          return;
        }
        const inThread = !!action.thread; // action ciblant un fil (/messaging/thread/...)
        const r =
          action.type === "message" ? await doMessage(action.body, inThread)
          : action.type === "read_messages" ? await doReadMessages(action.limit, inThread)
          : action.type === "list_conversations" ? await doListConversations(action.limit)
          : await doInvite(action.body);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // réponse asynchrone
  }
});
