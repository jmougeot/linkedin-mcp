/* Popup : montre l'état (dernier tick de fond + quotas du serveur MCP) et permet
 * d'activer/mettre en pause l'extension. La pause stoppe toute action locale. */
const DEFAULT_SERVER = "http://127.0.0.1:3210"; // serveur MCP local (réglable ci-dessous)

async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

async function authHeaders() {
  const { token } = await chrome.storage.local.get("token");
  return token ? { authorization: "Bearer " + token } : {};
}

async function refresh() {
  const SERVER = await getServer();
  const { enabled, lastStatus, token } = await chrome.storage.local.get(["enabled", "lastStatus", "token"]);
  if (document.activeElement !== document.getElementById("server")) {
    document.getElementById("server").value = SERVER;
  }
  if (document.activeElement !== document.getElementById("token")) {
    document.getElementById("token").value = token || "";
  }
  const on = enabled !== false;
  document.getElementById("toggle").textContent = on ? "Mettre en pause" : "Activer";

  const s = lastStatus || { kind: on ? "idle" : "off", text: on ? "En attente du prochain tick…" : "En pause" };
  document.getElementById("dot").className = "dot " + (on ? s.kind : "off");
  document.getElementById("statusText").textContent = on ? s.text : "En pause";

  // Quotas du jour, lus côté serveur
  try {
    const r = await fetch(`${SERVER}/api/li/status`, { headers: await authHeaders() });
    if (r.status === 401) {
      document.getElementById("stat").innerHTML = "";
      document.getElementById("sub").textContent = "Accès refusé (401) — jeton manquant ou incorrect.";
      return;
    }
    const st = await r.json();
    document.getElementById("stat").innerHTML =
      `<div><b>${st.today.invite.sent}/${st.today.invite.cap}</b>invitations</div>` +
      `<div><b>${st.today.message.sent}/${st.today.message.cap}</b>messages</div>` +
      `<div><b>${st.queue.pending}</b>en file</div>`;
    document.getElementById("sub").textContent = st.safety_pause_until
      ? `Pause de sécurité jusqu'à ${new Date(st.safety_pause_until).toLocaleTimeString("fr-FR")}`
      : `${st.queue.sent} envoyée(s) · ${st.queue.failed} échec(s)`;
  } catch {
    document.getElementById("stat").innerHTML = "";
    document.getElementById("sub").textContent = `Serveur MCP injoignable (${SERVER}). Ouvrez une session Claude dans le projet Linkedin_mcp.`;
  }
}

document.getElementById("toggle").addEventListener("click", async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  const next = enabled === false; // on inverse
  await chrome.storage.local.set({ enabled: next });
  // informe aussi le serveur (cohérence de l'état affiché côté Claude)
  fetch(`${await getServer()}/api/li/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ enabled: next }),
  }).catch(() => {});
  refresh();
});

// Enregistre l'adresse du serveur (VM : https://votre-domaine ; local : http://127.0.0.1:3210)
document.getElementById("saveServer").addEventListener("click", async () => {
  const v = document.getElementById("server").value.trim();
  await chrome.storage.local.set({ server: v || DEFAULT_SERVER });
  refresh();
});

// Enregistre le jeton d'accès (mode VM ; laisser vide en local)
document.getElementById("saveToken").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: document.getElementById("token").value.trim() });
  refresh();
});

refresh();
setInterval(refresh, 3000);
