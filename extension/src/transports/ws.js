/**
 * transports/ws.js — WebSocket transport with exponential backoff, keep-alive,
 * bounded queue and graceful reconnect.
 *
 * Connects to the bridge server (server.js) which exposes a JSON-RPC style
 * channel. Incoming messages are routed to the tool router; outgoing events
 * and responses are buffered while disconnected and flushed on reconnect.
 */

import { CONFIG } from "../core/config.js"
import { createLogger } from "../core/logger.js"
import * as State from "../core/state.js"
import { jitter, sleep, bindBus } from "../core/utils.js"

const log = createLogger("ws")

const STATE = {
  IDLE: "idle",
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSED: "closed",
  ERROR: "error",
}

export function create({ router, url = CONFIG.wsUrl, clientId }) {
  const bus = bindBus()
  let ws = null
  let status = STATE.IDLE
  let attempt = 0
  let manualStop = false
  let heartbeatTimer = null
  let reconnectTimer = null
  const outbox = []
  const MAX_OUTBOX = 1000

  function setStatus(next) {
    status = next
    State.patch({ ws: { status, url, attempt, lastError: State.get("ws")?.lastError || null } })
    bus.emit("status", status)
  }

  function send(obj) {
    const payload = typeof obj === "string" ? obj : JSON.stringify(obj)
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload)
      } catch (e) {
        log.warn("send failed, buffering", e)
        buffer(payload)
      }
    } else {
      buffer(payload)
    }
  }

  function buffer(payload) {
    outbox.push(payload)
    while (outbox.length > MAX_OUTBOX) outbox.shift()
  }

  function flush() {
    while (outbox.length && ws?.readyState === WebSocket.OPEN) {
      const msg = outbox.shift()
      try {
        ws.send(msg)
      } catch (e) {
        outbox.unshift(msg)
        break
      }
    }
  }

  function scheduleReconnect() {
    if (manualStop) return
    clearTimeout(reconnectTimer)
    attempt += 1
    const base = CONFIG.ws.backoffMinMs * Math.pow(2, Math.min(attempt, 8))
    const delay = Math.min(jitter(base, 0.3), CONFIG.ws.backoffMaxMs)
    log.info(`reconnect in ${Math.round(delay)}ms (attempt ${attempt})`)
    reconnectTimer = setTimeout(() => connect(), delay)
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        send({ type: "ping", ts: Date.now() })
      }
    }, CONFIG.ws.heartbeatMs)
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  async function handleMessage(raw) {
    let msg
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw
    } catch (e) {
      log.warn("non-JSON message", e)
      return
    }
    if (msg.type === "pong" || msg.type === "ping") return
    if (msg.type === "hello") {
      send({
        type: "hello.ack",
        clientId,
        version: CONFIG.version,
        capabilities: { tools: router.list() },
      })
      return
    }

    // Tool request. Accepted envelopes (all interchangeable):
    //   { type: "tool_request", id, method, params }   // Hugging Face server
    //   { type: "rpc",          id, method, params }
    //   {                       id, method, params }   // bare JSON-RPC
    //   {                       id, tool,   args   }
    const isToolRequest =
      msg.id !== undefined &&
      (msg.type === "tool_request" || msg.type === "rpc" || !msg.type) &&
      (msg.method || msg.tool)

    if (isToolRequest) {
      const method = msg.method || msg.tool
      const params = msg.params || msg.args || {}
      const start = Date.now()
      const replyType = msg.type === "tool_request" ? "tool_response" : "tool_response"
      try {
        const result = await router.invoke(method, params, { transport: "ws" })
        // Canonical response: server.js checks msg.type === 'tool_response' &&
        // msg.id to resolve pending requests.
        send({
          type: replyType,
          id: msg.id,
          ok: true,
          result,
          durationMs: Date.now() - start,
        })
      } catch (e) {
        send({
          type: replyType,
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

  function connect() {
    if (status === STATE.CONNECTING || status === STATE.OPEN) return
    setStatus(STATE.CONNECTING)
    try {
      ws = new WebSocket(url)
    } catch (e) {
      log.error("WS construct failed", e)
      State.patch({ ws: { status: STATE.ERROR, url, attempt, lastError: e.message } })
      scheduleReconnect()
      return
    }

    ws.addEventListener("open", () => {
      log.info(`connected to ${url}`)
      attempt = 0
      setStatus(STATE.OPEN)
      // Server expects `version` and `toolsCount`; keep `capabilities` for
      // debugging / richer clients.
      const tools = router.list()
      send({
        type: "register",
        clientId,
        version: CONFIG.version,
        userAgent: navigator.userAgent,
        toolsCount: tools.length,
        capabilities: { tools },
        ts: Date.now(),
      })
      startHeartbeat()
      flush()
    })

    ws.addEventListener("message", (ev) => handleMessage(ev.data))

    ws.addEventListener("close", (ev) => {
      log.warn(`closed code=${ev.code} reason=${ev.reason || "n/a"}`)
      stopHeartbeat()
      setStatus(STATE.CLOSED)
      ws = null
      scheduleReconnect()
    })

    ws.addEventListener("error", (e) => {
      log.warn("ws error", e?.message || e)
      State.patch({ ws: { status: STATE.ERROR, url, attempt, lastError: "WebSocket error" } })
    })
  }

  function start() {
    manualStop = false
    connect()
  }

  function stop() {
    manualStop = true
    clearTimeout(reconnectTimer)
    stopHeartbeat()
    try {
      ws?.close(1000, "client shutdown")
    } catch {}
    ws = null
    setStatus(STATE.IDLE)
  }

  function emit(event) {
    send({ type: "event", event, ts: Date.now(), clientId })
  }

  return { start, stop, send: emit, on: bus.on, off: bus.off, get status() { return status } }
}
