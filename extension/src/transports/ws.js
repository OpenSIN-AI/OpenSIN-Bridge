/**
 * WebSocket transport — connects to local bridge server.
 *
 * Opens a WebSocket to ws://localhost:7777/extension and relays
 * JSON-RPC messages between the Chrome extension and the bridge server.
 */
import { CONFIG } from "../core/config.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("ws");

export function create({ router, clientId }) {
  const url = CONFIG.wsUrl || "ws://localhost:7777/extension";
  log.info(`Connecting to ${url} (client: ${clientId})`);

  let ws = null;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let reconnectAttempts = 0;

  function connect() {
    try {
      ws = new WebSocket(url);

      ws.onopen = () => {
        log.info("WebSocket connected");
        reconnectAttempts = 0;
        // Send handshake
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "extension.connect",
          params: { clientId, version: "5.0.0" },
          id: 0
        }));
        // Start keep-alive pings every 60 seconds
        keepAliveTimer = setInterval(() => {
          try {
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "ping",
              params: { clientId },
              id: -1
            }));
          } catch {}
        }, 60000);
      };

      ws.onmessage = async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg.method) return;

        try {
          const result = await router.invoke(msg.method, msg.params, { via: "ws" });
          ws.send(JSON.stringify({ type: "tool_response", id: msg.id, result }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "tool_response", id: msg?.id, error: { code: -32603, message: e.message } }));
        }
      };

      ws.onclose = () => {
        if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
        log.warn("WebSocket closed, reconnecting...");
        scheduleReconnect();
      };

      ws.onerror = (err) => {
        log.error("WebSocket error", err?.message || "unknown");
      };
    } catch (e) {
      log.error("Failed to create WebSocket", e.message);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    log.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  connect();

  const transport = {
    send,
    close: () => { if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); },
    stop: () => { if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); },
    start: () => { if (!ws || ws.readyState > 1) connect(); },
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    status: "connected",
  };

  // Update status based on connection state
  if (ws) {
    ws.addEventListener("open", () => { transport.status = "connected"; });
    ws.addEventListener("close", () => { transport.status = "disconnected"; });
    ws.addEventListener("error", () => { transport.status = "error"; });
  }

  return transport;
}
