#!/usr/bin/env node
/*
 * Serveur MCP LinkedIn — adapté de l'app Sequence Mail (Ruby/prospection).
 *
 * Deux faces :
 *  1. MCP  : Claude appelle linkedin_send_message / _send_invitation /
 *            _read_messages / _list_conversations / _status / _cancel. Chaque
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
const MIN_GAP_S = Number(process.env.LI_MIN_GAP_S || 45);     // délai mini entre 2 actions
const MAX_GAP_S = Number(process.env.LI_MAX_GAP_S || 120);    // délai maxi
const FAIL_PAUSE_MIN = Number(process.env.LI_FAIL_PAUSE_MIN || 10);       // pause après échec simple
const CHECKPOINT_PAUSE_MIN = Number(process.env.LI_CHECKPOINT_PAUSE_MIN || 60); // pause après captcha/checkpoint
const TOOL_WAIT_S = Number(process.env.LI_TOOL_WAIT_S || 90); // attente max du résultat côté outil MCP
const INFLIGHT_TIMEOUT_S = 300; // action servie mais jamais confirmée → échec

// Les baisser est sûr ; les gonfler augmente le risque de restriction du compte.

// --- État persistant (compteurs du jour) --------------------------------------
const DATA_DIR = join(__dirname, "data");
const STATE_FILE = join(DATA_DIR, "state.json");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (s.date === today()) return s;
  } catch {}
  return { date: today(), invite: 0, message: 0 };
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
    counters = { date: today(), invite: 0, message: 0 };
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

const rand = (a, b) => a + Math.random() * (b - a);

// Types d'action : les envois comptent dans les quotas et imposent le grand
// délai anti-détection ; les lectures sont plus légères (pas de quota, délai
// court) mais restent séquentielles et déclenchent la pause en cas de captcha.
const SEND_TYPES = new Set(["invite", "message"]);

function extensionConnected() {
  return Date.now() - lastPollAt < 45_000;
}

function capFor(type) {
  return type === "invite" ? CAP_INVITE : CAP_MESSAGE;
}

function notifyExtension() {
  const ws = nextWaiters;
  nextWaiters = [];
  for (const w of ws) w();
}

function recordResult(action, ok, error, data) {
  rollDay();
  const isSend = SEND_TYPES.has(action.type);
  if (ok && isSend) {
    counters[action.type] = (counters[action.type] || 0) + 1;
    saveState();
  }
  lastActionAt = Date.now();
  nextGapMs = isSend ? rand(MIN_GAP_S, MAX_GAP_S) * 1000 : rand(5, 15) * 1000;
  if (!ok) {
    const critical = /checkpoint|captcha|challenge|contrôle de sécurité/i.test(error || "");
    const pauseMin = critical ? CHECKPOINT_PAUSE_MIN : isSend ? FAIL_PAUSE_MIN : 1;
    pausedUntil = Date.now() + pauseMin * 60_000;
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
  if (SEND_TYPES.has(type)) {
    if (counters[type] >= capFor(type)) {
      throw new Error(
        `Plafond journalier atteint pour "${type}" (${counters[type]}/${capFor(type)}). Réessayez demain ou augmentez LI_CAP_${type.toUpperCase()} (déconseillé).`
      );
    }
    const pendingSameType = queue.filter((a) => a.type === type).length;
    if (counters[type] + pendingSameType >= capFor(type)) {
      throw new Error(`La file contient déjà assez d'actions "${type}" pour atteindre le plafond journalier.`);
    }
  }
  const action = {
    id: randomUUID(),
    type, // "invite" | "message" | "read_messages" | "list_conversations"
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
    },
    queue: {
      pending: queue.length + inFlight.size,
      items: [...queue, ...[...inFlight.values()].map((f) => f.action)].map((a) => ({
        id: a.id, type: a.type, target: a.linkedin || a.thread || a.conv_name || null,
      })),
    },
    safety_pause_until: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
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
  const gapEnd = lastActionAt + nextGapMs;
  if (gapEnd > now) {
    return { wait: Math.ceil((gapEnd - now) / 1000), reason: "Délai anti-détection entre deux actions" };
  }
  const action = queue.shift();
  inFlight.set(action.id, { action, servedAt: now });
  return { action };
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
http.on("error", (e) => {
  console.error(`[linkedin-mcp] serveur HTTP indisponible sur le port ${PORT}: ${e.message}`);
  console.error("[linkedin-mcp] (le port est peut-être déjà occupé — changez LI_MCP_PORT)");
});
http.listen(PORT, BIND, () => {
  httpReady = true;
  console.error(`[linkedin-mcp] serveur HTTP prêt sur http://${BIND}:${PORT}`);
  if (TRANSPORT === "http") console.error(`[linkedin-mcp] endpoint MCP distant : ${MCP_PATH}`);
});

// --- Outils MCP ---------------------------------------------------------------
function requireHttp() {
  if (!httpReady) {
    throw new Error(
      `Le serveur HTTP local (port ${PORT}) n'a pas pu démarrer — probablement occupé par une autre session. Fermez l'autre session ou changez LI_MCP_PORT.`
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
        ` Utilisez linkedin_status pour vérifier.`
    );
  }
  if (result.ok) return text(JSON.stringify(result.data, null, 2));
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
  "linkedin_status",
  {
    title: "État LinkedIn (extension, quotas, file)",
    description:
      "État du pont LinkedIn : extension Chrome connectée ou non, quotas du jour, actions en file, pause de sécurité éventuelle, et derniers résultats.",
    inputSchema: {},
  },
  async () => text(JSON.stringify(statusSnapshot(), null, 2))
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
