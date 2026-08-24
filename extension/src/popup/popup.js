/**
 * popup/popup.js — small control surface. Talks to the service worker via
 * chrome.runtime.sendMessage using the same RPC envelope as external clients.
 */

async function rpc(method, params = {}) {
  const res = await chrome.runtime.sendMessage({ method, params })
  if (!res?.ok) throw new Error(res?.error?.message || "RPC failed")
  return res.result
}

const $ = (sel) => document.querySelector(sel)

const pillClass = {
  open: "pill pill-open",
  connecting: "pill pill-connecting",
  closed: "pill pill-closed",
  error: "pill pill-error",
  idle: "pill pill-idle",
}

async function refresh() {
  try {
    const [ver, caps, health] = await Promise.all([
      rpc("system.version"),
      rpc("system.capabilities"),
      rpc("system.health"),
    ])
    $("#version").textContent = `v${ver.bridge || ver.version}`
    $("#tool-count").textContent = `${caps.tools.length} tools`
    const list = $("#capability-list")
    list.innerHTML = ""
    for (const t of caps.tools.slice().sort()) {
      const el = document.createElement("span")
      el.className = "pill"
      el.textContent = t
      list.appendChild(el)
    }
    $("#client-id").textContent = health.clientId || "—"
    $("#ws-url").textContent = health.ws?.url || "—"
    setPill("#ws-status", health.ws?.status)
    setPill("#native-status", health.native?.status)
    setFooter(health)
  } catch (e) {
    setFooter({ ready: false, bootError: e.message })
  }
}

function setPill(sel, status) {
  const el = $(sel)
  el.className = pillClass[status] || pillClass.idle
  el.textContent = status || "idle"
}

function setFooter(health) {
  const dot = $("#health-dot")
  const text = $("#health-text")
  if (health?.ready) {
    dot.className = "dot ok"
    text.textContent = "ready"
  } else if (health?.bootError) {
    dot.className = "dot err"
    text.textContent = `error: ${health.bootError}`
  } else {
    dot.className = "dot warn"
    text.textContent = "starting…"
  }
}

document.addEventListener("DOMContentLoaded", () => {
  refresh()
  setInterval(refresh, 2000)

  $("#ws-start").addEventListener("click", () => rpc("transport.ws.start").then(refresh))
  $("#ws-stop").addEventListener("click", () => rpc("transport.ws.stop").then(refresh))
  $("#ws-reload").addEventListener("click", async () => {
    await rpc("transport.ws.stop")
    await rpc("transport.ws.start")
    refresh()
  })
  $("#native-start").addEventListener("click", () => rpc("transport.native.start").then(refresh))
  $("#native-stop").addEventListener("click", () => rpc("transport.native.stop").then(refresh))
  $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage())
})
