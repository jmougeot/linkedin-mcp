/*
 * Service worker : la boucle de fond. Il demande au serveur MCP local la
 * prochaine action AUTORISÉE (le serveur impose quotas et délais — l'extension
 * ne décide jamais d'envoyer d'elle-même). Quand une action est servie, il
 * pilote un onglet LinkedIn pour l'exécuter via le content script, puis renvoie
 * le verdict au serveur.
 *
 * Différence avec la version Sequence Mail : le serveur est le serveur MCP de
 * Claude (local, sans mot de passe), et /api/li/next est interrogé en long-poll
 * (~25 s) pour que les demandes de Claude partent quasi instantanément.
 *
 * Sécurité : une seule action à la fois, et toute erreur remontée déclenche côté
 * serveur une pause. On n'insiste jamais.
 */
const DEFAULT_SERVER = "http://127.0.0.1:3210"; // local (Claude Code) — sur VM, mettez https://votre-domaine dans le popup
const ALARM = "li-tick";

let busy = false; // garde-fou : jamais deux actions (ni deux long-polls) en parallèle

/** Adresse du serveur, réglable depuis le popup (sinon valeur par défaut). */
async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

/** En-tête d'auth : jeton partagé (mode VM). Vide en local (Claude Code). */
async function authHeaders() {
  const { token } = await chrome.storage.local.get("token");
  return token ? { authorization: "Bearer " + token } : {};
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  tick();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  tick();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

async function getEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false; // activé par défaut
}

async function setStatus(status) {
  await chrome.storage.local.set({ lastStatus: { ...status, at: Date.now() } });
}

async function tick() {
  if (busy) return;
  if (!(await getEnabled())) {
    await setStatus({ kind: "off", text: "Extension en pause" });
    return;
  }
  busy = true;
  const SERVER = await getServer();
  const auth = await authHeaders();
  try {
    if (SERVER.startsWith("http://") && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(SERVER)) {
      await setStatus({ kind: "err", text: "Serveur distant en http:// non sécurisé — utilisez https://." });
      return;
    }
    // long-poll : le serveur retient la réponse ~25 s si la file est vide,
    // ce qui garde le service worker éveillé et rend l'envoi quasi immédiat
    const r = await fetch(`${SERVER}/api/li/next?wait=25000`, { headers: auth });
    if (r.status === 401) {
      await setStatus({ kind: "err", text: "Accès refusé (401) — jeton manquant ou incorrect (popup)." });
      return;
    }
    const res = await r.json();
    if (res.action) {
      const LABELS = {
        invite: "Invitation",
        message: "Message",
        read_messages: "Lecture de conversation",
        list_conversations: "Lecture de la messagerie",
        view_profile: "Lecture de profil",
      };
      await setStatus({ kind: "run", text: `${LABELS[res.action.type] || res.action.type} en cours…` });
      const verdict = await runAction(res.action);
      await fetch(`${SERVER}/api/li/result`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ id: res.action.id, ok: verdict.ok, error: verdict.error, data: verdict.data }),
      });
      await setStatus(
        verdict.ok
          ? { kind: "ok", text: "Dernière action : réussie" }
          : { kind: "err", text: `Échec : ${verdict.error || "inconnu"}` }
      );
    } else if (res.wait != null) {
      await setStatus({ kind: "wait", text: `${res.reason} — reprise dans ~${Math.ceil(res.wait / 60)} min` });
    } else {
      await setStatus({ kind: "idle", text: res.reason || "File vide" });
    }
  } catch (e) {
    await setStatus({ kind: "err", text: `Serveur MCP injoignable (${SERVER}). Ouvrez une session Claude dans le projet Linkedin_mcp.` });
  } finally {
    busy = false;
    // si une action vient d'être traitée, on repart aussitôt en écoute
    if (await getEnabled()) setTimeout(() => tick(), 500);
  }
}

/** Onglet LinkedIn à réutiliser (sinon on en crée un en arrière-plan).
 *  Priorité à l'onglet ACTIF : c'est celui que l'utilisateur voit — un vieil
 *  onglet LinkedIn oublié dans une autre fenêtre peut être dans un état
 *  différent (langue, session) et fausser les lectures. La fenêtre de travail
 *  des lectures de profil est exclue. */
async function ensureTab() {
  const { workerWinId } = await chrome.storage.local.get("workerWinId");
  const tabs = (await chrome.tabs.query({ url: "https://www.linkedin.com/*" }))
    .filter((t) => t.windowId !== workerWinId);
  if (tabs.length) return tabs.find((t) => t.active) || tabs[0];
  return chrome.tabs.create({ url: "https://www.linkedin.com/feed/", active: false });
}

/**
 * Fenêtre de travail des lectures de profil : petite, calée dans un coin de
 * l'écran, JAMAIS focalisée — l'utilisateur garde sa fenêtre, son clavier et
 * son onglet. LinkedIn exige une page VISIBLE pour rendre les sections, pas une
 * page au premier plan : visible-sans-focus suffit. Réutilisée d'une lecture à
 * l'autre ; si l'utilisateur la ferme, elle est recréée à la demande.
 */
async function ensureWorkerTab(url) {
  const { workerWinId } = await chrome.storage.local.get("workerWinId");
  if (workerWinId != null) {
    try {
      const win = await chrome.windows.get(workerWinId, { populate: true });
      // minimisée = invisible pour Chrome → les sections ne se rendraient pas
      if (win.state === "minimized") await chrome.windows.update(workerWinId, { state: "normal", focused: false });
      return win.tabs[0];
    } catch {} // fenêtre fermée par l'utilisateur → on la recrée
  }
  // Position : coin bas-droit de la fenêtre de l'utilisateur (Chrome refuse les
  // coordonnées hors écran — on les dérive donc d'une fenêtre réelle).
  const W = 480, H = 620;
  let pos = {};
  try {
    const ref = await chrome.windows.getLastFocused();
    pos = {
      left: Math.max(0, (ref.left || 0) + (ref.width || 1200) - W - 12),
      top: Math.max(0, (ref.top || 0) + (ref.height || 800) - H - 12),
    };
  } catch {}
  const win = await chrome.windows.create({
    url: url || "https://www.linkedin.com/feed/",
    type: "popup",       // sans barre d'onglets : discret
    focused: false,      // ne vole JAMAIS le focus
    width: W,
    height: H,
    ...pos,
  });
  await chrome.storage.local.set({ workerWinId: win.id });
  return win.tabs[0];
}

/** Attend que l'onglet ait fini de charger l'URL demandée. */
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // filet de sécurité : on ne reste pas bloqué si l'événement manque
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 25000);
  });
}

/** Envoie un message au content script, avec plusieurs essais (script pas encore
 *  prêt : page lente, onglet endormi par Chrome, ou content script orphelin après
 *  un rechargement de l'extension). Dès le 1er échec, on ré-injecte content.js
 *  nous-mêmes (permission "scripting") — la garde anti-doublon du script fait
 *  que si celui du manifest arrive aussi, un seul listener vivra. */
async function sendToTab(tabId, payload, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch {
      if (i === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return { ok: false, error: "content script injoignable" };
}

/**
 * Exécute une action : on amène l'onglet sur la page cible (profil, ou
 * messagerie pour lister les conversations), puis le content script y joue le
 * geste humain (clic, saisie, envoi — ou simple lecture du DOM).
 */
async function runAction(action) {
  try {
    // Lecture de profil : dans la fenêtre de travail dédiée (coin d'écran, sans
    // focus) — l'utilisateur n'est jamais interrompu.
    // Délai de stabilisation : la SPA LinkedIn continue de se poser après
    // l'événement "complete" — mais seulement quand on vient de NAVIGUER.
    // Page déjà chargée : délai court (le content script a ses propres waitFor).
    const settle = (navigated) =>
      new Promise((r) => setTimeout(r, navigated ? 1200 + Math.random() * 1300 : 300 + Math.random() * 400));
    if (action.type === "view_profile") {
      const url = profileUrl(action.linkedin);
      const tab = await ensureWorkerTab(url);
      const current = ((tab.pendingUrl || tab.url) || "").replace(/\/+$/, "");
      let navigated = tab.status !== "complete";
      if (current !== url.replace(/\/+$/, "")) {
        await chrome.tabs.update(tab.id, { url });
        await waitForLoad(tab.id);
        navigated = true;
      } else if (tab.status !== "complete") {
        await waitForLoad(tab.id);
      }
      await settle(navigated);
      return await sendToTab(tab.id, { type: "li-action", action });
    }
    const tab = await ensureTab();
    // Mode « conversation ouverte » : on N'ouvre RIEN, on agit sur l'onglet tel quel.
    if (action.open) {
      await settle(false);
      return await sendToTab(tab.id, { type: "li-action", action });
    }
    const target =
      action.type === "list_conversations" || action.conv_name
        ? "https://www.linkedin.com/messaging/"
        : action.thread
        ? threadUrl(action.thread)
        : profileUrl(action.linkedin);
    const current = (tab.url || "").replace(/\/+$/, "");
    let navigated = false;
    if (current !== target.replace(/\/+$/, "")) {
      await chrome.tabs.update(tab.id, { url: target });
      await waitForLoad(tab.id);
      navigated = true;
    }
    await settle(navigated);
    return await sendToTab(tab.id, { type: "li-action", action });
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Normalise l'URL de profil (force https www, garde le slug /in/...). */
function profileUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return url;
  }
}

/** Normalise l'URL d'un fil de discussion (/messaging/thread/...). */
function threadUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return url;
  }
}
