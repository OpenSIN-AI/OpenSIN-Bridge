/**
 * ==============================================================================
 * OpenSIN Component: server.js
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * Source file for the OpenSIN ecosystem.
 * 
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Essential logic for autonomous agent cooperation.
 * 
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 * 
 * CONSEQUENCES / KONSEQUENZEN:
 * Incorrect modification may disrupt agent communication or task execution.
 * 
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */


/**
 * OpenSIN Bridge MCP Server — Hugging Face Space Edition v2.9.2
 *
 * WebSocket mode: Chrome extension connects via WebSocket.
 * HTTP mode: AI agents call tools via JSON-RPC over REST.
 * Robustness goals:
 * - never crash on listen errors without a controlled log
 * - never return opaque HTTP 500s for expected tool/runtime failures
 * - report degraded extension state via /health instead of pretending healthy
 */

const express = require('express');
const http = require('node:http');
const WebSocket = require('ws');
const cron = require('node-cron');

const PORT = Number(process.env.PORT || 7860);
const VERSION = '2.9.2';
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 30000);
const EXTENSION_STALE_MS = Number(process.env.EXTENSION_STALE_MS || 90000);
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || `http://127.0.0.1:${PORT}/health`;

const TOOL_DEFINITIONS = [
  { name: 'tabs_list', description: 'List all browser tabs' },
  { name: 'tabs_create', description: 'Create a new tab' },
  { name: 'tabs_close', description: 'Close a tab' },
  { name: 'tabs_activate', description: 'Activate a tab' },
  { name: 'tabs_update', description: 'Update a tab' },
  { name: 'navigate', description: 'Navigate to URL' },
  { name: 'go_back', description: 'Go back in history' },
  { name: 'go_forward', description: 'Go forward in history' },
  { name: 'reload', description: 'Reload page' },
  { name: 'click_element', description: 'Click element by CSS selector' },
  { name: 'type_text', description: 'Type text into element' },
  { name: 'get_text', description: 'Get text content' },
  { name: 'get_html', description: 'Get HTML content' },
  { name: 'get_attribute', description: 'Get element attribute' },
  { name: 'wait_for_element', description: 'Wait for element to appear' },
  { name: 'execute_script', description: 'Execute JavaScript' },
  { name: 'inject_css', description: 'Inject CSS' },
  { name: 'get_page_info', description: 'Get page title, URL, readyState' },
  { name: 'get_all_links', description: 'Extract all links from page' },
  { name: 'get_all_inputs', description: 'Extract all form inputs' },
  { name: 'screenshot', description: 'Capture screenshot' },
  { name: 'screenshot_full', description: 'Capture full page screenshot' },
  { name: 'snapshot', description: 'Capture an accessibility tree snapshot for the active tab' },
  { name: 'observe', description: 'Capture a full observation snapshot with screenshot evidence' },
  { name: 'page_diff', description: 'Compare the current page against the previous observation snapshot' },
  { name: 'click_ref', description: 'Click a referenced interactive element with self-healing verification' },
  { name: 'hover_ref', description: 'Hover over a referenced interactive element' },
  { name: 'screenshot_annotated', description: 'Capture an annotated screenshot with reference labels' },
  { name: 'get_interaction_proof', description: 'Fetch stored screenshots and diff evidence for a verified interaction' },
  { name: 'start_recording', description: 'Start screen recording' },
  { name: 'stop_recording', description: 'Stop screen recording' },
  { name: 'recording_status', description: 'Get recording status' },
  { name: 'get_cookies', description: 'Get cookies' },
  { name: 'set_cookie', description: 'Set a cookie' },
  { name: 'delete_cookie', description: 'Delete a cookie' },
  { name: 'clear_cookies', description: 'Clear all cookies' },
  { name: 'storage_get', description: 'Get storage data' },
  { name: 'storage_set', description: 'Set storage data' },
  { name: 'storage_clear', description: 'Clear storage data' },
  { name: 'get_network_requests', description: 'Get network request log' },
  { name: 'block_url', description: 'Block URL pattern' },
  { name: 'enable_stealth', description: 'Enable anti-detection mode' },
  { name: 'stealth_status', description: 'Get stealth mode status' },
  { name: 'extract_prolific_studies', description: 'Extract Prolific studies' },
  { name: 'health', description: 'Extension health check' },
  { name: 'list_tools', description: 'List all available tools' },
  { name: 'offscreen_status', description: 'Get offscreen document status' },
  { name: 'advanced_stealth', description: 'Advanced stealth with fingerprint spoofing' },
  { name: 'detect_challenges', description: 'Detect CAPTCHA, Cloudflare, rate limits' },
  { name: 'simulate_human_behavior', description: 'Simulate human mouse/keyboard behavior' },
  { name: 'save_session', description: 'Save cookies and storage for later' },
  { name: 'restore_session', description: 'Restore saved session data' },
  { name: 'handle_rate_limit', description: 'Detect and handle rate limiting' },
  { name: 'get_extension_info', description: 'Get extension version and status' },
  { name: 'clear_logs', description: 'Clear network and console logs' },
  { name: 'bypass_cloudflare', description: 'Auto-wait for Cloudflare challenge to resolve' },
  { name: 'bypass_cloudflare_turnstile', description: 'Click Cloudflare Turnstile checkbox' },
  { name: 'detect_recaptcha', description: 'Detect reCAPTCHA v2/v3 and hCaptcha on page' },
  { name: 'solve_recaptcha_checkbox', description: 'Click reCAPTCHA I am not a robot checkbox' },
  { name: 'rotate_fingerprint', description: 'Rotate browser fingerprint (GPU, screen, timezone, etc.)' },
  { name: 'get_fingerprint', description: 'Get current fingerprint profile' },
  { name: 'detect_bot_protection', description: 'Detect DataDome, PerimeterX, Akamai, Distil, Imperva, Shape/F5' },
  { name: 'evasion_mode', description: 'Remove bot detection scripts and override automation markers' },
  { name: 'rotate_user_agent', description: 'Rotate user agent string' },
  { name: 'set_referrer', description: 'Spoof document referrer' },
  { name: 'randomize_behavior', description: 'Schedule random mouse movements, scrolls, focus/blur events' },
  { name: 'smart_fill_form', description: 'AI-powered form auto-detection and smart fill with user profile' },
  { name: 'query_shadow_dom', description: 'Query elements inside Shadow DOM' },
  { name: 'click_shadow_element', description: 'Click element inside Shadow DOM' },
  { name: 'list_iframes', description: 'List all iframes with visibility and same-origin info' },
  { name: 'interact_iframe', description: 'Click, type, or read content inside same-origin iframes' },
  { name: 'export_all_cookies', description: 'Export all cookies for current domain' },
  { name: 'import_cookies', description: 'Import cookies from array' },
  { name: 'rotate_cookies', description: 'Export and delete all cookies for domain' },
  { name: 'set_proxy', description: 'Set HTTP/S proxy for browser' },
  { name: 'clear_proxy', description: 'Clear proxy settings' },
  // ----- Bridge contract v1 surface (worker issue #69) ---------------------
  { name: 'bridge.contract', description: 'Return the active OpenSIN-Bridge contract (schema, errors, idempotency, retry hints)' },
  { name: 'bridge.contract.method', description: 'Return contract metadata for a single method' },
  { name: 'bridge.contract.translate', description: 'Translate an internal BridgeError code to its public contract code' },
  { name: 'bridge.contract.idempotent', description: 'Report whether a contract method is safe to retry' },
  { name: 'bridge.contract.version', description: 'Return the current contract version + revision' },
  // ----- Observability / evidence (worker issue #70) -----------------------
  { name: 'bridge.evidenceBundle', description: 'Assemble a forensic evidence bundle (snapshot, screenshot, network, behavior, command history)' },
  { name: 'bridge.traces', description: 'Return recent RPC dispatches, optionally filtered by trace ID' },
  // ----- Session lifecycle (worker issue #71) ------------------------------
  { name: 'session.manifest', description: 'Build or refresh a session manifest with TTL, origin scope, last-known-good tracking' },
  { name: 'session.invalidate', description: 'Mark the active session manifest invalid with classified reason' },
  { name: 'session.lastKnownGood', description: 'Return the most recent known-good session snapshot for an origin' },
  { name: 'session.health', description: 'Probe the active session manifest and return active/stale/invalid status' },
  { name: 'session.list', description: 'List session manifests, sorted newest first' },
  { name: 'session.drop', description: 'Drop a session manifest entirely' },
  // ----- Stealth assessment (worker issue #74) -----------------------------
  { name: 'stealth.assess', description: 'Score environment coherence (locale, timezone, viewport, automation markers)' },
  { name: 'stealth.detectChallenge', description: 'Detect anti-bot challenges (Cloudflare, Turnstile, reCAPTCHA, hCaptcha, DataDome, ...)' },
];

class BridgeRpcError extends Error {
  constructor(message, { code = -32000, status = 200, data } = {}) {
    super(message);
    this.name = 'BridgeRpcError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function log(scope, message, extra) {
  const prefix = `[OpenSIN Bridge MCP v${VERSION}] [${scope}]`;
  if (extra !== undefined) {
    console.log(prefix, message, extra);
    return;
  }
  console.log(prefix, message);
}

function buildContext() {
  return {
    extensionWs: null,
    pendingRequests: new Map(),
    nextRequestId: 1,
    lastExtensionPing: 0,
    extensionVersion: null,
    extensionToolsCount: null,
    extensionAuthToken: null,
    keepAliveFailures: 0,
    lastKeepAliveAt: null,
    lastError: null,
  };
}

function setLastError(context, error, source) {
  const message = error instanceof Error ? error.message : String(error);
  context.lastError = {
    source,
    message,
    timestamp: new Date().toISOString(),
  };
}

function isExtensionHealthy(context) {
  const socketOpen = !!context.extensionWs && context.extensionWs.readyState === WebSocket.OPEN;
  if (!socketOpen) return false;
  if (!context.lastExtensionPing) return false;
  return Date.now() - context.lastExtensionPing <= EXTENSION_STALE_MS;
}

function buildHealthPayload(context) {
  const extensionConnected = !!context.extensionWs && context.extensionWs.readyState === WebSocket.OPEN;
  const timeSinceExtensionPing = context.lastExtensionPing ? Date.now() - context.lastExtensionPing : null;
  const extensionHealthy = isExtensionHealthy(context);
  return {
    status: extensionHealthy ? 'ok' : 'degraded',
    version: VERSION,
    extensionConnected,
    extensionHealthy,
    timeSinceExtensionPing,
    extensionStaleMs: EXTENSION_STALE_MS,
    pendingRequests: context.pendingRequests.size,
    toolsCount: context.extensionToolsCount || TOOL_DEFINITIONS.length,
    extensionVersion: context.extensionVersion,
    lastKeepAliveAt: context.lastKeepAliveAt,
    keepAliveFailures: context.keepAliveFailures,
    lastError: context.lastError,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
}

function createRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function createRpcError(id, error) {
  const rpcError = error instanceof BridgeRpcError
    ? error
    : new BridgeRpcError(error instanceof Error ? error.message : String(error), { code: -32603, status: 500 });
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: rpcError.code,
      message: rpcError.message,
      ...(rpcError.data !== undefined ? { data: rpcError.data } : {}),
    },
  };
}

function createApp(context) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    next();
  });

  app.get('/', (req, res) => {
    res.json({
      name: 'OpenSIN Bridge MCP',
      version: VERSION,
      endpoints: ['/health', '/mcp', 'WS /extension', 'WS /agent'],
    });
  });

  app.get('/health', (req, res) => {
    res.json(buildHealthPayload(context));
  });

  app.post('/mcp', async (req, res) => {
    const { id = null, method, params = {} } = req.body || {};
    try {
      const response = await handleRpcMessage(context, { id, method, params }, 'http');
      res.status(200).json(response);
    } catch (error) {
      setLastError(context, error, 'http:/mcp');
      const rpcError = error instanceof BridgeRpcError
        ? error
        : new BridgeRpcError(error instanceof Error ? error.message : String(error), { code: -32603, status: 500 });
      res.status(rpcError.status || 200).json(createRpcError(id, rpcError));
    }
  });

  app.use((error, req, res, next) => {
    setLastError(context, error, 'express-json');
    const status = error?.type === 'entity.parse.failed' ? 400 : 500;
    const rpcError = new BridgeRpcError(
      status === 400 ? 'Invalid JSON body' : 'Internal server error',
      { code: status === 400 ? -32700 : -32603, status }
    );
    res.status(status).json(createRpcError(null, rpcError));
  });

  return app;
}

async function handleRpcMessage(context, message, transport) {
  const { id = null, method, params = {} } = message || {};

  if (!method || typeof method !== 'string') {
    throw new BridgeRpcError('Missing JSON-RPC method', { code: -32600, status: 400 });
  }

  if (method === 'initialize') {
    return createRpcSuccess(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'opensin-bridge-mcp', version: VERSION },
    });
  }

  if (method === 'notifications/initialized') {
    return createRpcSuccess(id, { acknowledged: true });
  }

  if (method === 'tools/list') {
    return createRpcSuccess(id, { tools: TOOL_DEFINITIONS });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (!name || typeof name !== 'string') {
      throw new BridgeRpcError('tools/call requires params.name', { code: -32602, status: 400 });
    }

    try {
      const toolResult = await callTool(context, name, params?.arguments || {});
      return createRpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(toolResult) }] });
    } catch (error) {
      const rpcError = normalizeToolError(error, name);
      if (transport === 'ws') {
        return createRpcError(id, rpcError);
      }
      return createRpcError(id, rpcError);
    }
  }

  if (transport === 'ws' && params && typeof params === 'object' && !Array.isArray(params)) {
    try {
      const result = await callTool(context, method, params);
      return createRpcSuccess(id, result);
    } catch (error) {
      return createRpcError(id, normalizeToolError(error, method));
    }
  }

  throw new BridgeRpcError(`Unknown method: ${method}`, { code: -32601, status: 400 });
}

function normalizeToolError(error, toolName) {
  if (error instanceof BridgeRpcError) return error;
  const message = error instanceof Error ? error.message : String(error);

  if (/Extension not connected|Extension disconnected/i.test(message)) {
    return new BridgeRpcError(message, {
      code: -32010,
      status: 200,
      data: { tool: toolName, reason: 'extension_disconnected', retryable: true },
    });
  }

  if (/timed out/i.test(message)) {
    return new BridgeRpcError(message, {
      code: -32011,
      status: 200,
      data: { tool: toolName, reason: 'timeout', retryable: true },
    });
  }

  return new BridgeRpcError(message, {
    code: -32000,
    status: 200,
    data: { tool: toolName, reason: 'tool_error', retryable: false },
  });
}

function rejectPendingRequests(context, reason) {
  for (const [id, pending] of context.pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new BridgeRpcError(reason, {
      code: -32010,
      status: 200,
      data: { requestId: id, reason: 'extension_disconnected', retryable: true },
    }));
    context.pendingRequests.delete(id);
  }
}

async function callTool(context, method, params = {}) {
  log('Tool', `callTool ${method}`, { connected: !!context.extensionWs, readyState: context.extensionWs?.readyState });

  if (!isExtensionHealthy(context)) {
    throw new BridgeRpcError('Extension disconnected', {
      code: -32010,
      status: 200,
      data: {
        method,
        extensionConnected: !!context.extensionWs && context.extensionWs.readyState === WebSocket.OPEN,
        timeSinceExtensionPing: context.lastExtensionPing ? Date.now() - context.lastExtensionPing : null,
        retryable: true,
      },
    });
  }

  return new Promise((resolve, reject) => {
    const id = context.nextRequestId++;
    const timeout = setTimeout(() => {
      context.pendingRequests.delete(id);
      reject(new BridgeRpcError(`Tool '${method}' timed out after ${TOOL_TIMEOUT_MS}ms`, {
        code: -32011,
        status: 200,
        data: { method, requestId: id, retryable: true },
      }));
    }, TOOL_TIMEOUT_MS);

    context.pendingRequests.set(id, { resolve, reject, timeout, method, startedAt: Date.now() });

    const payload = JSON.stringify({ type: 'tool_request', id, method, params });

    try {
      context.extensionWs.send(payload, (sendError) => {
        if (sendError) {
          clearTimeout(timeout);
          context.pendingRequests.delete(id);
          reject(new BridgeRpcError(`Failed to send tool '${method}' to extension: ${sendError.message}`, {
            code: -32012,
            status: 200,
            data: { method, requestId: id, retryable: true },
          }));
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      context.pendingRequests.delete(id);
      reject(new BridgeRpcError(`Failed to dispatch tool '${method}': ${error.message}`, {
        code: -32012,
        status: 200,
        data: { method, requestId: id, retryable: true },
      }));
    }
  });
}

function createWebSocketServer(server, context) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    const isExtension = req.url === '/extension';
    const isAgent = req.url === '/agent';
    log('WS', `connection ${req.url || 'unknown'}`, { remote: req.socket.remoteAddress });

    if (!isExtension && !isAgent) {
      ws.close(1008, 'Unknown websocket endpoint');
      return;
    }

    if (isExtension) {
      if (context.extensionWs && context.extensionWs.readyState === WebSocket.OPEN) {
        log('WS', 'closing previous extension connection');
        context.extensionWs.close(1000, 'Replaced by newer extension session');
      }

      context.extensionWs = ws;
      context.lastExtensionPing = Date.now();
      log('WS', 'extension connected');

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          context.lastExtensionPing = Date.now();

          if (msg.type === 'tool_response' && msg.id && context.pendingRequests.has(msg.id)) {
            const pending = context.pendingRequests.get(msg.id);
            clearTimeout(pending.timeout);
            context.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new BridgeRpcError(msg.error, {
                code: -32000,
                status: 200,
                data: { method: pending.method, requestId: msg.id, retryable: false },
              }));
            } else {
              pending.resolve(msg.result);
            }
            return;
          }

          if (msg.type === 'register') {
            context.extensionVersion = msg.version || null;
            context.extensionToolsCount = Number.isFinite(msg.toolsCount) ? msg.toolsCount : context.extensionToolsCount;
            context.extensionAuthToken = msg.authToken || null;
            log('WS', 'extension registered', {
              version: context.extensionVersion,
              tools: context.extensionToolsCount,
            });
            return;
          }

          if (msg.type === 'ping' || msg.type === 'pong') {
            return;
          }
        } catch (error) {
          setLastError(context, error, 'ws:extension:parse');
          log('WS', 'extension parse error', error instanceof Error ? error.message : String(error));
        }
      });

      ws.on('close', () => {
        log('WS', 'extension disconnected');
        if (context.extensionWs === ws) {
          context.extensionWs = null;
        }
        rejectPendingRequests(context, 'Extension disconnected');
      });

      ws.on('error', (error) => {
        setLastError(context, error, 'ws:extension');
        log('WS', 'extension socket error', error.message);
        if (context.extensionWs === ws) {
          context.extensionWs = null;
        }
      });

      return;
    }

    ws.on('message', async (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        const response = createRpcError(null, new BridgeRpcError('Invalid JSON message', { code: -32700, status: 400 }));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
        return;
      }

      try {
        const response = await handleRpcMessage(context, message, 'ws');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      } catch (error) {
        setLastError(context, error, 'ws:agent');
        const response = createRpcError(message?.id ?? null, error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      }
    });
  });

  return wss;
}

function startIntervals(context, wss) {
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (error) {
          setLastError(context, error, 'ws:ping');
        }
      }
    });
  }, 30000);

  const keepAliveTask = cron.schedule('*/4 * * * *', async () => {
    context.lastKeepAliveAt = new Date().toISOString();
    try {
      const response = await fetch(KEEPALIVE_URL, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`Keep-alive returned ${response.status}`);
      }
      context.keepAliveFailures = 0;
      log('KeepAlive', 'success', { url: KEEPALIVE_URL });
    } catch (error) {
      context.keepAliveFailures += 1;
      setLastError(context, error, 'keepalive');
      log('KeepAlive', 'failed', error instanceof Error ? error.message : String(error));
    }
  });

  return {
    stop() {
      clearInterval(pingInterval);
      keepAliveTask.stop();
      keepAliveTask.destroy();
    },
  };
}

async function startServer({ port = PORT } = {}) {
  const context = buildContext();
  const app = createApp(context);
  const server = http.createServer(app);
  const wss = createWebSocketServer(server, context);
  const intervals = startIntervals(context, wss);

  server.on('error', (error) => {
    setLastError(context, error, 'server:listen');
    log('Server', 'listen error', error instanceof Error ? error.message : String(error));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      log('Server', `HTTP listening on http://localhost:${port}`);
      resolve();
    });
  });

  return {
    app,
    server,
    wss,
    context,
    close: async () => {
      intervals.stop();
      rejectPendingRequests(context, 'Server shutting down');
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

if (require.main === module) {
  console.log(`[OpenSIN Bridge MCP] Starting v${VERSION}...`);
  console.log(`[OpenSIN Bridge MCP] HTTP: http://localhost:${PORT}`);
  console.log(`[OpenSIN Bridge MCP] WS Extension: ws://localhost:${PORT}/extension`);
  console.log(`[OpenSIN Bridge MCP] WS Agent: ws://localhost:${PORT}/agent`);
  console.log('[OpenSIN Bridge MCP] Keep-Alive: every 4 minutes');

  startServer().catch((error) => {
    console.error('[OpenSIN Bridge MCP] Fatal startup error:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  VERSION,
  TOOL_DEFINITIONS,
  EXTENSION_STALE_MS,
  TOOL_TIMEOUT_MS,
  buildContext,
  buildHealthPayload,
  callTool,
  createApp,
  createRpcError,
  createRpcSuccess,
  createWebSocketServer,
  handleRpcMessage,
  isExtensionHealthy,
  normalizeToolError,
  startServer,
};
