/**
 * tools/network.js — network observation and HTTP requests.
 *
 * Uses CDP Network domain for full request/response capture when a tab is
 * instrumented, and plain fetch() inside the service worker for one-off
 * requests with cookie jar access.
 */

import { invariant, BridgeError } from "../core/errors.js"
import * as CDP from "../drivers/cdp.js"
import * as Tabs from "../drivers/tabs.js"
import { createLogger } from "../core/logger.js"
import { nowMs, bindBus } from "../core/utils.js"

const log = createLogger("tools.network")

// tabId -> { events: RingBuffer }
const listeners = new Map()
const MAX_EVENTS = 500

function push(tabId, ev) {
  const buf = listeners.get(tabId)
  if (!buf) return
  buf.events.push(ev)
  while (buf.events.length > MAX_EVENTS) buf.events.shift()
  buf.bus.emit("event", ev)
}

async function ensureInstrumented(tabId) {
  if (listeners.has(tabId)) return
  await CDP.attach(tabId)
  await CDP.send(tabId, "Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 })

  const bus = bindBus()
  listeners.set(tabId, { events: [], bus })

  CDP.onEvent(tabId, "Network.requestWillBeSent", (p) => {
    push(tabId, {
      kind: "request",
      ts: nowMs(),
      requestId: p.requestId,
      loaderId: p.loaderId,
      frameId: p.frameId,
      documentURL: p.documentURL,
      type: p.type,
      request: {
        url: p.request.url,
        method: p.request.method,
        headers: p.request.headers,
        postData: p.request.postData,
      },
      initiator: p.initiator,
    })
  })
  CDP.onEvent(tabId, "Network.responseReceived", (p) => {
    push(tabId, {
      kind: "response",
      ts: nowMs(),
      requestId: p.requestId,
      frameId: p.frameId,
      type: p.type,
      response: {
        url: p.response.url,
        status: p.response.status,
        statusText: p.response.statusText,
        headers: p.response.headers,
        mimeType: p.response.mimeType,
        remoteIPAddress: p.response.remoteIPAddress,
        fromDiskCache: p.response.fromDiskCache,
        protocol: p.response.protocol,
      },
    })
  })
  CDP.onEvent(tabId, "Network.loadingFinished", (p) => {
    push(tabId, { kind: "finished", ts: nowMs(), requestId: p.requestId, encodedDataLength: p.encodedDataLength })
  })
  CDP.onEvent(tabId, "Network.loadingFailed", (p) => {
    push(tabId, {
      kind: "failed",
      ts: nowMs(),
      requestId: p.requestId,
      errorText: p.errorText,
      canceled: p.canceled,
    })
  })
}

export function register(router) {
  router.register("net.observe", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await ensureInstrumented(id)
    return { ok: true, tabId: id }
  })

  router.register("net.stop", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    listeners.delete(id)
    try {
      await CDP.send(id, "Network.disable")
    } catch {}
    return { ok: true }
  })

  router.register("net.events", async ({ tabId, since, limit = 200, clear = false } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    const buf = listeners.get(id)
    if (!buf) return { events: [] }
    let events = buf.events
    if (typeof since === "number") events = events.filter((e) => e.ts > since)
    const out = events.slice(-limit)
    if (clear) buf.events.splice(0, buf.events.length)
    return { events: out }
  })

  router.register("net.responseBody", async ({ tabId, requestId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    invariant(requestId, "requestId required", "INVALID_ARGS")
    await CDP.attach(id)
    try {
      const res = await CDP.send(id, "Network.getResponseBody", { requestId })
      return { body: res.body, base64Encoded: res.base64Encoded }
    } catch (e) {
      throw new BridgeError(`Body unavailable: ${e.message}`, "NOT_FOUND")
    }
  })

  router.register("net.fetch", async ({ url, method = "GET", headers, body, mode = "same-origin", credentials = "include", timeoutMs = 30_000 } = {}) => {
    invariant(url, "url required", "INVALID_ARGS")
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const resp = await fetch(url, { method, headers, body, mode, credentials, signal: ac.signal })
      const buf = await resp.arrayBuffer()
      const text = new TextDecoder().decode(buf).slice(0, 5_000_000)
      return {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries()),
        body: text,
      }
    } catch (e) {
      throw new BridgeError(`fetch failed: ${e.message}`, "NETWORK")
    } finally {
      clearTimeout(timer)
    }
  })
}

export function cleanupTab(tabId) {
  listeners.delete(tabId)
}
