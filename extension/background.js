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

/** Onglet LinkedIn à réutiliser (sinon on en crée un en arrière-plan). */
async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: "https://www.linkedin.com/feed/", active: false });
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

/** Envoie un message au content script, avec quelques essais (script pas encore prêt). */
async function sendToTab(tabId, payload, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
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
    const tab = await ensureTab();
    // Mode « conversation ouverte » : on N'ouvre RIEN, on agit sur l'onglet tel quel.
    if (action.open) {
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1500));
      return await sendToTab(tab.id, { type: "li-action", action });
    }
    const target =
      action.type === "list_conversations" || action.conv_name
        ? "https://www.linkedin.com/messaging/"
        : action.thread
        ? threadUrl(action.thread)
        : profileUrl(action.linkedin);
    const current = (tab.url || "").replace(/\/+$/, "");
    if (current !== target.replace(/\/+$/, "")) {
      await chrome.tabs.update(tab.id, { url: target });
      await waitForLoad(tab.id);
    }
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500)); // laisse l'UI se stabiliser
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
