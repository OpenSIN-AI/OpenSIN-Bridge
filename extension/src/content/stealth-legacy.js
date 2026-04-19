/**
 * content/stealth-main.js — runs in the MAIN world at document_start.
 *
 * Applies deterministic, signature-free primitive shims (no-op when already
 * applied). Everything is idempotent and additive — nothing here ever breaks
 * page functionality.
 *
 * IMPORTANT: MAIN-world scripts cannot use chrome.* APIs. They communicate
 * with the isolated world via window.postMessage using a private channel.
 */

;(() => {
  const FLAG = "__opensin_stealth__"
  if (window[FLAG]) return
  Object.defineProperty(window, FLAG, { value: true, configurable: false, enumerable: false, writable: false })

  const CHANNEL = "__OPENSIN_BRIDGE__"

  // ---- 1. Webdriver flag hygiene (navigator.webdriver is often read-only in
  // modern Chrome; we attempt a safe override and swallow errors so page
  // scripts don't see SecurityError on their own attempts).
  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver")
    if (!desc || desc.configurable !== false) {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true })
    }
  } catch {}

  // ---- 2. Marker object for inter-world communication.
  // The isolated world can dispatch messages with { source: CHANNEL, kind, payload }
  // and main-world listeners here will react (and vice versa).

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return
    const msg = ev.data
    if (!msg || msg.source !== CHANNEL || msg.dir !== "main→page") return
    // Reserved for future page-facing hooks.
  })

  // Expose a tiny detection-hardening helper other content scripts can call
  // without touching chrome.* from page land.
  Object.defineProperty(window, "__opensin_ping__", {
    value: () => ({ alive: true, ts: Date.now() }),
    configurable: true,
    enumerable: false,
    writable: false,
  })
})()
