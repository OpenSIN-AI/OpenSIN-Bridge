/**
 * options/options.js — persists settings into chrome.storage.local. The
 * service worker re-reads config on next boot; transports also re-read when
 * restarted from the popup.
 */

const KEYS = [
  "wsUrl",
  "nativeHost",
  "autostartWs",
  "autostartNative",
  "heartbeatMs",
  "backoffMaxMs",
  "externallyAllowed",
  "visionProvider",
  "visionKey",
]

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:8765/bridge",
  nativeHost: "com.opensin.bridge",
  autostartWs: "true",
  autostartNative: "false",
  heartbeatMs: 25000,
  backoffMaxMs: 30000,
  externallyAllowed: "",
  visionProvider: "gateway",
  visionKey: "",
}

const $ = (sel) => document.querySelector(sel)

function parseList(text) {
  return (text || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function load() {
  const stored = await chrome.storage.local.get(KEYS.map((k) => `opensin:${k}`))
  for (const k of KEYS) {
    const v = stored[`opensin:${k}`]
    const el = $(`#${k}`)
    if (!el) continue
    if (k === "externallyAllowed") {
      el.value = Array.isArray(v) ? v.join("\n") : v ?? ""
    } else {
      el.value = v ?? DEFAULTS[k]
    }
  }
}

async function save(e) {
  e.preventDefault()
  const data = {}
  for (const k of KEYS) {
    const el = $(`#${k}`)
    if (!el) continue
    let v = el.value
    if (k === "autostartWs" || k === "autostartNative") v = v === "true"
    else if (k === "heartbeatMs" || k === "backoffMaxMs") v = Number(v)
    else if (k === "externallyAllowed") v = parseList(v)
    data[`opensin:${k}`] = v
  }
  await chrome.storage.local.set(data)
  const saved = $("#saved")
  saved.textContent = "saved"
  setTimeout(() => (saved.textContent = ""), 1500)
}

async function reset() {
  for (const k of KEYS) {
    const el = $(`#${k}`)
    if (!el) continue
    if (k === "externallyAllowed") el.value = ""
    else el.value = DEFAULTS[k]
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load()
  $("#form").addEventListener("submit", save)
  $("#reset").addEventListener("click", reset)
})
