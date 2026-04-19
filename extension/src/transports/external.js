/**
 * transports/external.js — handles:
 *   - chrome.runtime.onMessageExternal (from allow-listed extensions)
 *   - chrome.runtime.onConnectExternal (persistent ports)
 *   - chrome.runtime.onMessage         (from own pages: popup, options, content)
 *
 * All roads lead to the same tool router.
 */

import { createLogger } from "../core/logger.js"
import { asError } from "../core/errors.js"

const log = createLogger("external")

export function attach({ router }) {
  // Internal (popup, options, content script).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return
    if (msg.target === "offscreen") return // offscreen handles itself
    if (!msg.method && !msg.tool && !msg.type?.startsWith("rpc")) return

    const method = msg.method || msg.tool
    const params = msg.params || msg.args || msg.payload || {}
    const ctx = { transport: "internal", sender, tabId: sender?.tab?.id }

    router
      .invoke(method, params, ctx)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => {
        const err = asError(e)
        sendResponse({ ok: false, error: { code: err.code || "INTERNAL", message: err.message, details: err.details } })
      })
    return true // async
  })

  // External single-shot (from other extensions / web pages in externally_connectable).
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (!msg?.method && !msg?.tool) return
    const method = msg.method || msg.tool
    const params = msg.params || msg.args || {}
    const ctx = {
      transport: "external",
      origin: sender.origin || sender.url,
      extensionId: sender.id,
    }
    log.debug(`external rpc ${method} from ${ctx.origin || ctx.extensionId}`)
    router
      .invoke(method, params, ctx)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => {
        const err = asError(e)
        sendResponse({ ok: false, error: { code: err.code || "INTERNAL", message: err.message, details: err.details } })
      })
    return true
  })

  // External persistent port: each message is one RPC frame.
  chrome.runtime.onConnectExternal.addListener((port) => {
    log.info(`external port connected: ${port.name} from ${port.sender?.origin || port.sender?.id}`)
    const ctx = {
      transport: "external-port",
      origin: port.sender?.origin || port.sender?.url,
      extensionId: port.sender?.id,
      portName: port.name,
    }
    port.onMessage.addListener(async (msg) => {
      if (!msg?.id || !(msg.method || msg.tool)) return
      const method = msg.method || msg.tool
      const params = msg.params || msg.args || {}
      const start = Date.now()
      try {
        const result = await router.invoke(method, params, ctx)
        port.postMessage({ id: msg.id, ok: true, result, durationMs: Date.now() - start })
      } catch (e) {
        const err = asError(e)
        port.postMessage({
          id: msg.id,
          ok: false,
          error: { code: err.code || "INTERNAL", message: err.message, details: err.details },
          durationMs: Date.now() - start,
        })
      }
    })
    port.onDisconnect.addListener(() => log.debug("external port disconnected"))
  })
}
