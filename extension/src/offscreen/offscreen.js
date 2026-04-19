/**
 * offscreen/offscreen.js — offscreen document for clipboard and DOM parsing.
 *
 * Listens for { target: "offscreen", type: ... } messages from the service
 * worker and responds synchronously via sendResponse.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return

  ;(async () => {
    try {
      if (msg.type === "clipboard.read") {
        const text = await navigator.clipboard.readText()
        sendResponse({ ok: true, text })
        return
      }
      if (msg.type === "clipboard.write") {
        await navigator.clipboard.writeText(String(msg.text || ""))
        sendResponse({ ok: true })
        return
      }
      if (msg.type === "dom.parse") {
        const doc = new DOMParser().parseFromString(msg.html || "", msg.mimeType || "text/html")
        const text = doc.body?.innerText || doc.documentElement?.innerText || ""
        sendResponse({ ok: true, text, title: doc.title })
        return
      }
      sendResponse({ error: `Unknown offscreen type ${msg.type}`, code: "UNKNOWN_OP" })
    } catch (e) {
      sendResponse({ error: e.message, code: "OFFSCREEN_ERROR" })
    }
  })()
  return true
})
