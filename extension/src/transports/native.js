/**
 * transports/native.js — Native Messaging Host transport.
 *
 * Spawns the `com.opensin.bridge` native host via chrome.runtime.connectNative.
 * Messages are JSON-RPC style envelopes identical to the WS transport, so the
 * same router handles both.
 */

import { CONFIG } from "../core/config.js"
import { createLogger } from "../core/logger.js"
import * as State from "../core/state.js"
import { bindBus, sleep } from "../core/utils.js"

const log = createLogger("native")

export function create({ router, hostName = CONFIG.nativeHost, clientId }) {
  const bus = bindBus()
  let port = null
  let connected = false
  let manualStop = false
  let attempt = 0

  function setStatus(next, extra = {}) {
    State.patch({ native: { status: next, host: hostName, attempt, ...extra } })
    bus.emit("status", next)
  }

  function send(obj) {
    if (!port) return false
    try {
      port.postMessage(obj)
      return true
    } catch (e) {
      log.warn("post failed", e)
      return false
    }
  }

  async function handle(msg) {
    if (msg?.type === "hello") {
      send({ type: "hello.ack", clientId, version: CONFIG.version })
      return
    }
    const isToolRequest =
      msg?.id !== undefined &&
      (msg.type === "tool_request" || msg.type === "rpc" || !msg.type) &&
      (msg.method || msg.tool)
    if (isToolRequest) {
      const method = msg.method || msg.tool
      const params = msg.params || msg.args || {}
      const start = Date.now()
      try {
        const result = await router.invoke(method, params, { transport: "native" })
        send({ type: "tool_response", id: msg.id, ok: true, result, durationMs: Date.now() - start })
      } catch (e) {
        send({
          type: "tool_response",
          id: msg.id,
          ok: false,
          error: e.message,
          errorDetail: { code: e.code || "INTERNAL", message: e.message, data: e.data },
          durationMs: Date.now() - start,
        })
      }
      return
    }
    bus.emit("message", msg)
  }

  async function connect() {
    if (connected || manualStop) return
    setStatus("connecting")
    try {
      port = chrome.runtime.connectNative(hostName)
    } catch (e) {
      log.error("connectNative failed", e)
      setStatus("error", { lastError: e.message })
      await sleep(Math.min(1000 * 2 ** Math.min(attempt++, 6), 30_000))
      if (!manualStop) connect()
      return
    }

    connected = true
    attempt = 0
    setStatus("open")
    send({ type: "register", clientId, version: CONFIG.version, ts: Date.now() })

    port.onMessage.addListener(handle)
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message
      log.warn("native disconnected", err)
      port = null
      connected = false
      setStatus("closed", { lastError: err || null })
      if (!manualStop) {
        sleep(Math.min(1000 * 2 ** Math.min(attempt++, 6), 30_000)).then(() => connect())
      }
    })
  }

  function start() {
    manualStop = false
    connect()
  }

  function stop() {
    manualStop = true
    try {
      port?.disconnect()
    } catch {}
    port = null
    connected = false
    setStatus("idle")
  }

  function emit(event) {
    send({ type: "event", event, ts: Date.now(), clientId })
  }

  return { start, stop, send: emit, on: bus.on, off: bus.off, get connected() { return connected } }
}
