#!/usr/bin/env node
/*
 * Serveur MCP LinkedIn — adapté de l'app Sequence Mail (Ruby/prospection).
 *
 * Deux faces :
 *  1. MCP  : Claude appelle linkedin_send_message / _send_invitation /
 *            _read_messages / _list_conversations / _view_profile / _status /
 *            _cancel. Chaque
 *            action est mise en FILE, jamais exécutée directement — c'est
 *            l'extension qui agit.
 *  2. HTTP : l'extension Chrome interroge ce serveur (long-poll) pour savoir si
 *            elle a le droit d'agir MAINTENANT. Le serveur impose quotas
 *            journaliers, délai aléatoire et pause de sécurité — la règle d'or
 *            anti-ban : l'extension n'envoie jamais quand elle veut.
 *
 * Deux modes de transport MCP (LI_TRANSPORT) :
 *  - "stdio" (défaut) : lancé par Claude Code en local. HTTP sur 127.0.0.1, sans
 *    jeton. ⚠️ Ne JAMAIS écrire sur stdout (logs via console.error).
 *  - "http" : déployé sur une VM pour Claude Cowork. MCP exposé en Streamable
 *    HTTP sur /mcp/<LI_TOKEN> (connecteur distant), et /api/li/* protégé par
 *    Authorization: Bearer <LI_TOKEN>. À mettre DERRIÈRE un reverse-proxy HTTPS
 *    (Caddy) — Anthropic exige une URL publique HTTPS. Voir DEPLOY.md.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Mode / authentification --------------------------------------------------
const TRANSPORT = (process.env.LI_TRANSPORT || "stdio").toLowerCase(); // "stdio" | "http"
const TOKEN = process.env.LI_TOKEN || "";      // jeton partagé (obligatoire en mode http)
const BIND = process.env.LI_BIND || "127.0.0.1"; // 0.0.0.0 si exposé sans reverse-proxy

// --- Réglages (surchargables via variables d'environnement, préfixe LI_) ------
const PORT = Number(process.env.LI_MCP_PORT || 3210);
const CAP_INVITE = Number(process.env.LI_CAP_INVITE || 20);   // plafond/jour
const CAP_MESSAGE = Number(process.env.LI_CAP_MESSAGE || 40); // plafond/jour
const CAP_VIEW = Number(process.env.LI_CAP_VIEW || 80);       // plafond/jour — visites de profil
const CAP_READ = Number(process.env.LI_CAP_READ || 150);      // plafond/jour — lectures légères
const MIN_GAP_S = Number(process.env.LI_MIN_GAP_S || 45);     // délai mini entre 2 envois
const MAX_GAP_S = Number(process.env.LI_MAX_GAP_S || 120);    // délai maxi
const VIEW_MIN_GAP_S = Number(process.env.LI_VIEW_MIN_GAP_S || 20); // délai mini entre 2 visites de profil
const VIEW_MAX_GAP_S = Number(process.env.LI_VIEW_MAX_GAP_S || 60); // délai maxi
const READ_MIN_GAP_S = Number(process.env.LI_READ_MIN_GAP_S || 4); // délai mini entre 2 lectures légères
const READ_MAX_GAP_S = Number(process.env.LI_READ_MAX_GAP_S || 12); // délai maxi

// Rythme « humain » : volume horaire plafonné + micro-pauses + plage horaire.
// C'est ce qui casse la signature d'une boucle automatisée — un débit régulier
// et ininterrompu est bien plus détectable qu'un volume élevé mais irrégulier.
const CAP_HOUR = Number(process.env.LI_CAP_HOUR || 40);           // actions/heure, tous types
const CAP_HOUR_VIEW = Number(process.env.LI_CAP_HOUR_VIEW || 15); // visites de profil/heure
const BURST_MIN = Number(process.env.LI_BURST_MIN || 8);   // actions d'affilée avant micro-pause (borne basse)
const BURST_MAX = Number(process.env.LI_BURST_MAX || 16);  // idem (borne haute) — tiré au hasard
const BREAK_MIN_S = Number(process.env.LI_BREAK_MIN_S || 90);  // micro-pause mini (1 min 30)
const BREAK_MAX_S = Number(process.env.LI_BREAK_MAX_S || 240); // micro-pause maxi (4 min)
const ACTIVE_START = Number(process.env.LI_ACTIVE_START ?? 8);  // heure locale de début d'activité
const ACTIVE_END = Number(process.env.LI_ACTIVE_END ?? 20);     // heure locale de fin (exclue)
const SKIP_WEEKEND = /^(1|true|yes)$/i.test(process.env.LI_SKIP_WEEKEND || "");
const TZ = process.env.LI_TZ || "Europe/Paris";
const FAIL_PAUSE_MIN = Number(process.env.LI_FAIL_PAUSE_MIN || 10);       // pause après échec simple
const CHECKPOINT_PAUSE_MIN = Number(process.env.LI_CHECKPOINT_PAUSE_MIN || 60); // pause après captcha/checkpoint
const TOOL_WAIT_S = Number(process.env.LI_TOOL_WAIT_S || 90); // attente max du résultat côté outil MCP
const BATCH_WAIT_S = Number(process.env.LI_BATCH_WAIT_S || 1200); // attente max pour un lot de lectures
const MAX_PROFILES_PER_CALL = Number(process.env.LI_MAX_PROFILES_PER_CALL || 10); // profils par appel
const INFLIGHT_TIMEOUT_S = 300; // action servie mais jamais confirmée → échec

// Les baisser est sûr ; les gonfler augmente le risque de restriction du compte.

// --- État persistant (compteurs du jour) --------------------------------------
const DATA_DIR = join(__dirname, "data");
const STATE_FILE = join(DATA_DIR, "state.json");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function freshCounters() {
  return { date: today(), invite: 0, message: 0, view_profile: 0, read: 0 };
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Fusion avec les compteurs neufs : un state.json écrit par une version
    // antérieure n'a ni view_profile ni read.
    if (s.date === today()) return { ...freshCounters(), ...s };
  } catch {}
  return freshCounters();
}

function saveState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(counters, null, 2));
  } catch (e) {
    console.error("[linkedin-mcp] impossible d'écrire data/state.json:", e.message);
  }
}

let counters = loadState();

function rollDay() {
  if (counters.date !== today()) {
    counters = freshCounters();
    saveState();
  }
}

// --- État en mémoire ----------------------------------------------------------
const queue = [];            // actions en attente [{id, type, linkedin, body, enqueuedAt}]
const inFlight = new Map();  // id -> {action, servedAt}
const results = [];          // historique récent [{id, type, linkedin, ok, error, at}]
const waiters = new Map();   // id -> resolve(result) — outils MCP en attente du verdict
let nextWaiters = [];        // long-poll de l'extension en attente d'une action
let enabled = true;          // pause/activation (pilotée par le popup de l'extension)
let pausedUntil = 0;         // pause de sécurité après échec (epoch ms)
let lastActionAt = 0;        // fin de la dernière action (epoch ms)
let nextGapMs = 0;           // délai aléatoire imposé avant la prochaine action
let lastPollAt = 0;          // dernier contact de l'extension (epoch ms)
let recentActions = [];      // horodatages des actions de la dernière heure [{at, cls}]
let burstCount = 0;          // actions effectuées depuis la dernière micro-pause
let burstLimit = 0;          // seuil tiré au hasard déclenchant la micro-pause (0 = à tirer)
let breakUntil = 0;          // micro-pause « humaine » en cours (epoch ms)

const rand = (a, b) => a + Math.random() * (b - a);

// Classes d'action, par ordre de risque décroissant :
//   send → invitation/message : quota journalier, grand délai, plage horaire.
//   view → visite de profil : c'est LE signal que LinkedIn surveille le plus.
//          Quota journalier + horaire, délai long, plage horaire.
//   read → messagerie/liste de conversations : léger, mais plafonné à l'heure
//          et au jour pour qu'une boucle ne tourne pas indéfiniment.
// Toutes les classes restent séquentielles et déclenchent la pause en cas de captcha.
const SEND_TYPES = new Set(["invite", "message"]);
const VIEW_TYPES = new Set(["view_profile"]);

function classOf(type) {
  return SEND_TYPES.has(type) ? "send" : VIEW_TYPES.has(type) ? "view" : "read";
}

/** Clé du compteur journalier : les lectures légères partagent le même seau. */
function counterKey(type) {
  const cls = classOf(type);
  return cls === "send" ? type : cls === "view" ? "view_profile" : "read";
}

function extensionConnected() {
  return Date.now() - lastPollAt < 45_000;
}

function capFor(type) {
  switch (classOf(type)) {
    case "send": return type === "invite" ? CAP_INVITE : CAP_MESSAGE;
    case "view": return CAP_VIEW;
    default: return CAP_READ;
  }
}

/** Délai aléatoire imposé après une action de ce type, en ms. */
function gapMsFor(type) {
  switch (classOf(type)) {
    case "send": return rand(MIN_GAP_S, MAX_GAP_S) * 1000;
    case "view": return rand(VIEW_MIN_GAP_S, VIEW_MAX_GAP_S) * 1000;
    default: return rand(READ_MIN_GAP_S, READ_MAX_GAP_S) * 1000;
  }
}

/** Purge la fenêtre glissante d'une heure et renvoie les actions restantes. */
function pruneRecent(now = Date.now()) {
  const cutoff = now - 3_600_000;
  if (recentActions.length && recentActions[0].at < cutoff) {
    recentActions = recentActions.filter((a) => a.at >= cutoff);
  }
  return recentActions;
}

/**
 * Heure locale (fuseau LI_TZ) sous forme { hour, minute, weekend }.
 * Passe par Intl plutôt que par un décalage fixe pour rester juste en
 * heure d'été comme en heure d'hiver.
 */
function localClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekend: /^(Sat|Sun)$/.test(get("weekday")),
  };
}

/**
 * Fenêtre d'activité : hors plage, on ne fait ni envoi ni visite de profil.
 * Les lectures légères restent permises (consulter ses messages le soir n'a
 * rien d'anormal) mais restent soumises aux plafonds horaires.
 * Renvoie null si l'action peut passer, sinon { wait, reason }.
 */
function activeWindowCheck(type) {
  if (classOf(type) === "read") return null;
  if (ACTIVE_START >= ACTIVE_END) return null; // plage désactivée (ex. 0/0)
  const { hour, minute, weekend } = localClock();
  const inHours = hour >= ACTIVE_START && hour < ACTIVE_END;
  if (inHours && !(SKIP_WEEKEND && weekend)) return null;
  // Attente ré-évaluée au plus tard dans 15 min : évite tout calcul de bascule
  // de jour/fuseau, l'extension repasse simplement plus tard.
  const untilStartS = inHours ? 900 : ((ACTIVE_START - hour + 24) % 24) * 3600 - minute * 60;
  return {
    wait: Math.max(60, Math.min(900, untilStartS)),
    reason: `Hors plage d'activité (${ACTIVE_START}h–${ACTIVE_END}h ${TZ}${SKIP_WEEKEND ? ", hors week-end" : ""})`,
  };
}

/**
 * Plafonds horaires (fenêtre glissante de 60 min).
 * Renvoie null si l'action peut passer, sinon { wait, reason }.
 */
function hourlyCheck(type, now = Date.now()) {
  const recent = pruneRecent(now);
  const isView = classOf(type) === "view";
  const waitFor = (list, cap, label) => {
    if (list.length < cap) return null;
    // On peut repartir quand la plus ancienne action du lot sort de la fenêtre.
    const oldest = list[list.length - cap].at;
    return {
      wait: Math.max(60, Math.ceil((oldest + 3_600_000 - now) / 1000)),
      reason: `Plafond horaire atteint (${list.length}/${cap} ${label} sur les 60 dernières minutes)`,
    };
  };
  return (
    (isView ? waitFor(recent.filter((a) => a.cls === "view"), CAP_HOUR_VIEW, "visites de profil") : null) ||
    waitFor(recent, CAP_HOUR, "actions")
  );
}

function notifyExtension() {
  const ws = nextWaiters;
  nextWaiters = [];
  for (const w of ws) w();
}

function recordResult(action, ok, error, data) {
  rollDay();
  const cls = classOf(action.type);
  const isSend = cls === "send";
  // Envoi : compté seulement s'il a abouti. Lecture/visite : comptée dans tous
  // les cas — la page a été ouverte, donc LinkedIn l'a vue, succès ou non.
  if (ok || !isSend) {
    counters[counterKey(action.type)] = (counters[counterKey(action.type)] || 0) + 1;
    saveState();
  }
  const now = Date.now();
  lastActionAt = now;
  nextGapMs = gapMsFor(action.type);
  pruneRecent(now).push({ at: now, cls });

  // Micro-pause « humaine » : après une série d'actions, on s'arrête plusieurs
  // minutes. Un débit parfaitement régulier sur des heures est le marqueur
  // d'automatisation le plus facile à repérer côté LinkedIn.
  if (!burstLimit) burstLimit = Math.round(rand(BURST_MIN, BURST_MAX));
  if (++burstCount >= burstLimit) {
    breakUntil = now + rand(BREAK_MIN_S, BREAK_MAX_S) * 1000;
    burstCount = 0;
    burstLimit = 0; // nouveau seuil tiré à la prochaine action
  }
  if (!ok) {
    const critical = /checkpoint|captcha|challenge|contrôle de sécurité/i.test(error || "");
    // Page 404 (profil supprimé / URL erronée) : échec « normal », pas un signal
    // de détection — aucune pause punitive, on passe à l'action suivante.
    const notFound = /\(404\)/.test(error || "");
    const pauseMin = critical ? CHECKPOINT_PAUSE_MIN : notFound ? 0 : isSend ? FAIL_PAUSE_MIN : 1;
    if (pauseMin) pausedUntil = Date.now() + pauseMin * 60_000;
  }
  const r = {
    id: action.id, type: action.type, target: action.linkedin || action.thread || (action.open ? "conversation-ouverte" : action.conv_name) || null,
    ok, error: error || null, data: data || null, at: new Date().toISOString(),
  };
  results.push(r);
  if (results.length > 50) results.shift();
  const resolve = waiters.get(action.id);
  if (resolve) {
    waiters.delete(action.id);
    resolve(r);
  }
}

// Filet de sécurité : action servie à l'extension mais jamais confirmée
setInterval(() => {
  const now = Date.now();
  for (const [id, { action, servedAt }] of inFlight) {
    if (now - servedAt > INFLIGHT_TIMEOUT_S * 1000) {
      inFlight.delete(id);
      recordResult(action, false, "aucune confirmation de l'extension (timeout)");
    }
  }
}, 15_000).unref();

// --- Mise en file (appelée par les outils MCP) --------------------------------
function enqueue(type, linkedinUrl, body, extra = {}) {
  rollDay();
  // Plafond journalier — appliqué à tous les types, y compris les lectures :
  // c'est ce qui empêche une boucle de tourner sans fin sur la journée.
  const key = counterKey(type);
  const cap = capFor(type);
  const envVar = key === "read" ? "LI_CAP_READ" : key === "view_profile" ? "LI_CAP_VIEW" : `LI_CAP_${key.toUpperCase()}`;
  if (counters[key] >= cap) {
    throw new Error(
      `Plafond journalier atteint pour "${key}" (${counters[key]}/${cap}). Réessayez demain ou augmentez ${envVar} (déconseillé).`
    );
  }
  const pendingSameKey = queue.filter((a) => counterKey(a.type) === key).length;
  if (counters[key] + pendingSameKey >= cap) {
    throw new Error(`La file contient déjà assez d'actions "${key}" pour atteindre le plafond journalier (${cap}).`);
  }
  const action = {
    id: randomUUID(),
    type, // "invite" | "message" | "read_messages" | "list_conversations" | "view_profile"
    linkedin: linkedinUrl || null,
    body: body || "",
    ...extra,
    enqueuedAt: Date.now(),
  };
  queue.push(action);
  notifyExtension();
  return action;
}

function waitForResult(id, timeoutS = TOOL_WAIT_S) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      resolve(null); // toujours en attente — pas un échec
    }, timeoutS * 1000);
    waiters.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/**
 * Retrouve un résultat déjà enregistré à partir de son id d'action.
 * L'historique ne garde que les 50 derniers résultats : au-delà, l'id est perdu.
 */
function findResult(id) {
  return results.find((r) => r.id === id);
}

function statusSnapshot() {
  rollDay();
  return {
    extension: {
      connected: extensionConnected(),
      last_poll: lastPollAt ? new Date(lastPollAt).toISOString() : null,
      enabled,
    },
    today: {
      invite: { sent: counters.invite, cap: CAP_INVITE },
      message: { sent: counters.message, cap: CAP_MESSAGE },
      view_profile: { done: counters.view_profile, cap: CAP_VIEW },
      read: { done: counters.read, cap: CAP_READ },
    },
    last_hour: {
      actions: { done: pruneRecent().length, cap: CAP_HOUR },
      view_profile: { done: pruneRecent().filter((a) => a.cls === "view").length, cap: CAP_HOUR_VIEW },
    },
    queue: {
      pending: queue.length + inFlight.size,
      items: [...queue, ...[...inFlight.values()].map((f) => f.action)].map((a) => ({
        id: a.id, type: a.type, target: a.linkedin || a.thread || a.conv_name || null,
      })),
    },
    safety_pause_until: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    human_break_until: breakUntil > Date.now() ? new Date(breakUntil).toISOString() : null,
    active_window: {
      hours: ACTIVE_START >= ACTIVE_END ? "désactivée" : `${ACTIVE_START}h–${ACTIVE_END}h`,
      timezone: TZ,
      skip_weekend: SKIP_WEEKEND,
      // Ne concerne que les envois et les visites de profil ; les lectures
      // légères passent à toute heure (dans la limite des plafonds).
      open_for_sends: activeWindowCheck("invite") === null,
    },
    // data omis (peut être volumineux) — les lectures rendent leur contenu via leur propre outil
    recent_results: results.slice(-10).map(({ data, ...rest }) => ({ ...rest, has_data: data != null })),
  };
}

// --- Serveur HTTP (interface avec l'extension Chrome + MCP distant) -----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id",
  });
  res.end(body);
}

/** Comparaison de jetons à temps constant (évite les attaques par timing). */
function tokenOk(candidate) {
  if (!TOKEN) return true; // pas de jeton configuré (mode local) → tout passe
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vérifie l'en-tête Authorization: Bearer <TOKEN> sur les routes /api/li/*. */
function apiAuthed(req) {
  if (!TOKEN) return true;
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? tokenOk(m[1]) : false;
}

/** Décide de la réponse à /api/li/next. null = rien à servir (file vide). */
function nextDecision() {
  const now = Date.now();
  if (!enabled) return { reason: "Extension en pause" };
  if (pausedUntil > now) {
    return { wait: Math.ceil((pausedUntil - now) / 1000), reason: "Pause de sécurité après échec" };
  }
  if (!queue.length) return null;
  if (breakUntil > now) {
    return { wait: Math.ceil((breakUntil - now) / 1000), reason: "Micro-pause (rythme humain)" };
  }
  const gapEnd = lastActionAt + nextGapMs;
  if (gapEnd > now) {
    return { wait: Math.ceil((gapEnd - now) / 1000), reason: "Délai anti-détection entre deux actions" };
  }
  // On sert la première action *éligible*, pas forcément la tête de file : une
  // lecture ne doit pas rester bloquée derrière un envoi qui attend l'ouverture
  // de la plage horaire. Si rien n'est éligible, on renvoie l'attente la plus
  // courte pour que l'extension repasse au bon moment.
  let blocked = null;
  for (let i = 0; i < queue.length; i++) {
    const veto = activeWindowCheck(queue[i].type) || hourlyCheck(queue[i].type, now);
    if (veto) {
      if (!blocked || veto.wait < blocked.wait) blocked = veto;
      continue;
    }
    const [action] = queue.splice(i, 1);
    inFlight.set(action.id, { action, servedAt: now });
    return { action };
  }
  return blocked;
}

// --- Transport MCP distant (Streamable HTTP), utilisé en mode http ------------
// Une session MCP par client, mais toutes partagent la file/les compteurs (état
// au niveau module) — donc plusieurs McpServer manipulent la même file.
const mcpTransports = new Map(); // sessionId -> transport
const MCP_PATH = TOKEN ? `/mcp/${TOKEN}` : "/mcp";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function handleMcpHttp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? mcpTransports.get(sessionId) : undefined;
  const body = req.method === "POST" ? await readBody(req) : undefined;

  if (!transport) {
    if (req.method === "POST" && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => mcpTransports.set(sid, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpTransports.delete(transport.sessionId);
      };
      const server = buildMcpServer();
      await server.connect(transport);
    } else {
      return json(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session MCP absente ou invalide" },
        id: null,
      });
    }
  }
  await transport.handleRequest(req, res, body);
}

const http = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "OPTIONS") return json(res, 204, {});

  // Connecteur MCP distant (Cowork) — mode http uniquement, chemin secret
  if (TRANSPORT === "http" && url.pathname === MCP_PATH) {
    handleMcpHttp(req, res).catch((e) => {
      console.error("[linkedin-mcp] erreur MCP HTTP:", e.message);
      if (!res.headersSent) json(res, 500, { error: "erreur interne MCP" });
    });
    return;
  }

  // À partir d'ici : routes /api/li/* réservées à l'extension → auth requise
  if (url.pathname.startsWith("/api/li/") && !apiAuthed(req)) {
    return json(res, 401, { error: "jeton d'accès manquant ou invalide" });
  }

  if (req.method === "GET" && url.pathname === "/api/li/next") {
    lastPollAt = Date.now();
    const decision = nextDecision();
    if (decision) return json(res, 200, decision);
    // File vide : long-poll (l'extension patiente, la latence d'envoi devient ~0)
    const holdMs = Math.min(Number(url.searchParams.get("wait") || 0), 25_000);
    if (!holdMs) return json(res, 200, { reason: "File vide" });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      lastPollAt = Date.now();
      const d = nextDecision();
      json(res, 200, d || { reason: "File vide" });
    };
    const timer = setTimeout(finish, holdMs);
    nextWaiters.push(() => {
      clearTimeout(timer);
      finish();
    });
    req.on("close", () => {
      done = true;
      clearTimeout(timer);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/li/result") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const { id, ok, error, data } = JSON.parse(raw || "{}");
        const flight = inFlight.get(id);
        if (flight) {
          inFlight.delete(id);
          recordResult(flight.action, !!ok, error, data);
        }
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { error: "JSON invalide" });
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/li/status") {
    lastPollAt = Math.max(lastPollAt, Date.now() - 44_000); // le popup compte comme un contact léger
    const s = statusSnapshot();
    // format attendu par le popup (hérité de Sequence Mail)
    return json(res, 200, {
      ...s,
      within_window: true,
      queue: { ...s.queue, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/li/toggle") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        enabled = JSON.parse(raw || "{}").enabled !== false;
        if (enabled) notifyExtension();
        json(res, 200, { enabled });
      } catch {
        json(res, 400, { error: "JSON invalide" });
      }
    });
    return;
  }

  json(res, 404, { error: "introuvable" });
});

let httpReady = false;
let bindRetryTimer = null;
http.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Port occupé (session précédente encore ouverte ?) : on réessaie en boucle
    // pour récupérer le port dès qu'il se libère, sans redémarrer la session.
    if (!bindRetryTimer) {
      console.error(`[linkedin-mcp] port ${PORT} occupé (autre session ?) — nouvelle tentative toutes les 5 s`);
      bindRetryTimer = setInterval(() => http.listen(PORT, BIND), 5_000);
    }
    return;
  }
  console.error(`[linkedin-mcp] serveur HTTP indisponible sur le port ${PORT}: ${e.message}`);
});
http.listen(PORT, BIND, () => {
  httpReady = true;
  if (bindRetryTimer) {
    clearInterval(bindRetryTimer);
    bindRetryTimer = null;
  }
  console.error(`[linkedin-mcp] serveur HTTP prêt sur http://${BIND}:${PORT}`);
  if (TRANSPORT === "http") console.error(`[linkedin-mcp] endpoint MCP distant : ${MCP_PATH}`);
});

// --- Outils MCP ---------------------------------------------------------------
function requireHttp() {
  if (!httpReady) {
    throw new Error(
      `Le serveur HTTP local (port ${PORT}) n'a pas pu démarrer — probablement occupé par une autre session. Fermez l'autre session (le port sera repris automatiquement en ~5 s) ou changez LI_MCP_PORT.`
    );
  }
}

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

/** Résout la cible d'un message/lecture : conversation ouverte à l'écran (le plus
 *  fiable), nom de conversation, profil (/in/...) ou fil (/messaging/thread/...).
 *  Un seul à la fois. */
function resolveTarget({ use_open_conversation, conversation_name, profile_url, thread_url }) {
  const given = [use_open_conversation, conversation_name, profile_url, thread_url].filter(Boolean).length;
  if (given > 1) {
    throw new Error("Fournir UNE seule cible : use_open_conversation, conversation_name, profile_url ou thread_url.");
  }
  if (use_open_conversation) {
    return { open: true, label: "la conversation actuellement ouverte à l'écran" };
  }
  if (conversation_name) {
    return { conv_name: conversation_name, label: `conversation « ${conversation_name} »` };
  }
  if (thread_url) {
    if (!/linkedin\.com\/messaging\/thread\//i.test(thread_url)) {
      throw new Error("thread_url doit être un fil LinkedIn (https://www.linkedin.com/messaging/thread/...).");
    }
    return { thread: thread_url, label: thread_url };
  }
  if (profile_url) {
    if (!/linkedin\.com\/in\//i.test(profile_url)) {
      throw new Error("profile_url doit être un profil LinkedIn (https://www.linkedin.com/in/...).");
    }
    return { profile: profile_url, label: profile_url };
  }
  throw new Error(
    "Cible manquante : fournir conversation_name (nom exact vu dans linkedin_list_conversations) pour répondre dans une conversation existante, ou profile_url (/in/...) pour un nouveau contact."
  );
}

function describeOutcome(action, result, verb) {
  if (result === null) {
    return text(
      `⏳ ${verb} mis en file (id ${action.id}) mais pas encore confirmé après ${TOOL_WAIT_S}s — ` +
        (extensionConnected()
          ? "un délai anti-détection ou une pause de sécurité est probablement en cours."
          : "l'extension Chrome ne semble PAS connectée (onglet Chrome ouvert ? extension chargée et activée ?).") +
        ` Utilisez linkedin_status pour suivre le résultat.`
    );
  }
  const dest = action.linkedin || action.thread || (action.open ? "la conversation ouverte" : action.conv_name ? `« ${action.conv_name} »` : "?");
  if (result.ok) {
    const note = result.error ? ` (note : ${result.error})` : "";
    return text(`✅ ${verb} envoyé avec succès à ${dest}${note}. Quotas du jour : ${counters.invite}/${CAP_INVITE} invitations, ${counters.message}/${CAP_MESSAGE} messages.`);
  }
  if (/\(404\)/.test(result.error || "")) {
    return text(`❌ ${verb} impossible : ${result.error}. Vérifiez l'URL — aucune pause de sécurité appliquée (page inexistante, pas un signal de détection).`);
  }
  return text(
    `❌ Échec de l'envoi vers ${dest} : ${result.error || "erreur inconnue"}. ` +
      `Une pause de sécurité est appliquée${pausedUntil > Date.now() ? ` jusqu'à ${new Date(pausedUntil).toLocaleTimeString("fr-FR")}` : ""}.`
  );
}

/** Crée un serveur MCP avec tous les outils. Chaque session HTTP en instancie
 *  un ; tous partagent la file et les compteurs (état au niveau module). */
function buildMcpServer() {
  const mcp = new McpServer({ name: "linkedin", version: "0.1.0" });

mcp.registerTool(
  "linkedin_send_message",
  {
    title: "Envoyer un message LinkedIn",
    description:
      "Envoie un message LinkedIn, via l'extension Chrome connectée à la session de l'utilisateur. " +
      "Cible (UNE seule) : conversation_name pour répondre dans une conversation existante — l'extension va sur la messagerie, ouvre la conversation par son nom (aucune URL, aucune action de l'utilisateur), et vérifie que le bon fil est ouvert avant d'écrire ; ou use_open_conversation=true (conversation déjà ouverte à l'écran) ; ou profile_url (/in/...) pour un nouveau contact ; ou thread_url (/messaging/thread/...). " +
      "⚠️ LinkedIn ne délivre les messages qu'aux relations de 1er niveau ; pour un inconnu, envoyer d'abord une invitation. " +
      "L'envoi respecte des quotas journaliers et un délai aléatoire anti-détection : le résultat peut prendre une à deux minutes.",
    inputSchema: {
      conversation_name: z.string().min(1).optional().describe("Nom exact du contact vu dans linkedin_list_conversations, ex. « Sean Gur ». L'extension ouvre la conversation elle-même, sans URL ni action de l'utilisateur."),
      use_open_conversation: z.boolean().optional().describe("true = répondre dans la conversation actuellement ouverte à l'écran. Aucune navigation."),
      profile_url: z.string().url().optional().describe("URL du profil LinkedIn, ex. https://www.linkedin.com/in/jean-dupont/"),
      thread_url: z.string().url().optional().describe("URL d'un fil de discussion existant, ex. https://www.linkedin.com/messaging/thread/xxxx/"),
      message: z.string().min(1).max(8000).describe("Texte du message à envoyer"),
    },
  },
  async ({ conversation_name, use_open_conversation, profile_url, thread_url, message }) => {
    requireHttp();
    const t = resolveTarget({ use_open_conversation, conversation_name, profile_url, thread_url });
    const action = t.conv_name
      ? enqueue("message", null, message, { conv_name: t.conv_name })
      : t.open
      ? enqueue("message", null, message, { open: true })
      : t.thread
      ? enqueue("message", null, message, { thread: t.thread })
      : enqueue("message", t.profile, message);
    const result = await waitForResult(action.id);
    return describeOutcome(action, result, "Message");
  }
);

mcp.registerTool(
  "linkedin_send_invitation",
  {
    title: "Envoyer une invitation LinkedIn",
    description:
      "Envoie une invitation de connexion LinkedIn à un profil (URL /in/...), avec note optionnelle (max 200 caractères), via l'extension Chrome. " +
      "Respecte des quotas journaliers et un délai aléatoire anti-détection.",
    inputSchema: {
      profile_url: z.string().url().describe("URL du profil LinkedIn, ex. https://www.linkedin.com/in/jean-dupont/"),
      note: z.string().max(200).optional().describe("Note d'invitation optionnelle (200 caractères max)"),
    },
  },
  async ({ profile_url, note }) => {
    requireHttp();
    if (!/linkedin\.com\/in\//i.test(profile_url)) {
      throw new Error("L'URL doit être un profil LinkedIn (https://www.linkedin.com/in/...).");
    }
    const action = enqueue("invite", profile_url, note || "");
    const result = await waitForResult(action.id);
    return describeOutcome(action, result, "Invitation");
  }
);

function describeReadOutcome(action, result, what) {
  if (result === null) {
    return text(
      `⏳ Lecture (${what}) mise en file (id ${action.id}) mais pas encore terminée après ${TOOL_WAIT_S}s — ` +
        (extensionConnected()
          ? "une pause de sécurité ou une action précédente est probablement en cours."
          : "l'extension Chrome ne semble PAS connectée (onglet Chrome ouvert ? extension chargée et activée ?).") +
        ` Récupérez le résultat avec linkedin_status result_id="${action.id}" plutôt que de relancer la lecture.`
    );
  }
  // JSON compact (pas de pretty-print) : l'indentation coûtait ~30 % de tokens en plus.
  if (result.ok) return text(JSON.stringify(result.data));
  if (/\(404\)/.test(result.error || "")) {
    return text(`❌ Lecture impossible (${what}) : ${result.error}. Vérifiez l'URL — aucune pause de sécurité appliquée.`);
  }
  return text(`❌ Échec de la lecture (${what}) : ${result.error || "erreur inconnue"}.`);
}

mcp.registerTool(
  "linkedin_read_messages",
  {
    title: "Lire une conversation LinkedIn",
    description:
      "Lit les derniers messages d'une conversation LinkedIn, via l'extension Chrome. " +
      "Cible (UNE seule) : use_open_conversation=true (la conversation ouverte à l'écran, sans URL ni nom), ou profile_url (/in/...), ou thread_url (/messaging/thread/...). " +
      "Retourne un JSON { messages: [{ sender, time, text }] } du plus ancien au plus récent.",
    inputSchema: {
      conversation_name: z.string().min(1).optional().describe("Nom exact du contact vu dans linkedin_list_conversations, ex. « Sean Gur ». L'extension ouvre la conversation elle-même."),
      use_open_conversation: z.boolean().optional().describe("true = lire la conversation actuellement ouverte à l'écran. Aucune navigation."),
      profile_url: z.string().url().optional().describe("URL du profil LinkedIn, ex. https://www.linkedin.com/in/jean-dupont/"),
      thread_url: z.string().url().optional().describe("URL d'un fil de discussion existant, ex. https://www.linkedin.com/messaging/thread/xxxx/"),
      limit: z.number().int().min(1).max(100).optional().describe("Nombre max de messages à retourner (défaut 25)"),
    },
  },
  async ({ conversation_name, use_open_conversation, profile_url, thread_url, limit }) => {
    requireHttp();
    const t = resolveTarget({ use_open_conversation, conversation_name, profile_url, thread_url });
    const action = t.conv_name
      ? enqueue("read_messages", null, "", { conv_name: t.conv_name, limit: limit || 25 })
      : t.open
      ? enqueue("read_messages", null, "", { open: true, limit: limit || 25 })
      : t.thread
      ? enqueue("read_messages", null, "", { thread: t.thread, limit: limit || 25 })
      : enqueue("read_messages", t.profile, "", { limit: limit || 25 });
    const result = await waitForResult(action.id);
    return describeReadOutcome(action, result, t.label);
  }
);

mcp.registerTool(
  "linkedin_list_conversations",
  {
    title: "Lister les conversations LinkedIn",
    description:
      "Liste les conversations récentes de la messagerie LinkedIn (nom, dernier message, date, non-lu), via l'extension Chrome. " +
      "Retourne un JSON { conversations: [{ name, snippet, time, unread }] }. " +
      "Pour lire le contenu complet d'une conversation, utiliser ensuite linkedin_read_messages avec l'URL du profil.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("Nombre max de conversations à retourner (défaut 15)"),
    },
  },
  async ({ limit }) => {
    requireHttp();
    const action = enqueue("list_conversations", null, "", { limit: limit || 15 });
    const result = await waitForResult(action.id);
    return describeReadOutcome(action, result, "messagerie");
  }
);

mcp.registerTool(
  "linkedin_view_profile",
  {
    title: "Voir un ou plusieurs profils LinkedIn",
    description:
      "Ouvre un ou plusieurs profils LinkedIn (/in/...) via l'extension Chrome et extrait les informations visibles : " +
      "nom, titre, localisation, niveau de relation, à propos, expériences, formation. " +
      `Accepte une LISTE d'URL (profile_urls, jusqu'à ${MAX_PROFILES_PER_CALL}) — préférez un seul appel avec toutes les URL ` +
      "plutôt qu'un appel par profil : les profils sont lus l'un après l'autre (délai anti-détection) et le résultat est rendu en une fois. " +
      "Retourne un JSON { profiles: [{ url, profile }], errors: [{ url, error }], pending: [{ url, id }] }. " +
      `La visite de profil est l'action la plus surveillée par LinkedIn : elle est plafonnée à ${CAP_VIEW}/jour ` +
      `et ${CAP_HOUR_VIEW}/heure, avec un délai de ${VIEW_MIN_GAP_S}–${VIEW_MAX_GAP_S} s entre deux profils. ` +
      "N'enchaînez pas les appels en boucle : consultez linkedin_status si les lectures restent en attente.",
    inputSchema: {
      profile_urls: z
        .array(z.string().url())
        .min(1)
        .max(MAX_PROFILES_PER_CALL)
        .optional()
        .describe(`Liste d'URL de profils LinkedIn (max ${MAX_PROFILES_PER_CALL}), ex. ["https://www.linkedin.com/in/jean-dupont/", "https://www.linkedin.com/in/marie-martin/"]`),
      profile_url: z
        .string()
        .url()
        .optional()
        .describe("URL d'un seul profil (raccourci équivalent à profile_urls avec une seule entrée)."),
      collect_ids: z
        .array(z.string())
        .optional()
        .describe(
          "Récupère le résultat de lectures déjà mises en file : passez les id rendus dans « pending » par un appel précédent. " +
            "N'ouvre AUCUNE nouvelle page et ne consomme aucun quota. À utiliser au lieu de relancer les mêmes URL."
        ),
    },
  },
  async ({ profile_urls, profile_url, collect_ids }) => {
    requireHttp();

    // Mode récupération : les lectures en file avec de longs délais dépassent
    // souvent l'attente d'un seul appel. Plutôt que de relire les profils (et
    // de doubler l'exposition), on relit le résultat déjà enregistré.
    if (collect_ids?.length) {
      const profiles = [], errors = [], pending = [];
      const collected = await Promise.all(
        collect_ids.map(async (id) => {
          const stored = findResult(id);
          if (stored) return { id, result: stored };
          if (!queue.some((a) => a.id === id) && !inFlight.has(id)) return { id, result: undefined };
          return { id, result: await waitForResult(id, TOOL_WAIT_S) };
        })
      );
      for (const { id, result } of collected) {
        if (result === undefined) errors.push({ id, error: "id inconnu (résultat trop ancien ou jamais mis en file)" });
        else if (result === null) pending.push({ id });
        else if (result.ok) profiles.push({ url: result.target, ...(result.data || {}) });
        else errors.push({ url: result.target, id, error: result.error || "erreur inconnue" });
      }
      return text(JSON.stringify({ profiles, errors, pending }));
    }

    // Dédoublonnage : deux fois la même URL = deux ouvertures de page pour rien.
    const urls = [...new Set([...(profile_urls || []), ...(profile_url ? [profile_url] : [])])];
    if (!urls.length) throw new Error("Fournissez profile_urls (liste d'URL), profile_url (une seule URL) ou collect_ids.");
    if (urls.length > MAX_PROFILES_PER_CALL) {
      throw new Error(`Trop de profils (${urls.length}) : maximum ${MAX_PROFILES_PER_CALL} par appel.`);
    }

    // Une URL invalide ne fait pas échouer tout le lot : elle est rendue en erreur.
    const errors = [];
    const valid = [];
    for (const url of urls) {
      if (/linkedin\.com\/in\//i.test(url)) valid.push(url);
      else errors.push({ url, error: "l'URL doit être un profil LinkedIn (https://www.linkedin.com/in/...)" });
    }
    if (!valid.length) return text(JSON.stringify({ profiles: [], errors, pending: [] }));

    const actions = valid.map((url) => ({ url, action: enqueue("view_profile", url, "") }));
    // Les lectures sont séquentielles : l'attente grandit avec la taille du lot.
    const waitS = Math.min(BATCH_WAIT_S, TOOL_WAIT_S * actions.length);
    const outcomes = await Promise.all(actions.map(({ action }) => waitForResult(action.id, waitS)));

    const profiles = [];
    const pending = [];
    outcomes.forEach((result, i) => {
      const { url, action } = actions[i];
      if (result === null) pending.push({ url, id: action.id });
      else if (result.ok) profiles.push({ url, ...(result.data || {}) });
      else errors.push({ url, error: result.error || "erreur inconnue" });
    });

    if (!profiles.length && !errors.length && pending.length) {
      return text(
        `⏳ ${pending.length} lecture(s) de profil en file mais pas encore terminée(s) après ${waitS}s — ` +
          (extensionConnected()
            ? "une pause de sécurité ou une action précédente est probablement en cours."
            : "l'extension Chrome ne semble PAS connectée (onglet Chrome ouvert ? extension chargée et activée ?).") +
          ` Vérifiez avec linkedin_status, puis récupérez le résultat avec collect_ids=${JSON.stringify(pending.map((p) => p.id))} ` +
          `— ne relancez PAS les mêmes URL, elles seraient rouvertes une seconde fois.`
      );
    }
    // JSON compact (pas de pretty-print) : l'indentation coûtait ~30 % de tokens en plus.
    return text(JSON.stringify({ profiles, errors, pending }));
  }
);

mcp.registerTool(
  "linkedin_status",
  {
    title: "État LinkedIn (extension, quotas, file)",
    description:
      "État du pont LinkedIn : extension Chrome connectée ou non, quotas du jour et de la dernière heure, actions en file, " +
      "pause de sécurité ou micro-pause en cours, plage horaire d'activité, et derniers résultats. " +
      "Avec result_id, rend le contenu complet d'une lecture rendue « en attente » par un appel précédent — " +
      "à préférer systématiquement à une relance de la même lecture, qui rouvrirait la page pour rien.",
    inputSchema: {
      result_id: z
        .string()
        .optional()
        .describe("Id d'une action rendue « en file / pas encore terminée » : renvoie son résultat complet s'il est arrivé depuis."),
    },
  },
  async ({ result_id }) => {
    if (result_id) {
      const stored = findResult(result_id);
      if (stored) return text(JSON.stringify(stored));
      const waiting = queue.some((a) => a.id === result_id) || inFlight.has(result_id);
      return text(
        waiting
          ? `⏳ L'action ${result_id} est toujours en file (délai anti-détection ou micro-pause). Rappelez linkedin_status avec le même result_id dans quelques minutes.`
          : `❌ Id ${result_id} inconnu : résultat trop ancien (seuls les 50 derniers sont gardés) ou jamais mis en file.`
      );
    }
    return text(JSON.stringify(statusSnapshot()));
  }
);

mcp.registerTool(
  "linkedin_cancel",
  {
    title: "Vider la file LinkedIn",
    description: "Annule toutes les actions LinkedIn encore en file (celles déjà en cours d'exécution ne sont pas interrompues).",
    inputSchema: {},
  },
  async () => {
    const cancelled = queue.splice(0, queue.length);
    for (const a of cancelled) {
      const resolve = waiters.get(a.id);
      if (resolve) {
        waiters.delete(a.id);
        resolve({ id: a.id, ok: false, error: "annulée" });
      }
    }
    return text(`${cancelled.length} action(s) annulée(s). ${inFlight.size} action(s) déjà en cours non interrompue(s).`);
  }
);

  return mcp;
}

// --- Démarrage du transport MCP ----------------------------------------------
if (TRANSPORT === "http") {
  // Mode VM / Cowork : le MCP est servi en Streamable HTTP par le serveur HTTP
  // ci-dessus (voir handleMcpHttp). Pas de stdio. Le jeton est obligatoire.
  if (!TOKEN) {
    console.error("[linkedin-mcp] ERREUR : LI_TRANSPORT=http exige LI_TOKEN (jeton secret). Arrêt.");
    process.exit(1);
  }
  console.error("[linkedin-mcp] mode HTTP distant : ajoutez ce serveur comme connecteur MCP dans Claude/Cowork.");
} else {
  // Mode local (Claude Code) : MCP sur stdio.
  const transport = new StdioServerTransport();
  await buildMcpServer().connect(transport);
  console.error("[linkedin-mcp] serveur MCP connecté (stdio)");
}
