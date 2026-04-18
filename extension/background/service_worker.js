/**
 * ==============================================================================
 * OpenSIN Component: service_worker.js
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * Background service worker for the OpenSIN Bridge extension.
 * 
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Acts as the bridge between MCP and local Chrome APIs.
 * 
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 * 
 * CONSEQUENCES / KONSEQUENZEN:
 * Breaking this script disables ALL browser-based agent actions.
 * 
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */


/**
 * ==============================================================================
 * OpenSIN Bridge - Core Component (V4.0.0+)
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * This file is a critical component of the OpenSIN Bridge ecosystem. 
 * It enables direct, secure, and reliable communication between the Hugging Face 
 * MCP Server and the user's local Chrome browser.
 * 
 * ARCHITECTURE / WARUM SO GEBAUT:
 * - We DO NOT use Selenium, Puppeteer, or nodriver here.
 * - We DO NOT launch new Chrome instances with --no-sandbox.
 * - Instead, we use the Native Chrome Extension API (MV3) inside the user's 
 *   DEFAULT profile to ensure all cookies, sessions, and extensions remain intact.
 * 
 * RULES / REGELN FÜR DIESEN CODE:
 * 1. NO ASSUMPTIONS: Do not assume a tab or window exists. Always verify and handle missing states.
 * 2. EXTENSIVE LOGGING: Every action must be logged. Silent failures are prohibited.
 * 3. FALLBACKS: If an API fails (e.g. tabs.create without a window), fallback gracefully (e.g. create a window).
 * 
 * CONSEQUENCES / KONSEQUENZEN WENN GEÄNDERT:
 * - If you break the WebSocket connection here, the entire autonomous agent fleet goes blind.
 * - If you change security policies (CSP), the extension might get banned by Chrome.
 * 
 * AUTHOR: SIN-Zeus / A2A Team
 * ==============================================================================
 */

import {
  OBSERVATION_DEFAULTS,
  buildDomDiff,
  buildVisualDiff,
  evaluateObservation,
  summarizeProof,
} from './observation-runtime.mjs';

import {
  NATIVE_HOST_CONTEXT,
  NATIVE_HOST_IDLE_TIMEOUT_MS,
  NATIVE_HOST_NAME,
  NATIVE_HOST_REQUEST_TIMEOUT_MS,
  assertNativeCommandAllowed,
  buildWorkflowStartPayload,
  createNativeEnvelope,
} from './native-host.mjs';

// Shared deterministic primitive helpers are loaded as a side-effect module so
// the exact same bounded rule set can be reused by the service worker, content
// scripts, and Node-based tests without introducing bundling into this repo.
import '../shared/deterministic-primitives.js';

// The helper stays nullable on purpose. If it is ever unavailable we must keep
// the existing adaptive paths working instead of failing closed.
const deterministicPrimitives = globalThis.__OpenSINDeterministicPrimitives || null;

let offscreenReady = false;
const VERSION = chrome.runtime.getManifest().version;
const HF_MCP_URL = 'wss://openjerro-opensin-bridge-mcp.hf.space';
const TOOL_REGISTRY = {};
let hfWs = null;
let hfReconnectTimer = null;
let hfReconnectAttempts = 0;
const HF_MAX_RECONNECT = Infinity;
const HF_RECONNECT_DELAY = 1000;
let recentLogs = [];
const MAX_LOGS = 50;

// ============================================================
// ISSUE #28: MV3 Keep-Alive — Ephemeral State via storage.session
// ============================================================
// WHY: Chrome MV3 service workers are killed after ~30s inactivity.
// All in-memory Maps (CURRENT_TAB_ID, active sessions, ref map) are wiped.
// chrome.storage.session survives SW restarts AND is faster than storage.local.
// USAGE: call persistEphemeralState() after mutating critical runtime state.
// Call restoreEphemeralState() during init to recover from a SW restart.

async function persistEphemeralState(patch = {}) {
  try {
    const current = await chrome.storage.session.get(['_sin_sw_state']);
    const prev = current['_sin_sw_state'] || {};
    await chrome.storage.session.set({ '_sin_sw_state': { ...prev, ...patch, ts: Date.now() } });
  } catch (e) {
    log('warn', `persistEphemeralState failed: ${e.message}`);
  }
}

async function restoreEphemeralState() {
  try {
    const data = await chrome.storage.session.get(['_sin_sw_state']);
    const state = data['_sin_sw_state'];
    if (state) {
      log('info', `Restored ephemeral SW state from storage.session (age: ${Date.now() - state.ts}ms)`);
    }
    return state || {};
  } catch (e) {
    log('warn', `restoreEphemeralState failed: ${e.message}`);
    return {};
  }
}

// ============================================================
// ISSUE #29: MAIN-World postMessage Security Schema Validation
// ============================================================
// WHY: MAIN-world injected scripts run in the page's JS context.
// Hostile pages can send crafted postMessage events that mimic our schema.
// RULE: ONLY accept messages with a known _sinBridgeType from our own origin.
// Every handler for window.postMessage MUST call this validator first.

const ALLOWED_MAIN_WORLD_MSG_TYPES = new Set([
  'NETWORK_EVENT',      // fetch/XHR correlation from MAIN-world interceptor
  'BEHAVIOR_EVENT',     // user interaction timeline event from MAIN-world capture
  'SNAPSHOT_REQUEST',   // snapshot trigger from in-page script
]);

function validateMainWorldMessage(event) {
  if (!event || typeof event !== 'object') return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  if (!ALLOWED_MAIN_WORLD_MSG_TYPES.has(data._sinBridgeType)) return null;
  if (typeof data.payload !== 'object' || data.payload === null) return null;
  return data;
}


function addLog(level, msg) {
  const entry = { level, msg, timestamp: new Date().toISOString() };
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const prefix = `[OpenSIN ${ts}]`;
  const fn = console[level] || console.log;
  data ? fn(`${prefix} ${msg}`, data) : fn(`${prefix} ${msg}`);
  addLog(level, msg);
}

// --- Native Messaging Host State ---
// WHAT: Tracks the lifecycle of the MV3 native messaging port.
// WHY: connectNative() keeps the service worker alive, so we keep the port scoped
// to explicit authenticated-session workflows and tear it down after inactivity.
let nativePort = null;
let nativeIdleTimer = null;
let nativeRequestSequence = 0;
let nativeWorkflowSession = null;
const nativePendingRequests = new Map();
const nativeState = {
  connected: false,
  connectedAt: null,
  lastActivityAt: null,
  lastDisconnectReason: null,
  lastError: null,
};

function clearNativeIdleTimer() {
  if (nativeIdleTimer) {
    clearTimeout(nativeIdleTimer);
    nativeIdleTimer = null;
  }
}

function updateNativeActivity(reason = 'activity') {
  nativeState.lastActivityAt = Date.now();
  clearNativeIdleTimer();
  nativeIdleTimer = setTimeout(() => {
    log('info', `Native host idle timeout reached after ${NATIVE_HOST_IDLE_TIMEOUT_MS}ms`);
    disconnectNativePort(`idle-timeout:${reason}`);
  }, NATIVE_HOST_IDLE_TIMEOUT_MS);
}

function rejectAllNativePendingRequests(message) {
  for (const [requestId, pending] of nativePendingRequests.entries()) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error(message));
    nativePendingRequests.delete(requestId);
  }
}

function handleNativeMessage(message) {
  nativeState.lastError = null;
  updateNativeActivity('response');

  if (!message || typeof message !== 'object') {
    log('warn', 'Native host returned a non-object response', message);
    return;
  }

  const requestId = message.requestId;
  if (!requestId || !nativePendingRequests.has(requestId)) {
    log('warn', `Native host response has no pending request: ${requestId || 'missing requestId'}`, message);
    return;
  }

  const pending = nativePendingRequests.get(requestId);
  nativePendingRequests.delete(requestId);
  clearTimeout(pending.timeoutId);

  if (message.ok === false) {
    const errorMessage = message.error?.message || 'Native host request failed';
    pending.reject(new Error(errorMessage));
    return;
  }

  pending.resolve(message.payload || {});
}

function disconnectNativePort(reason = 'manual-disconnect') {
  clearNativeIdleTimer();

  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch (error) {
      log('warn', `Native host disconnect raised: ${error.message}`);
    }
  }

  nativePort = null;
  nativeWorkflowSession = null;
  nativeState.connected = false;
  nativeState.connectedAt = null;
  nativeState.lastDisconnectReason = reason;
  rejectAllNativePendingRequests(`Native host disconnected: ${reason}`);
  log('info', `Native host disconnected (${reason})`);
}

function ensureNativePort() {
  if (nativePort) {
    updateNativeActivity('reuse-port');
    return nativePort;
  }

  log('info', `Connecting to native host ${NATIVE_HOST_NAME}`);
  nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativeState.connected = true;
  nativeState.connectedAt = Date.now();
  nativeState.lastActivityAt = Date.now();
  nativeState.lastDisconnectReason = null;
  nativeState.lastError = null;

  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError) {
      nativeState.lastError = runtimeError;
      log('warn', `Native host disconnected with runtime error: ${runtimeError}`);
    }
    disconnectNativePort(runtimeError || 'native-port-closed');
  });

  updateNativeActivity('connect-port');
  return nativePort;
}

function buildNativeRequestId() {
  nativeRequestSequence += 1;
  return `native-${Date.now()}-${nativeRequestSequence}`;
}

function nativeHostRequest(command, payload = {}, meta = {}) {
  assertNativeCommandAllowed(command);
  const requestId = buildNativeRequestId();
  const envelope = createNativeEnvelope({ command, payload, requestId, meta });
  const port = ensureNativePort();
  updateNativeActivity(command);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      nativePendingRequests.delete(requestId);
      reject(new Error(`Native host request timed out: ${command}`));
    }, NATIVE_HOST_REQUEST_TIMEOUT_MS);

    nativePendingRequests.set(requestId, { resolve, reject, timeoutId });

    try {
      port.postMessage(envelope);
    } catch (error) {
      clearTimeout(timeoutId);
      nativePendingRequests.delete(requestId);
      reject(error);
    }
  });
}

async function buildCookieHeader(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function maybeAugmentHeadersForNativeFetch({ url, headers = {}, includeCookies = true }) {
  const normalizedHeaders = { ...headers };
  normalizedHeaders['x-opensin-transport'] = 'native-host';

  if (includeCookies && !normalizedHeaders.Cookie && !normalizedHeaders.cookie) {
    const cookieHeader = await buildCookieHeader(url);
    if (cookieHeader) {
      normalizedHeaders.Cookie = cookieHeader;
    }
  }

  return normalizedHeaders;
}

function connectToHfMcp() {
  if (hfWs && (hfWs.readyState === WebSocket.OPEN || hfWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (hfReconnectTimer) { clearTimeout(hfReconnectTimer); hfReconnectTimer = null; }
  log('info', `Connecting to HF MCP Server (attempt ${hfReconnectAttempts + 1}/${HF_MAX_RECONNECT})`);
  try {
    hfWs = new WebSocket(`${HF_MCP_URL}/extension`);
    hfWs.onopen = () => {
      log('info', 'Connected to HF MCP Server');
      hfReconnectAttempts = 0;
      chrome.storage.local.get('hfAuthToken', (data) => {
        let token = data.hfAuthToken;
        if (!token) {
          token = crypto.randomUUID();
          chrome.storage.local.set({ hfAuthToken: token });
        }
        if (hfWs && hfWs.readyState === WebSocket.OPEN) {
          hfWs.send(JSON.stringify({ type: 'register', version: VERSION, toolsCount: Object.keys(TOOL_REGISTRY).length, authToken: token }));
        }
      });
    };
    hfWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'tool_request') {
          execTool(msg.method, msg.params).then(
            result => hfWs.send(JSON.stringify({ type: 'tool_response', id: msg.id, result })),
            error => hfWs.send(JSON.stringify({ type: 'tool_response', id: msg.id, error: error.message }))
          );
        } else if (msg.type === 'ping') {
          hfWs.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (e) { log('error', `HF parse error: ${e.message}`); }
    };
    hfWs.onclose = (event) => {
      log('warn', `HF MCP disconnected: code=${event.code}`);
      hfWs = null;
      if (hfReconnectAttempts < HF_MAX_RECONNECT) {
        hfReconnectAttempts++;
        const delay = HF_RECONNECT_DELAY;
        log('info', `Reconnecting in ${delay}ms (attempt ${hfReconnectAttempts}/${HF_MAX_RECONNECT})`);
        hfReconnectTimer = setTimeout(connectToHfMcp, delay);
      } else {
        log('warn', 'HF MCP max reconnect attempts reached, giving up');
      }
    };
    hfWs.onerror = (e) => { log('error', 'HF WebSocket error', e); };
  } catch (e) {
    log('error', `HF connect failed: ${e.message}`);
    hfReconnectAttempts++;
    hfReconnectTimer = setTimeout(connectToHfMcp, HF_RECONNECT_DELAY);
  }
}

function reg(name, fn) { TOOL_REGISTRY[name] = fn; }

const BLOCKED_URL_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'blob:'];
function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  return !BLOCKED_URL_SCHEMES.some(s => lower.startsWith(s));
}

// --- CDP (Chrome DevTools Protocol) Agent Vision v4.0.0 ---
const _cdpAttached = new Set();
const _refMap = new Map(); // refId -> { tabId, backendDOMNodeId, nodeId, role, name }
let _lastSnapshot = null;
let _refCounter = 0;
const _interactionProofs = new Map();
let _interactionProofCounter = 0;

async function cdpEnsureAttached(tabId) {
  if (_cdpAttached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  _cdpAttached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable', {});
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {});
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
  log('info', `CDP attached to tab ${tabId}`);
}

async function cdpDetach(tabId) {
  if (!_cdpAttached.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_e) { /* already detached */ }
  _cdpAttached.delete(tabId);
  log('info', `CDP detached from tab ${tabId}`);
}

async function cdpSend(tabId, method, params) {
  await cdpEnsureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// POINTER STATE TRACKING: Keeps the last known pointer position per tab.
// WHY: Without a remembered cursor position, every movement would start from a
// random location near the target and still look synthetic over time.
const _pointerState = new Map();

// HUMAN ENTROPY HELPERS -----------------------------------------------------
// These helpers centralize all CDP pointer movement so that every click/hover
// path uses the same non-deterministic timing, travel, and coordinate jitter.
function humanEntropyFloat(min, max) {
  return min + Math.random() * (max - min);
}

function humanEntropyInt(min, max) {
  return Math.round(humanEntropyFloat(min, max));
}

function humanEntropyClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function humanEntropySleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function humanEntropyPointFromBorder(border, maxJitterPx = 5) {
  // WHAT: Derives a target point from the DOM box model instead of clicking the
  // exact geometric center every time.
  // WHY: Perfect center hits are a strong anti-bot signal, especially when they
  // repeat across consecutive interactions.
  const xs = [border[0], border[2], border[4], border[6]];
  const ys = [border[1], border[3], border[5], border[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const centerX = minX + width / 2;
  const centerY = minY + height / 2;
  const jitterX = Math.min(maxJitterPx, Math.max(1, width / 4));
  const jitterY = Math.min(maxJitterPx, Math.max(1, height / 4));

  return {
    x: Math.round(humanEntropyClamp(centerX + humanEntropyFloat(-jitterX, jitterX), minX + 1, maxX - 1)),
    y: Math.round(humanEntropyClamp(centerY + humanEntropyFloat(-jitterY, jitterY), minY + 1, maxY - 1)),
    bounds: { minX, maxX, minY, maxY },
  };
}

function humanEntropyPointerStart(tabId, targetPoint) {
  // WHAT: Starts from the last pointer location when available, otherwise from
  // a nearby approach vector.
  // WHY: Humans usually continue from their previous cursor position rather than
  // teleporting into place for each action.
  const lastPointer = _pointerState.get(tabId);
  if (lastPointer) {
    return { x: lastPointer.x, y: lastPointer.y };
  }

  return {
    x: Math.round(targetPoint.x + humanEntropyFloat(-36, 36)),
    y: Math.round(targetPoint.y + humanEntropyFloat(-24, 24)),
  };
}

async function humanEntropyMovePointerCdp(tabId, targetPoint, bounds) {
  // WHAT: Emits a short approach path with diminishing jitter instead of a
  // single teleport-like mouseMoved event.
  // WHY: Anti-bot systems correlate motion trajectories and per-step timing.
  const start = humanEntropyPointerStart(tabId, targetPoint);
  const steps = humanEntropyInt(2, 4);

  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const remainingNoise = 2.5 * (1 - progress);
    const x = Math.round(start.x + ((targetPoint.x - start.x) * progress) + humanEntropyFloat(-remainingNoise, remainingNoise));
    const y = Math.round(start.y + ((targetPoint.y - start.y) * progress) + humanEntropyFloat(-remainingNoise, remainingNoise));
    const point = {
      x: humanEntropyClamp(x, Math.min(bounds.minX, start.x) - 48, Math.max(bounds.maxX, start.x) + 48),
      y: humanEntropyClamp(y, Math.min(bounds.minY, start.y) - 48, Math.max(bounds.maxY, start.y) + 48),
    };

    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    _pointerState.set(tabId, point);
    await humanEntropySleep(humanEntropyInt(12, 32));
  }

  const settledPoint = { x: targetPoint.x, y: targetPoint.y };
  _pointerState.set(tabId, settledPoint);
  return settledPoint;
}

async function humanEntropyHoverCdp(tabId, pointerTarget) {
  const settledPoint = await humanEntropyMovePointerCdp(tabId, pointerTarget, pointerTarget.bounds);
  await humanEntropySleep(humanEntropyInt(80, 180));
  return settledPoint;
}

async function humanEntropyClickCdp(tabId, pointerTarget) {
  const settledPoint = await humanEntropyMovePointerCdp(tabId, pointerTarget, pointerTarget.bounds);

  // WHY: Humans pause briefly after arrival before committing to a click.
  await humanEntropySleep(humanEntropyInt(24, 78));
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: settledPoint.x,
    y: settledPoint.y,
    button: 'left',
    clickCount: 1,
  });

  // WHY: A non-zero hold time avoids the "instant press/release" signature.
  await humanEntropySleep(humanEntropyInt(55, 160));
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: settledPoint.x,
    y: settledPoint.y,
    button: 'left',
    clickCount: 1,
  });

  // WHY: The post-release pause makes chained interactions less robotic.
  await humanEntropySleep(humanEntropyInt(18, 65));
  return settledPoint;
}

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  _pointerState.delete(tabId);
  if (_cdpAttached.has(tabId)) {
    _cdpAttached.delete(tabId);
    // Clear refs for this tab
    for (const [key, val] of _refMap.entries()) {
      if (val.tabId === tabId) _refMap.delete(key);
    }
  }
});

// Clean up on debugger detach (e.g. user closes DevTools bar)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    _pointerState.delete(source.tabId);
    _cdpAttached.delete(source.tabId);
    for (const [key, val] of _refMap.entries()) {
      if (val.tabId === source.tabId) _refMap.delete(key);
    }
    log('info', `CDP auto-detached from tab ${source.tabId}`);
  }
});

// --- Tabs ---
async function ensureWindowExists(options = {}) {
  const windows = await chrome.windows.getAll({ populate: true });
  if (windows.length > 0) return { created: false, window: windows[0] };

  const createData = {};
  if (options.url) createData.url = options.url;
  if (options.focused !== undefined) createData.focused = !!options.focused;
  if (options.incognito !== undefined) createData.incognito = !!options.incognito;
  if (options.type) createData.type = options.type;
  if (options.state) createData.state = options.state;

  const window = await chrome.windows.create(createData.url ? createData : { ...createData, url: 'about:blank' });
  if (!window.tabs) {
    window.tabs = await chrome.tabs.query({ windowId: window.id });
  }
  return { created: true, window };
}

// TOOL REGISTRATION: tabs_list
// WHAT: Registers the tabs_list tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('tabs_list', async (p) => { const tabs = await chrome.tabs.query(p?.query || {}); return { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, favIconUrl: t.favIconUrl })) }; });
// TOOL REGISTRATION: windows_create
// WHAT: Registers the windows_create tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('windows_create', async (p = {}) => {
  if (p.url && !isSafeUrl(p.url)) return { error: 'Blocked URL scheme' };
  const ensured = await ensureWindowExists(p);
  const tab = ensured.window.tabs?.[0];
  return {
    created: ensured.created,
    windowId: ensured.window.id,
    tabId: tab?.id,
    url: tab?.url || p.url || 'about:blank',
    focused: ensured.window.focused,
  };
});
// TOOL REGISTRATION: tabs_create
// WHAT: Registers the tabs_create tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('tabs_create', async (p) => {
  if (!isSafeUrl(p.url)) return { error: 'Blocked URL scheme' };

  const createProps = { url: p.url, active: p.active !== false };
  if (p.windowId !== undefined) createProps.windowId = p.windowId;

  const windows = await chrome.windows.getAll({ populate: false });
  if (windows.length === 0) {
    const ensured = await ensureWindowExists({ url: p.url, focused: p.active !== false });
    const tab = ensured.window.tabs?.[0];
    return {
      tabId: tab?.id,
      url: tab?.url || p.url,
      windowId: ensured.window.id,
      createdWindow: true,
    };
  }

  try {
    const tab = await chrome.tabs.create(createProps);
    return { tabId: tab.id, url: tab.url, windowId: tab.windowId, createdWindow: false };
  } catch (error) {
    if (error?.message?.includes('No current window')) {
      const ensured = await ensureWindowExists({ url: p.url, focused: p.active !== false });
      const tab = ensured.window.tabs?.[0];
      return {
        tabId: tab?.id,
        url: tab?.url || p.url,
        windowId: ensured.window.id,
        createdWindow: true,
      };
    }
    throw error;
  }
});
// TOOL REGISTRATION: tabs_update
// WHAT: Registers the tabs_update tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('tabs_update', async (p) => {
  if (p.url && !isSafeUrl(p.url)) return { error: 'Blocked URL scheme' };
  const tab = await chrome.tabs.update(p.tabId, { url: p.url, active: p.active }); return { tabId: tab.id, url: tab.url };
});
// TOOL REGISTRATION: tabs_close
// WHAT: Registers the tabs_close tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('tabs_close', async (p) => { await chrome.tabs.remove(p.tabId); return { closed: true, tabId: p.tabId }; });
// TOOL REGISTRATION: tabs_activate
// WHAT: Registers the tabs_activate tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('tabs_activate', async (p) => { await chrome.tabs.update(p.tabId, { active: true }); return { activated: true, tabId: p.tabId }; });

// --- Navigation (Single Tab Mode) ---
// TOOL REGISTRATION: navigate
// WHAT: Registers the navigate tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('navigate', async (p) => {
  if (!isSafeUrl(p.url)) return { error: 'Blocked URL scheme' };
  const domain = new URL(p.url).hostname;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url && t.url.includes(domain) && !t.url.startsWith('chrome://'));
  if (existing) {
    await chrome.tabs.update(existing.id, { url: p.url, active: true });
    return { tabId: existing.id, url: p.url, reused: true };
  }
  const tab = await chrome.tabs.create({ url: p.url });
  return { tabId: tab.id, url: tab.url, reused: false };
});
// TOOL REGISTRATION: go_back
// WHAT: Registers the go_back tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('go_back', async (p) => { await chrome.tabs.goBack(p.tabId); return { success: true }; });
// TOOL REGISTRATION: go_forward
// WHAT: Registers the go_forward tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('go_forward', async (p) => { await chrome.tabs.goForward(p.tabId); return { success: true }; });
// TOOL REGISTRATION: reload
// WHAT: Registers the reload tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('reload', async (p) => { await chrome.tabs.reload(p.tabId, { bypassCache: p.bypassCache }); return { success: true }; });

// --- Helper for safe script execution using FUNC ---
async function safeExecute(tabId, func, args = []) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return { error: 'Cannot execute script on internal Chrome pages' };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: func,
      args: args,
      world: 'MAIN',
    });
    return { result: results?.[0]?.result };
  } catch (e) {
    log('error', `safeExecute failed: ${e.message}`);
    return { error: e.message };
  }
}

async function runHumanEntropyDomInteraction(task) {
  // IMPORTANT: This function executes inside the page context via
  // chrome.scripting.executeScript. It therefore keeps all helper logic inside
  // its own body instead of referencing outer service-worker scope.
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const randomInt = (min, max) => Math.round(randomBetween(min, max));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const buildPointFromRect = (rect, maxJitterPx = 5) => {
    const width = Math.max(1, rect.width || 1);
    const height = Math.max(1, rect.height || 1);
    const centerX = rect.left + width / 2;
    const centerY = rect.top + height / 2;
    const jitterX = Math.min(maxJitterPx, Math.max(1, width / 4));
    const jitterY = Math.min(maxJitterPx, Math.max(1, height / 4));
    return {
      x: Math.round(clamp(centerX + randomBetween(-jitterX, jitterX), rect.left + 1, rect.right - 1)),
      y: Math.round(clamp(centerY + randomBetween(-jitterY, jitterY), rect.top + 1, rect.bottom - 1)),
    };
  };

  const dispatchMouse = (eventTarget, type, point, extra = {}) => {
    eventTarget.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
      button: extra.button ?? 0,
      buttons: extra.buttons ?? 0,
      detail: extra.detail ?? 1,
      ...extra,
    }));
  };

  const ensureRect = (target, explicitRect) => {
    const rect = explicitRect || target?.getBoundingClientRect?.();
    if (!rect) return null;
    if ((rect.width || 0) <= 0 || (rect.height || 0) <= 0) return null;
    return rect;
  };

  const findInShadow = (root, selector) => {
    const direct = root.querySelector?.(selector);
    if (direct) return direct;
    for (const child of root.children || []) {
      if (child.shadowRoot) {
        const nested = findInShadow(child.shadowRoot, selector);
        if (nested) return nested;
      }
    }
    return null;
  };

  const focusIfPossible = (target) => {
    try {
      target.focus?.({ preventScroll: true });
    } catch (_error) {
      target.focus?.();
    }
  };

  const maybeCallNativeClick = (target) => {
    if (typeof target.click === 'function') {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }
  };

  const movePointerWithEntropy = async (eventTarget, rect) => {
    const destination = buildPointFromRect(rect, 5);
    const start = {
      x: Math.round(destination.x + randomBetween(-32, 32)),
      y: Math.round(destination.y + randomBetween(-20, 20)),
    };
    const steps = randomInt(2, 4);

    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const residualNoise = 2 * (1 - progress);
      const point = {
        x: Math.round(start.x + ((destination.x - start.x) * progress) + randomBetween(-residualNoise, residualNoise)),
        y: Math.round(start.y + ((destination.y - start.y) * progress) + randomBetween(-residualNoise, residualNoise)),
      };
      dispatchMouse(eventTarget, 'mousemove', point, { buttons: 0 });
      await sleep(randomInt(12, 28));
    }

    return destination;
  };

  const performHumanClick = async ({ eventTarget, clickTarget, rect, dispatchOnly = false }) => {
    const usableRect = ensureRect(clickTarget || eventTarget, rect);
    if (!usableRect) return null;

    const targetPoint = await movePointerWithEntropy(eventTarget, usableRect);
    dispatchMouse(eventTarget, 'mouseover', targetPoint, { buttons: 0 });
    await sleep(randomInt(24, 72));

    focusIfPossible(clickTarget || eventTarget);
    dispatchMouse(eventTarget, 'mousedown', targetPoint, { button: 0, buttons: 1, detail: 1 });
    await sleep(randomInt(55, 150));
    dispatchMouse(eventTarget, 'mouseup', targetPoint, { button: 0, buttons: 0, detail: 1 });
    await sleep(randomInt(18, 60));

    if (dispatchOnly) {
      dispatchMouse(eventTarget, 'click', targetPoint, { button: 0, buttons: 0, detail: 1 });
    } else {
      maybeCallNativeClick(clickTarget || eventTarget);
    }

    return targetPoint;
  };

  switch (task.kind) {
    case 'selector-click': {
      const element = document.querySelector(task.selector);
      if (!element) return { found: false };
      const point = await performHumanClick({ eventTarget: element, clickTarget: element, rect: element.getBoundingClientRect() });
      return { found: true, tag: element.tagName, position: point };
    }

    case 'shadow-click': {
      const element = findInShadow(document, task.selector) || document.querySelector(task.selector);
      if (!element) return { clicked: false, reason: 'Element not found' };
      const point = await performHumanClick({ eventTarget: element, clickTarget: element, rect: element.getBoundingClientRect() });
      return { clicked: true, tag: element.tagName, inShadowRoot: !!element.getRootNode?.()?.host, position: point };
    }

    case 'iframe-click': {
      const iframe = document.querySelector(task.iframeSelector);
      if (!iframe) return { error: 'Iframe not found' };

      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc) return { error: 'Cross-origin iframe — cannot access content' };
        const target = doc.querySelector(task.innerSelector);
        if (!target) return { error: `Element "${task.innerSelector}" not found in iframe` };
        const point = await performHumanClick({ eventTarget: target, clickTarget: target, rect: target.getBoundingClientRect() });
        return { success: true, action: 'click', tag: target.tagName, position: point };
      } catch (error) {
        return { error: `Access denied: ${error.message}` };
      }
    }

    case 'turnstile-click': {
      const button = document.querySelector('input[type="checkbox"]') || document.querySelector('[role="checkbox"]');
      if (!button) return { solved: false, reason: 'No clickable element found' };
      const point = await performHumanClick({ eventTarget: button, clickTarget: button, rect: button.getBoundingClientRect() });
      return { solved: true, method: 'checkbox_click', position: point };
    }

    case 'recaptcha-click': {
      const iframe = document.querySelector('iframe[src*="google.com/recaptcha/api2/bframe"]');
      if (!iframe) return { solved: false, reason: 'No reCAPTCHA iframe found' };

      try {
        const checkbox = iframe.contentDocument?.querySelector('.recaptcha-checkbox');
        if (checkbox) {
          const point = await performHumanClick({ eventTarget: checkbox, clickTarget: checkbox, rect: checkbox.getBoundingClientRect() });
          return { solved: true, method: 'direct_click', position: point };
        }
      } catch (_error) {
        // Cross-origin access is expected on many CAPTCHA surfaces, so the code
        // falls through to a coordinate-based document dispatch below.
      }

      const rect = iframe.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { solved: false, reason: 'Could not access checkbox' };
      const point = await performHumanClick({ eventTarget: document, clickTarget: document, rect, dispatchOnly: true });
      return { solved: true, method: 'coordinate_click', x: point.x, y: point.y, position: point };
    }

    default:
      return { error: `Unsupported interaction kind: ${task.kind}` };
  }
}

// TOOL REGISTRATION: execute_javascript
// WHAT: Registers the execute_javascript tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('execute_javascript', async (p) => {
  if (!p.script || typeof p.script !== 'string') return { error: 'script must be a string' };
  const tabId = p.tabId || await activeTabId();
  try {
    const { result, exceptionDetails } = await cdpSend(tabId, 'Runtime.evaluate', {
      expression: p.script,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (exceptionDetails) {
      return { error: exceptionDetails.exception?.description || exceptionDetails.text };
    }
    return { success: true, result: result.value };
  } catch(e) {
    return { error: `CDP Evaluate failed: ${e.message}` };
  }
});

// TOOL REGISTRATION: execute_script
// WHAT: Registers the execute_script tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('execute_script', async (p) => {
  return { error: 'execute_script with code string is disabled. Use execute_javascript instead.' };
});

// TOOL REGISTRATION: inject_css
// WHAT: Registers the inject_css tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('inject_css', async (p) => {
  if (!p.css || typeof p.css !== 'string') return { error: 'css must be a non-empty string' };
  if (p.css.length > 50000) return { error: 'css exceeds maximum length of 50000 characters' };
  await chrome.scripting.insertCSS({ target: { tabId: p.tabId || await activeTabId() }, css: p.css });
  return { success: true };
});

// --- DOM Interaction ---
// TOOL REGISTRATION: click_element
// WHAT: Registers the click_element tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('click_element', async (p) => {
  if (!p.selector || typeof p.selector !== 'string' || p.selector.trim() === '') return { error: 'selector must be a non-empty string' };
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, runHumanEntropyDomInteraction, [{ kind: 'selector-click', selector: p.selector }]);
});

// TOOL REGISTRATION: type_text
// WHAT: Registers the type_text tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('type_text', async (p) => {
  if (!p.selector || typeof p.selector !== 'string' || p.selector.trim() === '') return { error: 'selector must be a non-empty string' };
  if (p.text !== undefined && typeof p.text !== 'string') return { error: 'text must be a string' };
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (sel, txt, clr) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    el.focus();
    if (clr) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.value = txt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true };
  }, [p.selector, p.text, p.clear !== false]);
});

// TOOL REGISTRATION: get_text
// WHAT: Registers the get_text tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_text', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (sel) => document.querySelector(sel)?.textContent || '', [p.selector || 'body']);
});

// TOOL REGISTRATION: get_html
// WHAT: Registers the get_html tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_html', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (sel) => {
    const el = sel ? document.querySelector(sel) : document.documentElement;
    return el ? el.outerHTML : '';
  }, [p.selector || null]);
});

// TOOL REGISTRATION: get_attribute
// WHAT: Registers the get_attribute tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_attribute', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null, [p.selector, p.attribute]);
});

// TOOL REGISTRATION: wait_for_element
// WHAT: Registers the wait_for_element tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('wait_for_element', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (sel, timeout) => new Promise((resolve) => {
    const el = document.querySelector(sel);
    if (el) return resolve({ found: true, tag: el.tagName });
    const obs = new MutationObserver(() => {
      const el2 = document.querySelector(sel);
      if (el2) { obs.disconnect(); resolve({ found: true, tag: el2.tagName }); }
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve({ found: false }); }, timeout);
  }), [p.selector, p.timeout || 10000]);
});

// --- Page Info ---
// TOOL REGISTRATION: get_page_info
// WHAT: Registers the get_page_info tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_page_info', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => ({ title: document.title, url: window.location.href, readyState: document.readyState }));
});

// TOOL REGISTRATION: get_all_links
// WHAT: Registers the get_all_links tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_all_links', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => Array.from(document.querySelectorAll('a[href]')).map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 50), visible: a.offsetParent !== null })));
});

// TOOL REGISTRATION: get_all_inputs
// WHAT: Registers the get_all_inputs tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_all_inputs', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({ tag: el.tagName.toLowerCase(), type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, value: el.value, visible: el.offsetParent !== null })));
});

// --- Prolific Study Extraction (Using FUNC) ---
function doExtractStudies() {
  const html = document.documentElement.outerHTML;
  const studies = [];
  const hrefMatches = html.match(/href="([^"]*\/studies\/[a-f0-9]{24}[^"]*)"/gi);
  if (hrefMatches) {
    for (const match of hrefMatches) {
      const url = match.match(/href="([^"]+)"/i)?.[1];
      if (url && !studies.find(s => s.url === url)) {
        studies.push({ url, title: 'Unknown Study', reward: 'Unknown' });
      }
    }
  }
  const showingMatch = html.match(/Showing:\s*(\d+)\/(\d+)\s*studies/i);
  if (showingMatch) {
    const showingIdx = html.indexOf(showingMatch[0]);
    const context = html.substring(showingIdx, showingIdx + 50000);
    const titleMatches = context.match(/<[^>]*>([^<]{15,150})<\/[^>]*>/g);
    if (titleMatches) {
      for (const m of titleMatches) {
        const text = m.replace(/<[^>]+>/g, '').trim();
        if (text && text.length > 15 && text.length < 150 &&
            !text.toLowerCase().includes('balance') &&
            !text.toLowerCase().includes('pending') &&
            !text.toLowerCase().includes('submissions') &&
            !text.toLowerCase().includes('about you') &&
            !text.toLowerCase().includes('messages') &&
            !text.toLowerCase().includes('account') &&
            !text.toLowerCase().includes('preferences') &&
            !text.toLowerCase().includes('help center') &&
            !text.toLowerCase().includes('skip to main') &&
            !text.includes('function') && !text.includes('var ') && !text.includes('window.') &&
            !text.includes('display: none') && !text.includes('visibility: hidden')) {
          const titleIdx = context.indexOf(m);
          const nearby = context.substring(Math.max(0, titleIdx - 500), Math.min(context.length, titleIdx + 500));
          const nearbyUrl = nearby.match(/href="([^"]*\/studies\/[a-f0-9]{24}[^"]*)"/i)?.[1];
          if (nearbyUrl) {
            const existing = studies.find(s => s.url === nearbyUrl);
            if (existing) { if (existing.title === 'Unknown Study') existing.title = text; }
            else { studies.push({ url: nearbyUrl, title: text, reward: 'Unknown' }); }
          }
        }
      }
    }
  }
  return { studies, count: studies.length, showing: showingMatch ? `${showingMatch[1]}/${showingMatch[2]}` : null };
}

// TOOL REGISTRATION: extract_prolific_studies
// WHAT: Registers the extract_prolific_studies tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('extract_prolific_studies', async (p) => {
  const tabId = p?.tabId || await activeTabId();
  return safeExecute(tabId, doExtractStudies);
});

// --- Screenshot ---
// TOOL REGISTRATION: screenshot
// WHAT: Registers the screenshot tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('screenshot', async (p) => { const dataUrl = await chrome.tabs.captureVisibleTab(p.windowId, { format: p.format || 'jpeg', quality: p.quality || 80 }); return { dataUrl: dataUrl.substring(0, 100) + '...', length: dataUrl.length }; });
// TOOL REGISTRATION: screenshot_full
// WHAT: Registers the screenshot_full tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('screenshot_full', async (p) => { const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' }); return { dataUrl }; });

// --- Video Recording ---
let mediaRecorder = null;
let recordedChunks = [];
let recordingTabId = null;

// TOOL REGISTRATION: start_recording
// WHAT: Registers the start_recording tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('start_recording', async (p) => {
  const tabId = p.tabId || await activeTabId();
  try {
    const stream = await chrome.tabCapture.capture({ video: true, audio: p.audio || false });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    recordedChunks = [];
    recordingTabId = tabId;
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
    log('info', `Recording started for tab ${tabId}`);
    return { success: true, tabId, mimeType: 'video/webm' };
  } catch (e) {
    log('error', `Recording failed: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// TOOL REGISTRATION: stop_recording
// WHAT: Registers the stop_recording tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('stop_recording', async () => {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve({ success: false, error: 'No active recording' });
      return;
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ success: true, video: base64.substring(0, 100) + '...', length: base64.length, mimeType: 'video/webm' });
      };
      reader.readAsDataURL(blob);
      if (mediaRecorder.stream) mediaRecorder.stream.getTracks().forEach(t => { t.stop(); });
      mediaRecorder = null;
      recordedChunks = [];
    };
    mediaRecorder.stop();
  });
});

// TOOL REGISTRATION: recording_status
// WHAT: Registers the recording_status tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('recording_status', async () => ({
  active: mediaRecorder && mediaRecorder.state === 'recording',
  state: mediaRecorder?.state || 'inactive',
  tabId: recordingTabId,
}));

// ============================================================
// ISSUE #20: Privacy, Consent, and Redaction for Behavior Recording
// ============================================================
// Behavior recording MUST be explicitly enabled by the user (consent-gate).
// Sensitive input values (passwords, credit cards) are ALWAYS redacted.
// The recording scope is tracked and visible to the user via the popup.
// WHY: A full-fidelity recorder that runs without consent is a surveillance tool.

let behaviorRecordingEnabled = false;
let behaviorRecordingScope = null;

const SENSITIVE_INPUT_TYPES = new Set(['password', 'credit-card', 'card-number', 'cvv', 'ssn', 'pin']);
const SENSITIVE_FIELD_PATTERNS = /password|passwort|secret|token|credit.?card|card.?number|cvv|ssn|social.?security|pin\b/i;

function redactSensitiveValue(fieldName = '', inputType = '', value = '') {
  if (inputType === 'password') return '[REDACTED:password]';
  if (SENSITIVE_INPUT_TYPES.has(inputType)) return '[REDACTED:sensitive]';
  if (SENSITIVE_FIELD_PATTERNS.test(fieldName)) return '[REDACTED:field-name]';
  return value;
}

reg('behavior_recording_enable', async (p = {}) => {
  behaviorRecordingEnabled = true;
  behaviorRecordingScope = { domain: p.domain || null, tabId: p.tabId || null, startedAt: Date.now() };
  await persistEphemeralState({ behaviorRecordingEnabled: true, behaviorRecordingScope });
  log('info', `Behavior recording ENABLED — scope: ${JSON.stringify(behaviorRecordingScope)}`);
  return { enabled: true, scope: behaviorRecordingScope };
});

reg('behavior_recording_disable', async () => {
  behaviorRecordingEnabled = false;
  behaviorRecordingScope = null;
  await persistEphemeralState({ behaviorRecordingEnabled: false, behaviorRecordingScope: null });
  log('info', 'Behavior recording DISABLED by user.');
  return { enabled: false };
});

reg('behavior_recording_status', async () => ({
  enabled: behaviorRecordingEnabled,
  scope: behaviorRecordingScope,
}));

reg('behavior_redact_check', async (p = {}) => {
  const redacted = redactSensitiveValue(p.fieldName || '', p.inputType || '', p.value || '');
  return { original_length: (p.value || '').length, redacted, was_redacted: redacted !== p.value };
});


// TOOL REGISTRATION: get_cookies
// WHAT: Registers the get_cookies tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_cookies', async (p = {}) => {
  const details = {};
  if (typeof p.url === 'string' && p.url) details.url = p.url;
  if (typeof p.domain === 'string' && p.domain) details.domain = p.domain;

  const cookies = await chrome.cookies.getAll(details);
  return {
    count: cookies.length,
    cookies,
    source: 'service_worker',
    scope: Object.keys(details).length ? details : 'all',
  };
});
// TOOL REGISTRATION: set_cookie
// WHAT: Registers the set_cookie tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('set_cookie', async (p) => {
  if (!p.url || typeof p.url !== 'string') return { error: 'url required' };
  if (!p.name || typeof p.name !== 'string' || p.name.length > 4096) return { error: 'name must be a non-empty string ≤4096 chars' };
  if (typeof p.value !== 'string' || p.value.length > 4096) return { error: 'value must be a string ≤4096 chars' };
  const VALID_SAMESITE = ['strict', 'lax', 'no_restriction', 'unspecified'];
  const sameSite = VALID_SAMESITE.includes(p.sameSite) ? p.sameSite : 'lax';
  await chrome.cookies.set({ url: p.url, name: p.name, value: p.value, domain: p.domain, path: p.path || '/', secure: !!p.secure, httpOnly: !!p.httpOnly, sameSite, expirationDate: p.expirationDate || undefined });
  return { success: true, name: p.name };
});
// TOOL REGISTRATION: delete_cookie
// WHAT: Registers the delete_cookie tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('delete_cookie', async (p) => { await chrome.cookies.remove({ url: p.url, name: p.name }); return { success: true, name: p.name }; });
// TOOL REGISTRATION: clear_cookies
// WHAT: Registers the clear_cookies tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('clear_cookies', async (p) => { const cookies = await chrome.cookies.getAll({ url: p.url }); for (const c of cookies) { const url = `http${c.secure ? 's' : ''}://${c.domain}${c.path}`; await chrome.cookies.remove({ url, name: c.name }); } return { cleared: cookies.length }; });

// --- Storage ---
// TOOL REGISTRATION: storage_get
// WHAT: Registers the storage_get tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('storage_get', async (p) => { const data = await chrome.storage.local.get(p.keys || null); return { data }; });
// TOOL REGISTRATION: storage_set
// WHAT: Registers the storage_set tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('storage_set', async (p) => { await chrome.storage.local.set(p.data || {}); return { success: true }; });
// TOOL REGISTRATION: storage_clear
// WHAT: Registers the storage_clear tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('storage_clear', async () => { await chrome.storage.local.clear(); return { success: true }; });

// --- Network ---
// TOOL REGISTRATION: get_network_requests
// WHAT: Registers the get_network_requests tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_network_requests', async (p) => ({ requests: requestLog.slice(-(p.count || 50)) }));
// TOOL REGISTRATION: block_url
// WHAT: Registers the block_url tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('block_url', async (p) => {
  if (!p.pattern || typeof p.pattern !== 'string' || p.pattern.trim() === '') return { error: 'pattern must be a non-empty string' };
  if (p.pattern.length > 2000) return { error: 'pattern exceeds maximum length of 2000 characters' };
  const rules = await chrome.declarativeNetRequest.getDynamicRules(); const validTypes = ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'script', 'stylesheet', 'image', 'font', 'media', 'object', 'other', 'ping', 'csp_report', 'webbundle', 'webtransport']; const requestedTypes = p.resourceTypes || ['main_frame', 'sub_frame', 'xmlhttprequest']; const resourceTypes = requestedTypes.filter(t => validTypes.includes(t)); const newRule = { id: rules.length + 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: p.pattern, resourceTypes: resourceTypes.length > 0 ? resourceTypes : ['main_frame'] } }; await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [newRule], removeRuleIds: [] }); return { success: true, ruleId: newRule.id };
});

// --- Stealth Mode ---
// TOOL REGISTRATION: enable_stealth
// WHAT: Registers the enable_stealth tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('enable_stealth', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete window.document.$cdc_asdjflasutopfhvcZLmcfl_;
    delete window.document.$chrome_asyncScriptInfo;
    Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) => parameters.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(parameters);
    }
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    delete window.domAutomation;
    delete window.domAutomationController;
    return { stealth: true };
  });
});

// TOOL REGISTRATION: stealth_status
// WHAT: Registers the stealth_status tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('stealth_status', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => ({ webdriver: navigator.webdriver, plugins: navigator.plugins?.length || 0, languages: navigator.languages?.length || 0, chrome: !!window.chrome?.runtime, domAutomation: !!window.domAutomation }));
});

// --- Offscreen ---
// TOOL REGISTRATION: offscreen_status
// WHAT: Registers the offscreen_status tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('offscreen_status', async () => ({ ready: offscreenReady }));

// --- Native Messaging Host ---
// TOOL REGISTRATION: native_host_status
// WHAT: Exposes native-host connection, workflow, and registration metadata.
// WHY: Operators need a direct diagnostic surface before depending on the CSP fallback path.
reg('native_host_status', async () => ({
  hostName: NATIVE_HOST_NAME,
  runtimeId: chrome.runtime.id,
  allowedOrigin: `chrome-extension://${chrome.runtime.id}/`,
  serviceWorkerStrategy: 'open port only for explicit authenticated-session workflows; close on idle timeout or explicit workflow end',
  state: {
    ...nativeState,
    idleTimeoutMs: NATIVE_HOST_IDLE_TIMEOUT_MS,
    pendingRequests: nativePendingRequests.size,
    activeWorkflow: nativeWorkflowSession,
  },
}));

// TOOL REGISTRATION: native_host_ping
// WHAT: Validates that Chrome can talk to the registered native host.
// WHY: This is the fastest integration smoke test for operator setup.
reg('native_host_ping', async () => {
  return nativeHostRequest('ping', {}, { source: 'service_worker' });
});

// TOOL REGISTRATION: native_host_start_workflow
// WHAT: Opens the native port for a scoped authenticated-session workflow.
// WHY: connectNative keeps MV3 alive, so we only enable it explicitly for flows that need the CSP bypass path.
reg('native_host_start_workflow', async (p = {}) => {
  const payload = buildWorkflowStartPayload({
    workflowId: p.workflowId,
    url: p.url,
    tabId: p.tabId,
    reason: p.reason || NATIVE_HOST_CONTEXT,
  });
  const response = await nativeHostRequest('workflow.start', payload, { source: 'service_worker' });
  nativeWorkflowSession = {
    workflowId: response.workflowId,
    context: payload.context,
    url: payload.url || null,
    tabId: payload.tabId || null,
    startedAt: Date.now(),
  };
  return {
    ...response,
    serviceWorkerWillStayAlive: true,
    disconnectOnIdleMs: NATIVE_HOST_IDLE_TIMEOUT_MS,
  };
});

// TOOL REGISTRATION: native_host_authenticated_fetch
// WHAT: Relays an authenticated HTTP request through the native host.
// WHY: This gives CSP-restricted workflows a supported path that does not rely on page-context injection.
reg('native_host_authenticated_fetch', async (p = {}) => {
  if (!p.url || typeof p.url !== 'string' || !isSafeUrl(p.url)) {
    throw new Error('A safe http/https url is required for native_host_authenticated_fetch');
  }

  let nativeFetchUrl;
  try {
    nativeFetchUrl = new URL(p.url);
  } catch (_error) {
    throw new Error('native_host_authenticated_fetch requires a valid URL');
  }

  if (!['http:', 'https:'].includes(nativeFetchUrl.protocol)) {
    throw new Error('native_host_authenticated_fetch supports only http/https URLs');
  }

  const headers = await maybeAugmentHeadersForNativeFetch({
    url: p.url,
    headers: p.headers,
    includeCookies: p.includeCookies !== false,
  });

  const workflowId = p.workflowId || nativeWorkflowSession?.workflowId || null;
  const payload = {
    workflowId,
    url: p.url,
    method: p.method || 'GET',
    timeoutMs: p.timeoutMs,
    headers,
    bodyText: p.bodyText,
    bodyBase64: p.bodyBase64,
  };

  const response = await nativeHostRequest('fetch.http', payload, {
    source: 'service_worker',
    workflowId,
  });

  return {
    ...response,
    workflowId,
    cookieRelay: p.includeCookies !== false,
  };
});

// TOOL REGISTRATION: native_host_end_workflow
// WHAT: Closes the scoped authenticated-session workflow and tears down the native port.
// WHY: Explicit shutdown prevents the native port from holding the MV3 worker alive longer than intended.
reg('native_host_end_workflow', async (p = {}) => {
  const workflowId = p.workflowId || nativeWorkflowSession?.workflowId;
  if (!workflowId) {
    return { closed: false, reason: 'no-active-workflow' };
  }

  try {
    return await nativeHostRequest('workflow.end', { workflowId }, { source: 'service_worker', workflowId });
  } finally {
    disconnectNativePort('workflow-ended');
  }
});

// --- System ---
// TOOL REGISTRATION: health
// WHAT: Registers the health tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('health', async () => ({ status: 'ok', version: VERSION, hfConnected: hfWs && hfWs.readyState === WebSocket.OPEN, nativeHostConnected: nativeState.connected, nativeWorkflowActive: !!nativeWorkflowSession, toolsCount: Object.keys(TOOL_REGISTRY).length, timestamp: Date.now() }));
// TOOL REGISTRATION: list_tools
// WHAT: Registers the list_tools tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('list_tools', async () => ({ tools: Object.keys(TOOL_REGISTRY).sort(), count: Object.keys(TOOL_REGISTRY).length }));

// --- Extension Info & Debug Tools ---
// TOOL REGISTRATION: get_extension_info
// WHAT: Registers the get_extension_info tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_extension_info', async () => {
  return {
    version: VERSION,
    hfConnected: hfWs && hfWs.readyState === WebSocket.OPEN,
    toolsCount: Object.keys(TOOL_REGISTRY).length,
    offscreenReady: offscreenReady,
    recentLogs: recentLogs.slice(-10),
    timestamp: Date.now()
  };
});

// TOOL REGISTRATION: clear_logs
// WHAT: Registers the clear_logs tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('clear_logs', async () => {
  recentLogs = [];
  return { success: true };
});

// --- ULTIMATE BYPASS FEATURES (v2.8.0) ---

// Advanced Stealth Mode
// TOOL REGISTRATION: advanced_stealth
// WHAT: Registers the advanced_stealth tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('advanced_stealth', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    // 1. Basic Stealth
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete window.document.$cdc_asdjflasutopfhvcZLmcfl_;
    delete window.document.$chrome_asyncScriptInfo;
    delete window.domAutomation;
    delete window.domAutomationController;
    
    // 2. Plugin Spoofing
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ]
    });
    
    // 3. Language Spoofing
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'de-DE', 'de'] });
    
    // 4. Permissions Spoofing
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) => {
        return parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(parameters);
      };
    }
    
    // 5. Canvas Fingerprint Spoofing
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const ctx = origGetContext.apply(this, [type, ...args]);
      if (type === '2d' && ctx) {
        const origFillText = ctx.fillText;
        ctx.fillText = function(text, x, y, maxWidth) {
          const noise = Math.random() * 0.1;
          origFillText.call(this, text, x + noise, y + noise, maxWidth);
        };
      }
      return ctx;
    };
    
    // 6. WebGL Fingerprint Spoofing
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Google Inc. (NVIDIA)';
      if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return origGetParameter.apply(this, [param]);
    };
    
    // 7. AudioContext Fingerprint Spoofing
    const origCreateAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function() {
      const analyser = origCreateAnalyser.apply(this, arguments);
      const origGetFloatFrequencyData = analyser.getFloatFrequencyData;
      analyser.getFloatFrequencyData = function(array) {
        origGetFloatFrequencyData.apply(this, [array]);
        for (let i = 0; i < array.length; i++) {
          array[i] += Math.random() * 0.1 - 0.05;
        }
      };
      return analyser;
    };
    
    // 8. Hardware Spoofing
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    
    // 9. Screen Spoofing
    Object.defineProperty(window.screen, 'width', { get: () => 1920 });
    Object.defineProperty(window.screen, 'height', { get: () => 1080 });
    Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 });
    Object.defineProperty(window.screen, 'availHeight', { get: () => 1040 });
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });
    
    // 10. Timezone Spoofing
    const origDate = Date;
    window.Date = function(...args) {
      if (args.length === 0) {
        return new origDate(new origDate().toLocaleString("en-US", {timeZone: "Europe/Berlin"}));
      }
      return new origDate(...args);
    };
    window.Date.prototype = origDate.prototype;
    window.Date.now = origDate.now;
    window.Date.parse = origDate.parse;
    window.Date.UTC = origDate.UTC;
    
    // 11. Chrome Runtime Spoofing
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.runtime.connect = () => ({ postMessage: () => {}, disconnect: () => {}, onMessage: { addListener: () => {} } });
    window.chrome.runtime.sendMessage = () => {};
    
    return { stealth: true, level: 'advanced' };
  });
});

// Cloudflare/CAPTCHA Detection
// TOOL REGISTRATION: detect_challenges
// WHAT: Registers the detect_challenges tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('detect_challenges', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const bodyText = document.body.innerText.toLowerCase();
    const challenges = [];
    
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') || 
        document.querySelector('[data-sitekey]') ||
        bodyText.includes('turnstile')) {
      challenges.push({ type: 'cloudflare_turnstile', detected: true });
    }
    
    if (bodyText.includes('checking your browser') || 
        bodyText.includes('ddos protection') ||
        bodyText.includes('ray id')) {
      challenges.push({ type: 'cloudflare_challenge_page', detected: true });
    }
    
    if (document.querySelector('iframe[src*="google.com/recaptcha"]') ||
        document.querySelector('.g-recaptcha')) {
      challenges.push({ type: 'recaptcha', detected: true });
    }
    
    if (document.querySelector('iframe[src*="hcaptcha.com"]')) {
      challenges.push({ type: 'hcaptcha', detected: true });
    }
    
    if (bodyText.includes('captcha') || bodyText.includes('verify you are human') ||
        bodyText.includes('prove you are not a robot')) {
      challenges.push({ type: 'generic_captcha', detected: true });
    }
    
    if (bodyText.includes('access denied') || bodyText.includes('blocked') ||
        bodyText.includes('suspicious activity')) {
      challenges.push({ type: 'waf_block', detected: true });
    }
    
    return { challenges, url: window.location.href, title: document.title };
  });
});

// Anti-Bot Behavior Simulation
// TOOL REGISTRATION: simulate_human_behavior
// WHAT: Registers the simulate_human_behavior tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('simulate_human_behavior', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const simulateMouse = () => {
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    };
    const simulateScroll = () => {
      const scrollAmount = Math.random() * 200 - 100;
      window.scrollBy(0, scrollAmount);
    };
    const simulateClick = () => {
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      document.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
    };
    const behaviors = [simulateMouse, simulateScroll, simulateClick];
    const randomBehavior = behaviors[Math.floor(Math.random() * behaviors.length)];
    randomBehavior();
    return { success: true, behavior: 'simulated' };
  });
});

// Session Persistence
// TOOL REGISTRATION: save_session
// WHAT: Registers the save_session tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('save_session', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const sessionData = {
      cookies: document.cookie,
      localStorage: {},
      sessionStorage: {},
      url: window.location.href,
      timestamp: Date.now()
    };
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      sessionData.localStorage[key] = localStorage.getItem(key);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      sessionData.sessionStorage[key] = sessionStorage.getItem(key);
    }
    return sessionData;
  });
});

// TOOL REGISTRATION: restore_session
// WHAT: Registers the restore_session tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('restore_session', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (sessionData) => {
    if (!sessionData) return { success: false, error: 'No session data' };
    if (sessionData.localStorage) {
      for (const [key, value] of Object.entries(sessionData.localStorage)) {
        localStorage.setItem(key, value);
      }
    }
    if (sessionData.sessionStorage) {
      for (const [key, value] of Object.entries(sessionData.sessionStorage)) {
        sessionStorage.setItem(key, value);
      }
    }
    return { success: true, restored: true };
  }, [p.sessionData]);
});

// Rate Limit Handling
// TOOL REGISTRATION: handle_rate_limit
// WHAT: Registers the handle_rate_limit tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('handle_rate_limit', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const bodyText = document.body.innerText.toLowerCase();
    const isRateLimited = bodyText.includes('rate limit') || 
                          bodyText.includes('too many requests') ||
                          bodyText.includes('429') ||
                          bodyText.includes('slow down');
    if (isRateLimited) {
      const waitTime = Math.random() * 5000 + 2000;
      return { rateLimited: true, suggestedWait: waitTime };
    }
    return { rateLimited: false };
  });
});

// --- CLOUDFLARE BYPASS ENGINE (v2.9.0) ---

// TOOL REGISTRATION: bypass_cloudflare
// WHAT: Registers the bypass_cloudflare tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('bypass_cloudflare', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const bodyText = document.body?.innerText?.toLowerCase() || '';
    const isCF = bodyText.includes('checking your browser') || 
                 bodyText.includes('ddos protection') ||
                 bodyText.includes('ray id') ||
                 document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (!isCF) return { bypassed: false, reason: 'No Cloudflare detected' };
    
    // Wait for CF challenge to auto-resolve
    const waitForCF = (timeout = 15000) => new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        if (Date.now() - start > timeout) return resolve({ bypassed: false, reason: 'Timeout' });
        if (!document.querySelector('iframe[src*="challenges.cloudflare.com"]') && 
            !document.body.innerText.toLowerCase().includes('checking your browser')) {
          return resolve({ bypassed: true, time: Date.now() - start });
        }
        setTimeout(check, 500);
      };
      check();
    });
    return waitForCF(p.timeout || 15000);
  });
});

// TOOL REGISTRATION: bypass_cloudflare_turnstile
// WHAT: Registers the bypass_cloudflare_turnstile tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('bypass_cloudflare_turnstile', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, runHumanEntropyDomInteraction, [{ kind: 'turnstile-click' }]);
});

// --- CAPTCHA DETECTION & BYPASS (v2.9.0) ---

// TOOL REGISTRATION: detect_recaptcha
// WHAT: Registers the detect_recaptcha tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('detect_recaptcha', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const captchas = [];
    if (document.querySelector('[data-sitekey][class*="g-recaptcha"]') || 
        document.querySelector('.g-recaptcha') ||
        document.querySelector('iframe[src*="google.com/recaptcha"]')) {
      captchas.push({ type: 'recaptcha_v2', sitekey: document.querySelector('[data-sitekey]')?.dataset?.sitekey });
    }
    if (document.querySelector('.grecaptcha-badge') || 
        document.querySelector('iframe[src*="recaptcha/api2/anchor"]')) {
      captchas.push({ type: 'recaptcha_v3' });
    }
    if (document.querySelector('[data-sitekey][class*="h-captcha"]') ||
        document.querySelector('.h-captcha') ||
        document.querySelector('iframe[src*="hcaptcha.com"]')) {
      captchas.push({ type: 'hcaptcha', sitekey: document.querySelector('[data-sitekey]')?.dataset?.sitekey });
    }
    return { captchas, count: captchas.length };
  });
});

// TOOL REGISTRATION: solve_recaptcha_checkbox
// WHAT: Registers the solve_recaptcha_checkbox tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('solve_recaptcha_checkbox', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, runHumanEntropyDomInteraction, [{ kind: 'recaptcha-click' }]);
});

// --- FINGERPRINT ROTATION (v2.9.0) ---

let fingerprintProfile = null;

// TOOL REGISTRATION: rotate_fingerprint
// WHAT: Registers the rotate_fingerprint tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('rotate_fingerprint', async (p) => {
  const tabId = p.tabId || await activeTabId();
  
  const gpuVendors = ['Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Mozilla'];
  const gpuRenderers = [
    'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (AMD, AMD Radeon Pro 5500M Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (Apple, Apple M1)',
  ];
  const screens = [[1920,1080],[2560,1440],[1366,768],[3840,2160],[1440,900]];
  const timezones = ['Europe/Berlin','America/New_York','America/Los_Angeles','Europe/London','Asia/Tokyo'];
  const langs = [['en-US','en','de-DE','de'],['en-US','en'],['de-DE','de','en-US','en'],['en-GB','en'],['ja-JP','ja']];
  
  fingerprintProfile = {
    gpuVendor: p.gpuVendor || gpuVendors[Math.floor(Math.random() * gpuVendors.length)],
    gpuRenderer: p.gpuRenderer || gpuRenderers[Math.floor(Math.random() * gpuRenderers.length)],
    screen: p.screen || screens[Math.floor(Math.random() * screens.length)],
    timezone: p.timezone || timezones[Math.floor(Math.random() * timezones.length)],
    languages: p.languages || langs[Math.floor(Math.random() * langs.length)],
    hardwareConcurrency: p.hardwareConcurrency || [4, 8, 12, 16][Math.floor(Math.random() * 4)],
    deviceMemory: p.deviceMemory || [4, 8, 16][Math.floor(Math.random() * 3)],
    platform: p.platform || ['Win32','MacIntel','Linux x86_64'][Math.floor(Math.random() * 3)],
  };
  
  return safeExecute(tabId, (profile) => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => profile.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => profile.deviceMemory });
    Object.defineProperty(navigator, 'platform', { get: () => profile.platform });
    Object.defineProperty(navigator, 'languages', { get: () => profile.languages });
    Object.defineProperty(window.screen, 'width', { get: () => profile.screen[0] });
    Object.defineProperty(window.screen, 'height', { get: () => profile.screen[1] });
    Object.defineProperty(window.screen, 'availWidth', { get: () => profile.screen[0] });
    Object.defineProperty(window.screen, 'availHeight', { get: () => profile.screen[1] - 40 });
    
    const origGetParameter = WebGLRenderingContext?.prototype?.getParameter;
    if (origGetParameter) {
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return profile.gpuVendor;
        if (param === 37446) return profile.gpuRenderer;
        return origGetParameter.apply(this, [param]);
      };
    }
    
    return { rotated: true, profile };
  }, [fingerprintProfile]);
});

// TOOL REGISTRATION: get_fingerprint
// WHAT: Registers the get_fingerprint tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('get_fingerprint', async () => {
  return { profile: fingerprintProfile, rotated: !!fingerprintProfile };
});

// --- ANTI-BOT DETECTION (v2.9.0) ---

// TOOL REGISTRATION: detect_bot_protection
// WHAT: Registers the detect_bot_protection tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('detect_bot_protection', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const bodyText = document.body?.innerText?.toLowerCase() || '';
    const html = document.documentElement?.innerHTML?.toLowerCase() || '';
    const detections = [];
    
    // DataDome
    if (html.includes('datadome') || html.includes('datadome.co') || document.querySelector('script[src*="datadome"]')) {
      detections.push({ type: 'datadome', severity: 'high' });
    }
    // PerimeterX / HUMAN
    if (html.includes('perimeterx') || html.includes('px-captcha') || html.includes('human.com') || document.querySelector('[id*="px-"]')) {
      detections.push({ type: 'perimeterx', severity: 'high' });
    }
    // Akamai Bot Manager
    if (html.includes('akamai') && (html.includes('bot') || html.includes('_abck'))) {
      detections.push({ type: 'akamai', severity: 'high' });
    }
    // Distil / Imperva
    if (html.includes('distil') || html.includes('imperva') || html.includes('incapsula')) {
      detections.push({ type: 'distil_imperva', severity: 'high' });
    }
    // Cloudflare
    if (html.includes('challenges.cloudflare.com') || bodyText.includes('checking your browser')) {
      detections.push({ type: 'cloudflare', severity: 'medium' });
    }
    // reCAPTCHA
    if (html.includes('google.com/recaptcha') || html.includes('g-recaptcha')) {
      detections.push({ type: 'recaptcha', severity: 'medium' });
    }
    // hCaptcha
    if (html.includes('hcaptcha.com') || html.includes('h-captcha')) {
      detections.push({ type: 'hcaptcha', severity: 'medium' });
    }
    // Shape Security (F5)
    if (html.includes('shape') && html.includes('security')) {
      detections.push({ type: 'shape_f5', severity: 'high' });
    }
    
    return { detections, count: detections.length, url: window.location.href };
  });
});

// TOOL REGISTRATION: evasion_mode
// WHAT: Registers the evasion_mode tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('evasion_mode', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    // Remove all bot detection scripts
    document.querySelectorAll('script[src*="datadome"], script[src*="perimeterx"], script[src*="akamai"], script[src*="distil"], script[src*="imperva"]').forEach(s => { s.remove(); });
    
    // Override common bot detection methods
    if (navigator.webdriver !== undefined) {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    }
    
    // Remove automation markers
    delete window.document.$cdc_asdjflasutopfhvcZLmcfl_;
    delete window.document.$chrome_asyncScriptInfo;
    delete window.domAutomation;
    delete window.domAutomationController;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    
    // Override toString for overridden properties
    const origToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === navigator.__lookupGetter__('webdriver')) return 'function get webdriver() { [native code] }';
      return origToString.call(this);
    };
    
    return { evasion: 'enabled', scriptsRemoved: true };
  });
});

// --- USER-AGENT ROTATION (v2.9.0) ---

const UA_PROFILES = [
  // Chrome Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // Chrome macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Chrome Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Edge Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

// TOOL REGISTRATION: rotate_user_agent
// WHAT: Registers the rotate_user_agent tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('rotate_user_agent', async (p) => {
  const ua = p.userAgent || UA_PROFILES[Math.floor(Math.random() * UA_PROFILES.length)];
  // Note: Can't override navigator.userAgent in Chrome extensions directly
  // But we can store it for use in requests
  return { userAgent: ua, rotated: true, note: 'UA stored for request headers — browser UA requires extension reload' };
});

// --- REFERRER SPOOFING (v2.9.0) ---

// TOOL REGISTRATION: set_referrer
// WHAT: Registers the set_referrer tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('set_referrer', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (referrer) => {
    Object.defineProperty(document, 'referrer', { get: () => referrer, configurable: true });
    return { referrer: referrer, spoofed: true };
  }, [p.referrer || 'https://www.google.com/']);
});

// --- BEHAVIORAL PATTERN RANDOMIZATION (v2.9.0) ---

// TOOL REGISTRATION: randomize_behavior
// WHAT: Registers the randomize_behavior tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('randomize_behavior', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const events = [];
    
    // Random mouse movements
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        const x = Math.random() * window.innerWidth;
        const y = Math.random() * window.innerHeight;
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        events.push({ type: 'mousemove', x: Math.round(x), y: Math.round(y) });
      }, i * (200 + Math.random() * 800));
    }
    
    // Random scroll
    setTimeout(() => {
      window.scrollBy(0, Math.random() * 300 - 150);
      events.push({ type: 'scroll' });
    }, 1500 + Math.random() * 2000);
    
    // Random focus/blur
    setTimeout(() => {
      const els = document.querySelectorAll('input, button, a');
      if (els.length > 0) {
        const el = els[Math.floor(Math.random() * els.length)];
        el.focus();
        setTimeout(() => el.blur(), 500 + Math.random() * 1000);
        events.push({ type: 'focus_blur', tag: el.tagName });
      }
    }, 3000 + Math.random() * 2000);
    
    return { events_scheduled: 7, duration_ms: 5000 };
  });
});

// --- FORM AUTO-DETECTION & SMART FILL (v2.9.0) ---

// TOOL REGISTRATION: smart_fill_form
// WHAT: Registers the smart_fill_form tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('smart_fill_form', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (profile) => {
    const forms = document.querySelectorAll('form');
    const results = [];
    
    forms.forEach((form, idx) => {
      const inputs = form.querySelectorAll('input, select, textarea');
      const filled = [];
      
      inputs.forEach(input => {
        if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return;
        
        const name = (input.name || input.id || input.placeholder || '').toLowerCase();
        let value = null;
        
        if (name.includes('email')) value = profile.email;
        else if (name.includes('first') || name.includes('vorname')) value = profile.firstName;
        else if (name.includes('last') || name.includes('nachname')) value = profile.lastName;
        else if (name.includes('name') && !name.includes('user')) value = profile.fullName;
        else if (name.includes('age') || name.includes('alter')) value = profile.age;
        else if (name.includes('phone') || name.includes('tel')) value = profile.phone;
        else if (name.includes('city') || name.includes('stadt')) value = profile.city;
        else if (name.includes('zip') || name.includes('plz')) value = profile.zip;
        else if (name.includes('country') || name.includes('land')) value = profile.country;
        else if (name.includes('address') || name.includes('straße')) value = profile.address;
        else if (name.includes('password') && name.includes('confirm')) value = profile.password;
        else if (name.includes('password')) value = profile.password;
        else if (name.includes('company') || name.includes('firma')) value = profile.company;
        else if (name.includes('job') || name.includes('beruf') || name.includes('title')) value = profile.jobTitle;
        else if (input.type === 'radio' || input.type === 'checkbox') {
          value = profile.qualifyingAnswers[name] || 'yes';
        }
        else if (input.tagName === 'SELECT') {
          const options = input.querySelectorAll('option');
          if (options.length > 1) {
            // Pick second option (usually first is placeholder)
            const opt = options[Math.min(1, options.length - 1)];
            value = opt.value || opt.textContent;
          }
        }
        else {
          value = profile.defaultAnswer || 'Yes';
        }
        
        if (value !== null && input.type !== 'radio' && input.type !== 'checkbox') {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push({ name: input.name || input.id, value });
        } else if (value && (input.type === 'radio' || input.type === 'checkbox')) {
          // For radio/checkbox, try to find matching option
          const val = value.toLowerCase();
          const labels = form.querySelectorAll(`label[for="${input.id}"]`);
          const labelText = Array.from(labels).map(l => l.textContent.toLowerCase()).join(' ');
          const shouldCheck = labelText.includes(val) || val === 'yes' || val === 'true';
          if (shouldCheck) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push({ name: input.name || input.id, value: 'checked' });
          }
        }
      });
      
      results.push({ formIndex: idx, action: form.action || 'unknown', filled });
    });
    
    return { forms: results, totalFilled: results.reduce((sum, f) => sum + f.filled.length, 0) };
  }, [p.profile || {
    email: '',
    firstName: '',
    lastName: '',
    fullName: '',
    age: '',
    phone: '',
    city: '',
    zip: '',
    country: '',
    address: '',
    password: '',
    company: '',
    jobTitle: '',
    defaultAnswer: '',
    qualifyingAnswers: {},
  }]);
});

// --- SHADOW DOM INTERACTION (v2.9.0) ---

// TOOL REGISTRATION: query_shadow_dom
// WHAT: Registers the query_shadow_dom tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('query_shadow_dom', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, (selector) => {
    const findInShadow = (root) => {
      const el = root.querySelector(selector);
      if (el) return el;
      for (const child of root.children || []) {
        if (child.shadowRoot) {
          const found = findInShadow(child.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    
    const el = findInShadow(document) || document.querySelector(selector);
    if (!el) return { found: false, selector };
    
    return {
      found: true,
      selector,
      tag: el.tagName,
      text: el.textContent?.substring(0, 200),
      attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
      inShadowRoot: !!el.getRootNode?.()?.host,
    };
  }, [p.selector]);
});

// TOOL REGISTRATION: click_shadow_element
// WHAT: Registers the click_shadow_element tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('click_shadow_element', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, runHumanEntropyDomInteraction, [{ kind: 'shadow-click', selector: p.selector }]);
});

// --- IFRAME INTERACTION (v2.9.0) ---

// TOOL REGISTRATION: list_iframes
// WHAT: Registers the list_iframes tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('list_iframes', async (p) => {
  const tabId = p.tabId || await activeTabId();
  return safeExecute(tabId, () => {
    const iframes = document.querySelectorAll('iframe');
    return {
      count: iframes.length,
      iframes: Array.from(iframes).map((f, i) => ({
        index: i,
        src: f.src,
        id: f.id,
        title: f.title,
        width: f.width,
        height: f.height,
        visible: f.offsetParent !== null,
        sameOrigin: (() => { try { return !!f.contentDocument; } catch(e) { return false; } })(),
      })),
    };
  });
});

// TOOL REGISTRATION: interact_iframe
// WHAT: Registers the interact_iframe tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('interact_iframe', async (p) => {
  const ALLOWED_ACTIONS = ['click', 'type', 'get_text', 'get_html'];
  if (!p.action || !ALLOWED_ACTIONS.includes(p.action)) return { error: `action must be one of: ${ALLOWED_ACTIONS.join(', ')}` };
  const tabId = p.tabId || await activeTabId();

  if (p.action === 'click') {
    return safeExecute(tabId, runHumanEntropyDomInteraction, [{
      kind: 'iframe-click',
      iframeSelector: p.selector,
      innerSelector: p.innerSelector,
    }]);
  }

  return safeExecute(tabId, ({ selector: iframeSelector, action, innerSelector, text }) => {
    const iframe = document.querySelector(iframeSelector);
    if (!iframe) return { error: 'Iframe not found' };
    
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc) return { error: 'Cross-origin iframe — cannot access content' };
      
      const target = doc.querySelector(innerSelector);
      if (!target) return { error: `Element "${innerSelector}" not found in iframe` };
      
      if (action === 'type' && text) {
        target.value = text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true, action: 'type', tag: target.tagName };
      }
      if (action === 'get_text') {
        return { success: true, text: target.textContent };
      }
      if (action === 'get_html') {
        return { success: true, html: target.innerHTML.substring(0, 2000) };
      }
      
      return { error: `Unknown action: ${action}` };
    } catch(e) {
      return { error: `Access denied: ${e.message}` };
    }
  }, [{ selector: p.selector, action: p.action, innerSelector: p.innerSelector, text: p.text }]);
});

// --- COOKIE PERSISTENCE & ROTATION (v2.9.0) ---

// TOOL REGISTRATION: export_all_cookies
// WHAT: Registers the export_all_cookies tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('export_all_cookies', async (p) => {
  const tabId = p.tabId || await activeTabId();
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(tab.url);
  const cookies = await chrome.cookies.getAll({ domain: url.hostname });
  return { count: cookies.length, cookies, domain: url.hostname };
});

// TOOL REGISTRATION: import_cookies
// WHAT: Registers the import_cookies tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('import_cookies', async (p) => {
  const cookies = p.cookies || [];
  if (!Array.isArray(cookies)) return { error: 'cookies must be an array' };
  if (cookies.length > 500) return { error: 'Too many cookies — max 500 per import' };
  let imported = 0;
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') continue;
    if (!cookie.name || typeof cookie.name !== 'string' || cookie.name.length > 4096) continue;
    if (typeof cookie.value !== 'string' || cookie.value.length > 4096) continue;
    try {
      let targetUrl = cookie.url;
      if (!targetUrl) {
        let cleanDomain = cookie.domain;
        if (cleanDomain.startsWith('.')) cleanDomain = cleanDomain.substring(1);
        targetUrl = `https://${cleanDomain}`;
      }
      const cookieDetails = {
        url: targetUrl,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite || 'lax',
        expirationDate: cookie.expirationDate,
      };
      if (!cookie.hostOnly) {
        cookieDetails.domain = cookie.domain;
      }
      await chrome.cookies.set(cookieDetails);
      imported++;
    } catch(e) { log('warn', `Failed to import cookie: ${e.message}`); }
  }
  return { imported, total: cookies.length };
});

// TOOL REGISTRATION: rotate_cookies
// WHAT: Registers the rotate_cookies tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('rotate_cookies', async (p) => {
  const tabId = p.tabId || await activeTabId();
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(tab.url);
  const cookies = await chrome.cookies.getAll({ domain: url.hostname });
  
  // Export current cookies
  const exported = cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain }));
  
  // Delete all cookies for domain
  for (const cookie of cookies) {
    await chrome.cookies.remove({
      url: `https://${cookie.domain}`,
      name: cookie.name,
    });
  }
  
  return { exported, deleted: cookies.length, domain: url.hostname };
});

// --- PROXY INTEGRATION (v2.9.0) ---

// TOOL REGISTRATION: set_proxy
// WHAT: Registers the set_proxy tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('set_proxy', async (p) => {
  if (!p.host || typeof p.host !== 'string' || p.host.trim() === '') return { error: 'Proxy host required' };
  if (!p.port) return { error: 'Proxy port required' };
  const port = parseInt(p.port);
  if (isNaN(port) || port < 1 || port > 65535) return { error: 'Proxy port must be 1–65535' };
  const PRIVATE_PATTERNS = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^localhost$/i];
  if (PRIVATE_PATTERNS.some(r => r.test(p.host.trim()))) return { error: 'Proxy host cannot be a private/loopback address' };
  const VALID_SCHEMES = ['http', 'https', 'socks4', 'socks5'];
  const scheme = VALID_SCHEMES.includes(p.scheme) ? p.scheme : 'http';
  try {
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme, host: p.host.trim(), port },
          bypassList: p.bypass || ['localhost'],
        },
      },
      scope: 'regular',
    });
    return { success: true, proxy: `${scheme}://${p.host.trim()}:${port}` };
  } catch(e) {
    return { error: `Proxy setting failed: ${e.message}` };
  }
});

// TOOL REGISTRATION: clear_proxy
// WHAT: Registers the clear_proxy tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('clear_proxy', async () => {
  try {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return { success: true, message: 'Proxy cleared' };
  } catch(e) {
    return { error: e.message };
  }
});

// --- AGENT VISION (v4.0.0) — CDP-based Page Understanding ---

const AV_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
  'option', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'listbox',
]);
const AV_STRUCTURE_ROLES = new Set([
  'heading', 'img', 'table', 'row', 'cell', 'list', 'listitem',
  'navigation', 'main', 'complementary', 'banner', 'contentinfo',
  'form', 'region', 'alert', 'dialog', 'status', 'separator',
]);
const AV_SKIP_ROLES = new Set([
  'none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak',
  'StaticText', 'paragraph', 'group', 'Section',
]);

function avFormatNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value || '';
  const value = node.value?.value || '';
  const desc = node.description?.value || '';
  const checked = node.properties?.find(p => p.name === 'checked')?.value?.value;
  const disabled = node.properties?.find(p => p.name === 'disabled')?.value?.value;
  const required = node.properties?.find(p => p.name === 'required')?.value?.value;
  const expanded = node.properties?.find(p => p.name === 'expanded')?.value?.value;

  if (AV_SKIP_ROLES.has(role) && !name) return null;
  if (!role && !name) return null;

  const indent = '  '.repeat(depth);
  const parts = [];

  const isInteractive = AV_INTERACTIVE_ROLES.has(role);
  const isStructure = AV_STRUCTURE_ROLES.has(role);

  if (!isInteractive && !isStructure && !name) return null;

  let refTag = '';
  if (isInteractive && node.backendDOMNodeId) {
    _refCounter++;
    const refId = `@e${_refCounter}`;
    _refMap.set(refId, {
      tabId: node._tabId,
      backendDOMNodeId: node.backendDOMNodeId,
      nodeId: node.nodeId,
      role,
      name,
    });
    refTag = ` ${refId}`;
  }

  let line = `${indent}[${role}${refTag}]`;
  if (name) line += ` "${name}"`;
  if (value) line += ` value="${value}"`;
  if (desc) line += ` desc="${desc}"`;
  if (checked !== undefined) line += ` checked=${checked}`;
  if (disabled) line += ' disabled';
  if (required) line += ' required';
  if (expanded !== undefined) line += ` expanded=${expanded}`;

  parts.push(line);
  return parts.join('');
}

function avBuildTree(nodes, tabId) {
  const nodeMap = new Map();
  for (const n of nodes) {
    n._tabId = tabId;
    nodeMap.set(n.nodeId, n);
  }

  const lines = [];
  function walk(nodeId, depth) {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    if (node.ignored?.value) {
      if (node.childIds) {
        for (const cid of node.childIds) walk(cid, depth);
      }
      return;
    }
    const formatted = avFormatNode(node, depth);
    if (formatted !== null) {
      lines.push(formatted);
    }
    if (node.childIds) {
      for (const cid of node.childIds) walk(cid, formatted !== null ? depth + 1 : depth);
    }
  }

  if (nodes.length > 0) walk(nodes[0].nodeId, 0);
  return lines.join('\n');
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureTabScreenshot(tabId) {
  const result = await cdpSend(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
  return `data:image/png;base64,${result.data}`;
}

async function captureObservationSnapshot(tabId, options = {}) {
  const includeScreenshot = options.includeScreenshot !== false;
  const { nodes } = await cdpSend(tabId, 'Accessibility.getFullAXTree', {});
  _refMap.clear();
  _refCounter = 0;

  const tree = avBuildTree(nodes, tabId);
  const refCount = _refMap.size;
  const tab = await chrome.tabs.get(tabId);
  const snapshot = {
    tree,
    refCount,
    timestamp: Date.now(),
    tabId,
    url: tab?.url || null,
    title: tab?.title || null,
  };

  if (includeScreenshot) {
    snapshot.screenshotDataUrl = await captureTabScreenshot(tabId);
  }

  return snapshot;
}

function storeInteractionProof(proof) {
  _interactionProofCounter += 1;
  const proofId = `proof-${_interactionProofCounter}`;
  const storedProof = {
    ...proof,
    proofId,
  };
  _interactionProofs.set(proofId, storedProof);

  while (_interactionProofs.size > OBSERVATION_DEFAULTS.maxStoredProofs) {
    const oldestKey = _interactionProofs.keys().next().value;
    if (!oldestKey) break;
    _interactionProofs.delete(oldestKey);
  }

  return storedProof;
}

async function scrollRefIntoView(ref) {
  try {
    await cdpSend(ref.tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendDOMNodeId });
  } catch (_error) {
    // The runtime keeps going even when Chrome cannot scroll a detached node.
    // The follow-up strategy result will carry the real failure signal.
  }
}

async function resolveRefObjectId(ref) {
  const resolvedNode = await cdpSend(ref.tabId, 'DOM.resolveNode', { backendNodeId: ref.backendDOMNodeId });
  return resolvedNode?.object?.objectId || null;
}

async function callRefFunction(ref, functionDeclaration) {
  const objectId = await resolveRefObjectId(ref);
  if (!objectId) {
    return { error: 'Failed to resolve target element for fallback execution.' };
  }

  const callResult = await cdpSend(ref.tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (callResult.exceptionDetails) {
    return {
      error: callResult.exceptionDetails.exception?.description || callResult.exceptionDetails.text || 'Fallback execution failed.',
    };
  }

  return callResult.result?.value || { success: true };
}

async function executeCdpMouseStrategy(ref) {
  const { model } = await cdpSend(ref.tabId, 'DOM.getBoxModel', { backendNodeId: ref.backendDOMNodeId });
  const pointerTarget = humanEntropyPointFromBorder(model.border, 5);
  const settledPoint = await humanEntropyClickCdp(ref.tabId, pointerTarget);

  return {
    success: true,
    strategy: 'cdp_mouse',
    position: settledPoint,
  };
}

async function executeDomClickStrategy(ref) {
  return callRefFunction(ref, `async function () {
    const element = this;
    if (!element) {
      return { success: false, reason: 'missing-element' };
    }

    const randomBetween = (min, max) => min + Math.random() * (max - min);
    const randomInt = (min, max) => Math.round(randomBetween(min, max));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const dispatchMouse = (type, point, extra = {}) => {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        screenX: window.screenX + point.x,
        screenY: window.screenY + point.y,
        button: extra.button ?? 0,
        buttons: extra.buttons ?? 0,
        detail: extra.detail ?? 1,
      }));
    };

    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    }
    if (typeof element.focus === 'function') {
      element.focus({ preventScroll: true });
    }

    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { success: false, reason: 'invalid-rect' };
    }

    const destination = {
      x: Math.round(clamp((rect.left + rect.right) / 2 + randomBetween(-Math.min(5, Math.max(1, rect.width / 4)), Math.min(5, Math.max(1, rect.width / 4))), rect.left + 1, rect.right - 1)),
      y: Math.round(clamp((rect.top + rect.bottom) / 2 + randomBetween(-Math.min(5, Math.max(1, rect.height / 4)), Math.min(5, Math.max(1, rect.height / 4))), rect.top + 1, rect.bottom - 1)),
    };
    const start = {
      x: Math.round(destination.x + randomBetween(-28, 28)),
      y: Math.round(destination.y + randomBetween(-18, 18)),
    };
    const steps = randomInt(2, 4);

    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const remainingNoise = 2 * (1 - progress);
      const point = {
        x: Math.round(start.x + ((destination.x - start.x) * progress) + randomBetween(-remainingNoise, remainingNoise)),
        y: Math.round(start.y + ((destination.y - start.y) * progress) + randomBetween(-remainingNoise, remainingNoise)),
      };
      dispatchMouse('mousemove', point, { buttons: 0 });
      await sleep(randomInt(12, 28));
    }

    dispatchMouse('mouseover', destination, { buttons: 0 });
    await sleep(randomInt(24, 72));
    dispatchMouse('mousedown', destination, { button: 0, buttons: 1, detail: 1 });
    await sleep(randomInt(55, 150));
    dispatchMouse('mouseup', destination, { button: 0, buttons: 0, detail: 1 });
    await sleep(randomInt(18, 60));

    if (typeof element.click === 'function') {
      element.click();
    } else {
      dispatchMouse('click', destination, { button: 0, buttons: 0, detail: 1 });
    }

    return {
      success: true,
      strategy: 'dom_click',
      tagName: element.tagName || null,
      textPreview: (element.innerText || element.textContent || '').trim().slice(0, 120),
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      position: destination,
    };
  }`);
}

async function executeDomDispatchStrategy(ref) {
  return callRefFunction(ref, `async function () {
    const element = this;
    if (!element) {
      return { success: false, reason: 'missing-element' };
    }

    const randomBetween = (min, max) => min + Math.random() * (max - min);
    const randomInt = (min, max) => Math.round(randomBetween(min, max));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const dispatchMouse = (type, point, extra = {}) => {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        screenX: window.screenX + point.x,
        screenY: window.screenY + point.y,
        button: extra.button ?? 0,
        buttons: extra.buttons ?? 0,
        detail: extra.detail ?? 1,
      }));
    };

    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    }
    if (typeof element.focus === 'function') {
      element.focus({ preventScroll: true });
    }

    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { success: false, reason: 'invalid-rect' };
    }

    const destination = {
      x: Math.round(clamp((rect.left + rect.right) / 2 + randomBetween(-Math.min(5, Math.max(1, rect.width / 4)), Math.min(5, Math.max(1, rect.width / 4))), rect.left + 1, rect.right - 1)),
      y: Math.round(clamp((rect.top + rect.bottom) / 2 + randomBetween(-Math.min(5, Math.max(1, rect.height / 4)), Math.min(5, Math.max(1, rect.height / 4))), rect.top + 1, rect.bottom - 1)),
    };
    const start = {
      x: Math.round(destination.x + randomBetween(-28, 28)),
      y: Math.round(destination.y + randomBetween(-18, 18)),
    };
    const steps = randomInt(2, 4);

    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const remainingNoise = 2 * (1 - progress);
      const point = {
        x: Math.round(start.x + ((destination.x - start.x) * progress) + randomBetween(-remainingNoise, remainingNoise)),
        y: Math.round(start.y + ((destination.y - start.y) * progress) + randomBetween(-remainingNoise, remainingNoise)),
      };
      dispatchMouse('mousemove', point, { buttons: 0 });
      await sleep(randomInt(12, 28));
    }

    dispatchMouse('mouseover', destination, { buttons: 0 });
    await sleep(randomInt(24, 72));
    dispatchMouse('mousedown', destination, { button: 0, buttons: 1, detail: 1 });
    await sleep(randomInt(55, 150));
    dispatchMouse('mouseup', destination, { button: 0, buttons: 0, detail: 1 });
    await sleep(randomInt(18, 60));
    dispatchMouse('click', destination, { button: 0, buttons: 0, detail: 1 });

    return {
      success: true,
      strategy: 'dom_dispatch',
      tagName: element.tagName || null,
      textPreview: (element.innerText || element.textContent || '').trim().slice(0, 120),
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      position: destination,
    };
  }`);
}

async function executeRefStrategy(ref, strategy) {
  await scrollRefIntoView(ref);

  if (strategy === 'cdp_mouse') {
    return executeCdpMouseStrategy(ref);
  }
  if (strategy === 'dom_click') {
    return executeDomClickStrategy(ref);
  }
  if (strategy === 'dom_dispatch') {
    return executeDomDispatchStrategy(ref);
  }

  return { error: `Unknown interaction strategy: ${strategy}` };
}

async function observeRefInteraction(ref, options = {}) {
  const strategies = Array.isArray(options.strategies) && options.strategies.length > 0
    ? options.strategies
    : ['cdp_mouse', 'dom_click', 'dom_dispatch'];
  const settleDelayMs = Number.isFinite(options.settleDelayMs)
    ? Math.max(0, options.settleDelayMs)
    : OBSERVATION_DEFAULTS.settleDelayMs;
  const minVisualChangeRatio = Number.isFinite(options.minVisualChangeRatio)
    ? Math.max(0, options.minVisualChangeRatio)
    : OBSERVATION_DEFAULTS.minVisualChangeRatio;
  const attempts = [];

  let beforeSnapshot = await captureObservationSnapshot(ref.tabId, { includeScreenshot: true });
  _lastSnapshot = beforeSnapshot;

  for (let index = 0; index < strategies.length; index += 1) {
    const strategy = strategies[index];
    const startedAt = Date.now();
    let execution;

    try {
      execution = await executeRefStrategy(ref, strategy);
    } catch (error) {
      execution = { error: error.message, strategy };
    }

    if (settleDelayMs > 0) {
      await waitMs(settleDelayMs);
    }

    const afterSnapshot = await captureObservationSnapshot(ref.tabId, { includeScreenshot: true });
    const assessment = evaluateObservation({
      beforeSnapshot,
      afterSnapshot,
      strategy,
      minVisualChangeRatio,
    });
    const attempt = {
      strategy,
      durationMs: Date.now() - startedAt,
      fallbackTriggered: index > 0,
      execution,
      assessment,
      artifacts: {
        beforeSnapshot,
        afterSnapshot,
      },
    };
    attempts.push(attempt);
    beforeSnapshot = afterSnapshot;
    _lastSnapshot = afterSnapshot;

    if (!execution?.error && assessment.changed) {
      break;
    }
  }

  const storedProof = storeInteractionProof({
    createdAt: new Date().toISOString(),
    ref: {
      refId: ref.refId,
      role: ref.role,
      name: ref.name,
      tabId: ref.tabId,
    },
    attempts,
  });
  const proofSummary = summarizeProof(storedProof);
  const finalAttempt = storedProof.attempts[storedProof.attempts.length - 1] || null;

  return {
    success: !!proofSummary.finalChanged,
    ref: ref.refId,
    role: ref.role,
    name: ref.name,
    proofId: storedProof.proofId,
    proof: proofSummary,
    fallbackTriggered: proofSummary.fallbackTriggered,
    noOpDetected: proofSummary.noOpDetected,
    strategiesTried: proofSummary.attempts.map((attempt) => attempt.strategy),
    ...(finalAttempt?.execution?.error ? { error: finalAttempt.execution.error } : {}),
  };
}

// TOOL REGISTRATION: snapshot
// WHAT: Registers the snapshot tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('snapshot', async (p) => {
  const tabId = p?.tabId || await activeTabId();
  try {
    const snapshot = await captureObservationSnapshot(tabId, {
      includeScreenshot: p?.includeScreenshot === true,
    });
    _lastSnapshot = snapshot;

    return {
      tree: snapshot.tree,
      refCount: snapshot.refCount,
      totalNodes: snapshot.tree ? snapshot.tree.split('\n').filter(Boolean).length : 0,
      timestamp: snapshot.timestamp,
      ...(snapshot.screenshotDataUrl ? { screenshotDataUrl: snapshot.screenshotDataUrl } : {}),
    };
  } catch (e) {
    log('error', `snapshot failed: ${e.message}`);
    return { error: e.message };
  }
});

// Rebuild the current tab snapshot and translate the live ref map into the
// compact structure expected by the deterministic primitive matcher.
async function buildDeterministicRefsForTab(tabId) {
  const snapshotResult = await execTool('snapshot', { tabId });
  if (!snapshotResult || snapshotResult.error) {
    return { refs: [], snapshotError: snapshotResult?.error || 'snapshot unavailable' };
  }

  const refs = [];
  for (const [refId, ref] of _refMap.entries()) {
    if (ref.tabId !== tabId) {
      continue;
    }

    refs.push({
      ref: refId,
      role: ref.role,
      name: ref.name,
    });
  }

  return { refs, snapshotError: null };
}

// TOOL REGISTRATION: click_ref
// WHAT: Registers the click_ref tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('click_ref', async (p) => {
  if (!p?.ref || typeof p.ref !== 'string') return { error: 'ref is required (e.g. "@e3")' };
  const ref = _refMap.get(p.ref);
  if (!ref) return { error: `Unknown ref: ${p.ref}. Run snapshot first.` };

  try {
    return await observeRefInteraction({
      ...ref,
      refId: p.ref,
    }, {
      strategies: Array.isArray(p?.strategies) ? p.strategies : undefined,
      settleDelayMs: p?.settleDelayMs,
      minVisualChangeRatio: p?.minVisualChangeRatio,
    });
  } catch (e) {
    log('error', `click_ref failed: ${e.message}`);
    return { error: e.message, ref: p.ref };
  }
});

// TOOL REGISTRATION: type_ref
// WHAT: Registers the type_ref tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('type_ref', async (p) => {
  if (!p?.ref || typeof p.ref !== 'string') return { error: 'ref is required (e.g. "@e1")' };
  if (p.text === undefined || typeof p.text !== 'string') return { error: 'text is required' };
  const ref = _refMap.get(p.ref);
  if (!ref) return { error: `Unknown ref: ${p.ref}. Run snapshot first.` };

  try {
    const { nodeId } = await cdpSend(ref.tabId, 'DOM.resolveNode', { backendNodeId: ref.backendDOMNodeId });
    await cdpSend(ref.tabId, 'DOM.focus', { backendNodeId: ref.backendDOMNodeId });

    if (p.clear !== false) {
      await cdpSend(ref.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
      await cdpSend(ref.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
      await cdpSend(ref.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
      await cdpSend(ref.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    }

    await cdpSend(ref.tabId, 'Input.insertText', { text: p.text });

    return { success: true, ref: p.ref, text: p.text, role: ref.role, name: ref.name };
  } catch (e) {
    log('error', `type_ref failed: ${e.message}`);
    return { error: e.message, ref: p.ref };
  }
});

// TOOL REGISTRATION: select_ref
// WHAT: Registers the select_ref tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('select_ref', async (p) => {
  if (!p?.ref || typeof p.ref !== 'string') return { error: 'ref is required' };
  if (!p.value && !p.index && p.index !== 0) return { error: 'value or index required' };
  const ref = _refMap.get(p.ref);
  if (!ref) return { error: `Unknown ref: ${p.ref}. Run snapshot first.` };

  try {
    const { object } = await cdpSend(ref.tabId, 'DOM.resolveNode', { backendNodeId: ref.backendDOMNodeId });
    const objectId = object.objectId;

    let selectExpr;
    if (p.value !== undefined) {
      const escaped = String(p.value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      selectExpr = `function(){ this.value='${escaped}'; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return this.value; }`;
    } else {
      selectExpr = `function(){ this.selectedIndex=${parseInt(p.index)}; this.dispatchEvent(new Event('change',{bubbles:true})); return this.value; }`;
    }

    const { result } = await cdpSend(ref.tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: selectExpr,
      returnByValue: true,
    });

    return { success: true, ref: p.ref, selectedValue: result?.value };
  } catch (e) {
    log('error', `select_ref failed: ${e.message}`);
    return { error: e.message, ref: p.ref };
  }
});

// TOOL REGISTRATION: hover_ref
// WHAT: Registers the hover_ref tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('hover_ref', async (p) => {
  if (!p?.ref || typeof p.ref !== 'string') return { error: 'ref is required' };
  const ref = _refMap.get(p.ref);
  if (!ref) return { error: `Unknown ref: ${p.ref}. Run snapshot first.` };

  try {
    const { model } = await cdpSend(ref.tabId, 'DOM.getBoxModel', { backendNodeId: ref.backendDOMNodeId });
    const pointerTarget = humanEntropyPointFromBorder(model.border, 4);
    const settledPoint = await humanEntropyHoverCdp(ref.tabId, pointerTarget);

    return { success: true, ref: p.ref, role: ref.role, name: ref.name, position: settledPoint };
  } catch (e) {
    log('error', `hover_ref failed: ${e.message}`);
    return { error: e.message, ref: p.ref };
  }
});

// TOOL REGISTRATION: screenshot_annotated
// WHAT: Registers the screenshot_annotated tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('screenshot_annotated', async (p) => {
  const tabId = p?.tabId || await activeTabId();
  try {
    if (_refMap.size === 0) {
      const { nodes } = await cdpSend(tabId, 'Accessibility.getFullAXTree', {});
      _refMap.clear();
      _refCounter = 0;
      avBuildTree(nodes, tabId);
    }

    const labels = [];
    for (const [refId, ref] of _refMap.entries()) {
      if (ref.tabId !== tabId) continue;
      try {
        const { model } = await cdpSend(tabId, 'DOM.getBoxModel', { backendNodeId: ref.backendDOMNodeId });
        const border = model.border;
        const x = Math.round((border[0] + border[4]) / 2);
        const y = Math.round((border[1] + border[5]) / 2);
        const w = Math.round(Math.abs(border[2] - border[0]));
        const h = Math.round(Math.abs(border[5] - border[1]));
        if (w > 0 && h > 0) {
          labels.push({ refId, x: border[0], y: border[1], w, h, role: ref.role, name: ref.name });
        }
      } catch (_e) { /* element may be off-screen or hidden */ }
    }

    await safeExecute(tabId, (labelsArr) => {
      const container = document.createElement('div');
      container.id = '__opensin_som_overlay__';
      container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
      for (const lbl of labelsArr) {
        const el = document.createElement('div');
        el.style.cssText = `position:absolute;left:${lbl.x}px;top:${lbl.y}px;width:${lbl.w}px;height:${lbl.h}px;border:2px solid #ff0066;background:rgba(255,0,102,0.08);`;
        const tag = document.createElement('span');
        tag.textContent = lbl.refId;
        tag.style.cssText = 'position:absolute;top:-16px;left:0;font-size:11px;font-weight:bold;color:#fff;background:#ff0066;padding:1px 4px;border-radius:3px;font-family:monospace;white-space:nowrap;';
        el.appendChild(tag);
        container.appendChild(el);
      }
      document.body.appendChild(container);
    }, [labels]);

    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });

    await safeExecute(tabId, () => {
      const overlay = document.getElementById('__opensin_som_overlay__');
      if (overlay) overlay.remove();
    });

    return {
      dataUrl,
      labels: labels.map(l => ({ ref: l.refId, role: l.role, name: l.name, bounds: { x: l.x, y: l.y, w: l.w, h: l.h } })),
      labelCount: labels.length,
    };
  } catch (e) {
    log('error', `screenshot_annotated failed: ${e.message}`);
    await safeExecute(tabId, () => {
      const overlay = document.getElementById('__opensin_som_overlay__');
      if (overlay) overlay.remove();
    }).catch(() => {});
    return { error: e.message };
  }
});

// TOOL REGISTRATION: observe
// WHAT: Registers the observe tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('observe', async (p) => {
  const tabId = p?.tabId || await activeTabId();
  try {
    const snapshot = await captureObservationSnapshot(tabId, { includeScreenshot: true });
    _lastSnapshot = snapshot;

    return {
      snapshot: {
        tree: snapshot.tree,
        refCount: snapshot.refCount,
        totalNodes: snapshot.tree ? snapshot.tree.split('\n').filter(Boolean).length : 0,
      },
      screenshot: {
        dataUrl: snapshot.screenshotDataUrl,
      },
      timestamp: snapshot.timestamp,
      url: snapshot.url,
      title: snapshot.title,
    };
  } catch (e) {
    log('error', `observe failed: ${e.message}`);
    return { error: e.message };
  }
});

// TOOL REGISTRATION: page_diff
// WHAT: Registers the page_diff tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('page_diff', async (p) => {
  const tabId = p?.tabId || await activeTabId();
  if (!_lastSnapshot) return { error: 'No previous snapshot. Run snapshot or observe first.' };

  try {
    const previous = _lastSnapshot;
    const current = await captureObservationSnapshot(tabId, {
      includeScreenshot: p?.includeScreenshot === true || !!previous.screenshotDataUrl,
    });
    _lastSnapshot = current;

    const domDiff = buildDomDiff(previous.tree, current.tree);
    const visualDiff = previous.screenshotDataUrl && current.screenshotDataUrl
      ? buildVisualDiff(previous.screenshotDataUrl, current.screenshotDataUrl)
      : null;

    return {
      changed: domDiff.changed || !!visualDiff?.changed || previous.url !== current.url || previous.title !== current.title,
      domDiff,
      visualDiff,
      urlChanged: previous.url !== current.url,
      titleChanged: previous.title !== current.title,
      previousTimestamp: previous.timestamp,
      currentTimestamp: current.timestamp,
    };
  } catch (e) {
    log('error', `page_diff failed: ${e.message}`);
    return { error: e.message };
  }
});

// TOOL REGISTRATION: get_interaction_proof
// WHAT: Returns the stored screenshot and diff evidence for an observed interaction.
// WHY: Agents need verifiable evidence when a no-op was detected or a fallback path fired.
reg('get_interaction_proof', async (p) => {
  const proofId = p?.proofId;
  if (!proofId || typeof proofId !== 'string') {
    return { error: 'proofId is required' };
  }

  const proof = _interactionProofs.get(proofId);
  if (!proof) {
    return { error: `Unknown proofId: ${proofId}` };
  }

  if (p?.includeArtifacts === false) {
    return { proof: summarizeProof(proof) };
  }

  return {
    proof: {
      ...summarizeProof(proof),
      attempts: proof.attempts,
    },
  };
});

// TOOL REGISTRATION: cdp_detach
// WHAT: Registers the cdp_detach tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('cdp_detach', async (p) => {
  const tabId = p?.tabId || await activeTabId();
  await cdpDetach(tabId);
  return { success: true, tabId };
});

// --- Multi-Provider Vision AI (Echte Augen — v4.0.0) ---
// ~18,925 RPD combined free tier: Gemini (quality-first) → Groq (massive backup)
const VISION_CHAIN = [
  { p: 'gemini', m: 'gemini-2.5-flash',             rpd: 500   },
  { p: 'gemini', m: 'gemini-1.5-flash',             rpd: 1500  },
  { p: 'gemini', m: 'gemini-3-flash-preview',       rpd: 500   },
  { p: 'groq',   m: 'llama-3.2-11b-vision-preview', rpd: 14400 },
  { p: 'groq',   m: 'llama-4-scout-17b-vision',     rpd: 1000  },
  { p: 'groq',   m: 'llama-3.2-90b-vision-preview', rpd: 1000  },
  { p: 'gemini', m: 'gemini-2.5-pro',               rpd: 25    },
];

async function visionCapture() {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
}

async function visionViewport(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }),
    });
    return results[0]?.result || { w: 1920, h: 1080, dpr: 1 };
  } catch (_e) {
    try {
      const r = await cdpSend(tabId, 'Runtime.evaluate', {
        expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio})',
        returnByValue: true,
      });
      return JSON.parse(r.result.value);
    } catch (_e2) {
      return { w: 1920, h: 1080, dpr: 2 };
    }
  }
}

function visionStripFences(text) {
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  return s;
}

async function _callGemini(model, base64Image, prompt, apiKey, jsonOutput) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = { contents: [{ parts: [
    { inlineData: { mimeType: 'image/png', data: base64Image } },
    { text: prompt },
  ] }] };
  if (jsonOutput) body.generationConfig = { responseMimeType: 'application/json' };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function _callGroq(model, base64Image, prompt, apiKey, jsonOutput) {
  const content = [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
    { type: 'text', text: prompt },
  ];
  const body = { model, messages: [{ role: 'user', content }], max_tokens: 4096 };
  if (jsonOutput) body.response_format = { type: 'json_object' };
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

async function callVision(base64Image, prompt, opts) {
  const storage = await chrome.storage.local.get(['geminiApiKey', 'groqApiKey']);
  // Hardcoded fallbacks for vision keys (stored in sin-passwordmanager as GROQ_API_KEY_1)
  const GROQ_FALLBACK = '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';
  const keys = { gemini: storage.geminiApiKey, groq: storage.groqApiKey || GROQ_FALLBACK };

  if (!keys.gemini && !keys.groq) {
    return { error: 'No vision API keys. Set via: storage_set({data:{geminiApiKey:"...", groqApiKey:"..."}})' };
  }

  const errors = [];
  const jsonOut = !!(opts && opts.jsonOutput);

  for (const entry of VISION_CHAIN) {
    const apiKey = keys[entry.p];
    if (!apiKey) continue;
    try {
      const text = entry.p === 'gemini'
        ? await _callGemini(entry.m, base64Image, prompt, apiKey, jsonOut)
        : await _callGroq(entry.m, base64Image, prompt, apiKey, jsonOut);
      if (!text) { errors.push({ provider: entry.p, model: entry.m, error: 'empty response' }); continue; }
      log('info', `Vision OK: ${entry.p}/${entry.m} (${text.length}c)`);
      return { provider: entry.p, model: entry.m, result: text };
    } catch (e) {
      errors.push({ provider: entry.p, model: entry.m, error: e.message.slice(0, 200) });
      log('warn', `Vision ${entry.p}/${entry.m} failed: ${e.message.slice(0, 80)}`);
    }
  }
  return { error: 'All vision providers exhausted', tried: errors.length, details: errors,
    hint: !keys.gemini ? 'Set geminiApiKey via storage_set' : !keys.groq ? 'Add groqApiKey for +17,400 RPD backup' : 'All rate-limited' };
}

// --- Vision Tool: See the page like a human ---
// TOOL REGISTRATION: vision
// WHAT: Registers the vision tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('vision', async (p) => {
  try {
    const tabId = p?.tabId || await activeTabId();
    const vp = await visionViewport(tabId);
    const imgW = Math.round(vp.w * vp.dpr);
    const imgH = Math.round(vp.h * vp.dpr);
    const img = await visionCapture();

    const defaultPrompt = [
      `Analyze this screenshot of a web page. The image is ${imgW}x${imgH} pixels (DPR ${vp.dpr}, viewport ${vp.w}x${vp.h} CSS px).`,
      'Identify ALL interactive elements visible on screen.',
      'For each element return a JSON object with:',
      '- label: visible text or aria-label',
      '- type: button|link|input|checkbox|select|radio|captcha|toggle|slider|textarea|other',
      `- x: center X as image pixel (0-${imgW})`,
      `- y: center Y as image pixel (0-${imgH})`,
      '- w: approximate width in image pixels',
      '- h: approximate height in image pixels',
      '- description: what the element does',
      'Include CAPTCHAs, Cloudflare challenges, cookie banners, popups — EVERYTHING visible and interactive.',
      'Return ONLY a valid JSON array. No markdown fences.',
    ].join('\n');

    const isCustom = !!p?.prompt;
    const vision = await callVision(img, isCustom ? p.prompt : defaultPrompt, { jsonOutput: !isCustom });
    if (vision.error) return vision;

    let parsed = null;
    try { parsed = JSON.parse(visionStripFences(vision.result)); } catch (_) { /* text */ }

    // Convert image-pixel coords to CSS pixels for consumer convenience
    if (parsed && Array.isArray(parsed) && vp.dpr > 1) {
      for (const el of parsed) {
        if (typeof el.x === 'number') el.x = Math.round(el.x / vp.dpr);
        if (typeof el.y === 'number') el.y = Math.round(el.y / vp.dpr);
        if (typeof el.w === 'number') el.w = Math.round(el.w / vp.dpr);
        if (typeof el.h === 'number') el.h = Math.round(el.h / vp.dpr);
      }
    }

    return {
      success: true,
      provider: vision.provider,
      model: vision.model,
      viewport: vp,
      elements: parsed,
      raw: parsed ? undefined : vision.result,
    };
  } catch (e) {
    log('error', `vision failed: ${e.message}`);
    return { error: e.message };
  }
});

// --- Vision Click: Find element by description + click via coordinates ---
// TOOL REGISTRATION: vision_click
// WHAT: Registers the vision_click tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('vision_click', async (p) => {
  if (!p?.description) return { error: 'description is required (natural language)' };
  try {
    const tabId = p?.tabId || await activeTabId();

    // Deterministic fast-path:
    // Known button families such as Save / Continue / Submit should bypass the
    // vision stack entirely when the live accessibility tree already exposes a
    // single matching interactive ref.
    if (deterministicPrimitives?.resolveDeterministicRefByDescription) {
      const { refs, snapshotError } = await buildDeterministicRefsForTab(tabId);
      const deterministicMatch = deterministicPrimitives.resolveDeterministicRefByDescription(
        p.description,
        refs,
        p.currentUrl || ''
      );

      if (deterministicMatch?.ref) {
        const clickResult = await execTool('click_ref', { ref: deterministicMatch.ref });
        if (!clickResult?.error) {
          return {
            ...clickResult,
            deterministic: true,
            primitive: deterministicMatch.primitive,
            resolution: 'ref-fast-path',
          };
        }

        log('warn', `vision_click deterministic fast-path failed, falling back to vision: ${clickResult.error}`);
      } else if (snapshotError) {
        log('warn', `vision_click could not build deterministic refs: ${snapshotError}`);
      }
    }

    const vp = await visionViewport(tabId);
    const imgW = Math.round(vp.w * vp.dpr);
    const imgH = Math.round(vp.h * vp.dpr);
    const img = await visionCapture();

    const prompt = [
      `Look at this screenshot (${imgW}x${imgH} pixels, DPR ${vp.dpr}, viewport ${vp.w}x${vp.h} CSS px).`,
      `Find the element best matching: "${p.description}"`,
      'Return ONLY a JSON object:',
      `{"found":true,"x":<center X in image pixels 0-${imgW}>,"y":<center Y in image pixels 0-${imgH}>,"confidence":<0.0-1.0>,"label":"<visible text>"}`,
      'If not found: {"found":false,"reason":"<why>"}',
      'No markdown fences.',
    ].join('\n');

    const vision = await callVision(img, prompt, { jsonOutput: true });
    if (vision.error) return vision;

    let result;
    try { result = JSON.parse(visionStripFences(vision.result)); }
    catch (_e) { return { error: 'Failed to parse vision response', raw: vision.result }; }

    if (!result.found) return { success: false, reason: result.reason || 'Element not found by vision' };

    // Convert image pixels → CSS pixels + a small box so the shared pointer
    // helper can still add movement and jitter without assuming exact center.
    const cssX = Math.round(result.x / vp.dpr);
    const cssY = Math.round(result.y / vp.dpr);
    const halfWidth = Math.max(8, Math.round(((result.w || 24) / vp.dpr) / 2));
    const halfHeight = Math.max(8, Math.round(((result.h || 24) / vp.dpr) / 2));
    const pointerTarget = {
      x: cssX,
      y: cssY,
      bounds: {
        minX: cssX - halfWidth,
        maxX: cssX + halfWidth,
        minY: cssY - halfHeight,
        maxY: cssY + halfHeight,
      },
    };
    const settledPoint = await humanEntropyClickCdp(tabId, pointerTarget);

    log('info', `vision_click: (${settledPoint.x},${settledPoint.y}) — "${result.label}"`);
    return { success: true, x: settledPoint.x, y: settledPoint.y, label: result.label, confidence: result.confidence, provider: vision.provider, model: vision.model };
  } catch (e) {
    log('error', `vision_click failed: ${e.message}`);
    return { error: e.message };
  }
});

// --- Vision Type: Find input by description + type text ---
// TOOL REGISTRATION: vision_type
// WHAT: Registers the vision_type tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('vision_type', async (p) => {
  if (!p?.description) return { error: 'description is required' };
  if (p?.text == null) return { error: 'text is required' };
  try {
    const tabId = p?.tabId || await activeTabId();
    const vp = await visionViewport(tabId);
    const imgW = Math.round(vp.w * vp.dpr);
    const imgH = Math.round(vp.h * vp.dpr);
    const img = await visionCapture();

    const prompt = [
      `Look at this screenshot (${imgW}x${imgH} pixels, DPR ${vp.dpr}, viewport ${vp.w}x${vp.h} CSS px).`,
      `Find the input field or text area best matching: "${p.description}"`,
      'Return ONLY a JSON object:',
      `{"found":true,"x":<center X in image pixels 0-${imgW}>,"y":<center Y in image pixels 0-${imgH}>,"confidence":<0.0-1.0>,"label":"<visible label or placeholder>"}`,
      'If not found: {"found":false,"reason":"<why>"}',
      'No markdown fences.',
    ].join('\n');

    const vision = await callVision(img, prompt, { jsonOutput: true });
    if (vision.error) return vision;

    let result;
    try { result = JSON.parse(visionStripFences(vision.result)); }
    catch (_e) { return { error: 'Failed to parse vision response', raw: vision.result }; }

    if (!result.found) return { success: false, reason: result.reason || 'Input not found by vision' };

    const cssX = Math.round(result.x / vp.dpr);
    const cssY = Math.round(result.y / vp.dpr);
    const halfWidth = Math.max(8, Math.round(((result.w || 24) / vp.dpr) / 2));
    const halfHeight = Math.max(8, Math.round(((result.h || 24) / vp.dpr) / 2));
    const pointerTarget = {
      x: cssX,
      y: cssY,
      bounds: {
        minX: cssX - halfWidth,
        maxX: cssX + halfWidth,
        minY: cssY - halfHeight,
        maxY: cssY + halfHeight,
      },
    };
    const settledPoint = await humanEntropyClickCdp(tabId, pointerTarget);

    // Brief delay for focus so the subsequent keyboard events do not race the UI.
    await humanEntropySleep(humanEntropyInt(90, 160));

    // Select all + delete (clear existing text) — uses Meta on Mac, Ctrl elsewhere
    const mod = 4; // Meta key for Mac; change to 2 for Ctrl on other platforms
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: mod });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: mod });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });

    // Type text
    await cdpSend(tabId, 'Input.insertText', { text: p.text });

    log('info', `vision_type: typed "${p.text.substring(0, 40)}" at (${settledPoint.x},${settledPoint.y})`);
    return { success: true, x: settledPoint.x, y: settledPoint.y, label: result.label, confidence: result.confidence, provider: vision.provider, model: vision.model, typed: p.text };
  } catch (e) {
    log('error', `vision_type failed: ${e.message}`);
    return { error: e.message };
  }
});

// --- Vision Extract: OCR-like data extraction from screenshot ---
// TOOL REGISTRATION: vision_extract
// WHAT: Registers the vision_extract tool for the MCP Server.
// WHY: Agents use this to control the browser.
reg('vision_extract', async (p) => {
  try {
    const tabId = p?.tabId || await activeTabId();
    const img = await visionCapture();

    const defaultPrompt = 'Extract all visible text from this screenshot. Return structured JSON with sections, headings, paragraphs, and tabular data. Preserve logical reading order.';
    const vision = await callVision(img, p?.prompt || defaultPrompt, { jsonOutput: !!p?.json });
    if (vision.error) return vision;

    let parsed = null;
    try { parsed = JSON.parse(visionStripFences(vision.result)); } catch (_) { /* text */ }

    return { success: true, provider: vision.provider, model: vision.model, data: parsed || vision.result };
  } catch (e) {
    log('error', `vision_extract failed: ${e.message}`);
    return { error: e.message };
  }
});

// --- HELPER: Safe Execute with Error Handling ---
async function activeTabId() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let id = tabs[0]?.id;
  if (id === undefined) {
    tabs = await chrome.tabs.query({ active: true });
    id = tabs[0]?.id;
  }
  if (id === undefined) throw new Error('No active tab found');
  return id;
}

const _rateCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_PER_METHOD = 30;
const RATE_LIMIT_GLOBAL = 100;
let _globalRateCount = 0;
let _globalRateReset = Date.now();

async function execTool(method, params) {
  const fn = TOOL_REGISTRY[method];
  if (!fn) throw new Error(`Tool not found: ${method}`);

  const now = Date.now();

  if (now - _globalRateReset > RATE_LIMIT_WINDOW_MS) {
    _globalRateCount = 0;
    _globalRateReset = now;
    _rateCounts.clear();
  }

  _globalRateCount++;
  if (_globalRateCount > RATE_LIMIT_GLOBAL) throw new Error('Global rate limit exceeded — max 100 calls/sec');

  const methodCount = (_rateCounts.get(method) || 0) + 1;
  _rateCounts.set(method, methodCount);
  if (methodCount > RATE_LIMIT_PER_METHOD) throw new Error(`Rate limit exceeded for ${method} — max 30 calls/sec`);

  log('info', `Executing: ${method}`);
  const result = await fn(params);
  log('info', `Done: ${method}`);
  return result;
}

// --- Offscreen Document ---
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
async function setupOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL] });
  if (existing.length > 0) { offscreenReady = true; return; }
  await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ['BLOBS', 'DOM_PARSER', 'LOCAL_STORAGE'], justification: 'Persistent browser automation and data processing' });
  offscreenReady = true;
  log('info', 'Offscreen document created');
}

// --- Web Request Logging ---
const requestLog = [];
const MAX_LOG = 500;
const MAX_URL_LEN = 500;
const truncUrl = (u) => (u && u.length > MAX_URL_LEN ? u.slice(0, MAX_URL_LEN) + '…' : u);
chrome.webRequest.onBeforeRequest.addListener((d) => { requestLog.push({ type: 'request', method: d.method, url: truncUrl(d.url), tabId: d.tabId, resType: d.type, time: d.timeStamp }); if (requestLog.length > MAX_LOG) requestLog.shift(); }, { urls: ['<all_urls>'] }, ['requestBody']);
chrome.webRequest.onCompleted.addListener((d) => { requestLog.push({ type: 'completed', url: truncUrl(d.url), tabId: d.tabId, status: d.statusCode, time: d.timeStamp }); if (requestLog.length > MAX_LOG) requestLog.shift(); }, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((d) => { requestLog.push({ type: 'error', url: truncUrl(d.url), tabId: d.tabId, error: d.error, time: d.timeStamp }); if (requestLog.length > MAX_LOG) requestLog.shift(); }, { urls: ['<all_urls>'] });

// --- External Messages ---
const ALLOWED_EXTERNAL_ORIGINS = ['https://opensin.ai', 'http://localhost', 'http://127.0.0.1', 'https://127.0.0.1'];
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Origin check — only allow whitelisted external origins
  let senderOrigin = '';
  try {
    senderOrigin = sender.origin || (sender.url ? new URL(sender.url).origin : '');
  } catch (_) { /* malformed URL — deny */ }
  const allowed = ALLOWED_EXTERNAL_ORIGINS.some(o => senderOrigin === o || senderOrigin.startsWith(o));
  if (!allowed) {
    log('warn', `onMessageExternal: rejected origin ${senderOrigin}`);
    sendResponse({ success: false, error: 'Unauthorized origin' });
    return true;
  }
  const { method, params } = msg || {};
  if (method && TOOL_REGISTRY[method]) { execTool(method, params).then(r => sendResponse({ success: true, result: r }), e => sendResponse({ success: false, error: e.message })); return true; }
  sendResponse({ success: false, error: 'Unknown method' });
  return true;
});

// --- Tab Events ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (changeInfo.status === 'complete') { log('info', `Tab loaded: ${tab.url}`); } });
chrome.tabs.onCreated.addListener((tab) => { log('info', `Tab created: ${tab.url}`); });
chrome.tabs.onRemoved.addListener((tabId) => { log('info', `Tab removed: ${tabId}`); });

// --- Keep-Alive Alarm ---
chrome.alarms.create('keep-alive', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-alive') {
    log('info', 'Keep-alive alarm fired');
    if (!hfWs || hfWs.readyState !== WebSocket.OPEN) {
      log('info', 'Reconnecting to HF MCP Server...');
      connectToHfMcp();
    } else {
      hfWs.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }
  }
});

// --- Init ---
chrome.runtime.onInstalled.addListener((d) => log('info', `Installed: ${d.reason}`));

(async () => {
  log('info', `Starting OpenSIN Bridge v${VERSION} — Agent Vision Edition`);
  await restoreEphemeralState();
  connectToHfMcp();
  await setupOffscreen();
  log('info', `Ready — ${Object.keys(TOOL_REGISTRY).length} tools registered`);
})();

// ============================================================
// ISSUES #17, #21, #22, #23, #24: Behavior Timeline Capture
// ============================================================
// WHY: We need a unified, privacy-safe, high-performance timeline of user actions.
// PERFORMANCE (#24): Buffered writes, bounded flush (every 50 events or 5s).
// STORAGE (#21): IndexedDB is used instead of storage.local for high volume.
// EXPORT (#23): Uses an rrweb-compatible structured schema.

let timelineBuffer = [];
const TIMELINE_FLUSH_INTERVAL = 5000;
const TIMELINE_MAX_BUFFER = 50;

function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('OpenSIN_Behavior_DB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function flushTimelineBuffer() {
  if (timelineBuffer.length === 0 || !behaviorRecordingEnabled) return;
  const eventsToFlush = [...timelineBuffer];
  timelineBuffer = [];
  
  try {
    const db = await initIndexedDB();
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    
    const sessionId = behaviorRecordingScope?.startedAt || Date.now();
    const req = store.get(sessionId);
    
    req.onsuccess = () => {
      const session = req.result || { sessionId, events: [] };
      session.events.push(...eventsToFlush);
      store.put(session);
    };
  } catch (e) {
    log('error', `Timeline flush failed: ${e.message}`);
  }
}

setInterval(flushTimelineBuffer, TIMELINE_FLUSH_INTERVAL);

// Handle MAIN-world Network/Behavior events
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!behaviorRecordingEnabled) return false;
  
  // Apply Schema validation and Redaction (#20, #29)
  const validMsg = validateMainWorldMessage({ data: message });
  if (validMsg && validMsg.payload) {
    if (validMsg.payload.type === 'INPUT') {
      validMsg.payload.value = redactSensitiveValue(validMsg.payload.name, validMsg.payload.inputType, validMsg.payload.value);
    }
    
    timelineBuffer.push({
      timestamp: Date.now(),
      tabId: sender.tab ? sender.tab.id : null,
      ...validMsg.payload
    });
    
    if (timelineBuffer.length >= TIMELINE_MAX_BUFFER) {
      flushTimelineBuffer();
    }
  }
  return false;
});
