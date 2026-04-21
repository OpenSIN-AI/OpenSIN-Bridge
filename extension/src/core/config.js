/**
 * OpenSIN Bridge - Central configuration.
 *
 * Exports:
 *   BRIDGE, NATIVE_HOST, TRANSPORT, RATE_LIMIT, NETWORK_CAPTURE, SNAPSHOT,
 *   HUMAN, VISION, BEHAVIOR, SECURITY, STORAGE_KEYS
 *
 * and a flattened CONFIG view used by the service worker and transports:
 *   CONFIG.version, CONFIG.wsUrl, CONFIG.nativeHost, CONFIG.ws.*, CONFIG.autostart.*
 *
 * Runtime overrides can arrive through chrome.storage.local under the
 * `openSin.config` key; call `initConfig()` at boot to merge them in.
 */

export const BRIDGE = Object.freeze({
  name: 'OpenSIN Bridge',
  version: '5.0.0',
  protocolVersion: 1,
});

export const NATIVE_HOST = Object.freeze({
  name: 'ai.opensin.bridge.host',
  idleTimeoutMs: 90_000,
  requestTimeoutMs: 30_000,
  allowedCommands: Object.freeze([
    'ping',
    'get_status',
    'workflow.start',
    'workflow.end',
    'fetch.http',
  ]),
});

export const TRANSPORT = Object.freeze({
  websocket: Object.freeze({
    // Local-dev default: when the unpacked extension is loaded from this repo,
    // it should attach to the local bridge server on port 7777 without any
    // extra UI config. Cloud / HF users can override this in options.
    defaultUrl: 'ws://localhost:7777/extension',
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30_000,
    reconnectJitter: 0.35,
    pingIntervalMs: 20_000,
    pongTimeoutMs: 45_000,
  }),
  external: Object.freeze({
    allowedOrigins: Object.freeze([
      'https://opensin.ai',
      'https://my.opensin.ai',
      'https://app.opensin.ai',
    ]),
    localhostPattern: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
  }),
});

export const RATE_LIMIT = Object.freeze({
  windowMs: 1000,
  perMethod: 30,
  global: 120,
});

export const NETWORK_CAPTURE = Object.freeze({
  maxEvents: 500,
  maxMainWorldEvents: 500,
  maxBodyPreview: 2048,
  maxHeaderValue: 512,
  urlPreviewLimit: 500,
});

export const SNAPSHOT = Object.freeze({
  maxStoredProofs: 32,
  settleDelayMs: 650,
  minVisualChangeRatio: 0.004,
  interactiveRoles: new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem',
    'tab', 'switch', 'slider', 'spinbutton', 'searchbox', 'option',
    'menuitemcheckbox', 'menuitemradio', 'treeitem', 'listbox',
  ]),
  structuralRoles: new Set([
    'heading', 'img', 'table', 'row', 'cell', 'list', 'listitem', 'navigation',
    'main', 'complementary', 'banner', 'contentinfo', 'form', 'region', 'alert',
    'dialog', 'status', 'separator',
  ]),
  skipRoles: new Set([
    'none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak',
    'StaticText', 'paragraph', 'group', 'Section',
  ]),
});

export const HUMAN = Object.freeze({
  pointerApproachSteps: Object.freeze({ min: 2, max: 4 }),
  pointerJitterPx: 5,
  perStepDelayMs: Object.freeze({ min: 12, max: 32 }),
  preClickDelayMs: Object.freeze({ min: 24, max: 78 }),
  pressHoldMs: Object.freeze({ min: 55, max: 160 }),
  postReleaseMs: Object.freeze({ min: 18, max: 65 }),
  keystrokeDelayMs: Object.freeze({ min: 35, max: 140 }),
});

export const VISION = Object.freeze({
  chain: Object.freeze([
    { provider: 'gemini', model: 'gemini-2.5-flash', rpd: 500 },
    { provider: 'gemini', model: 'gemini-1.5-flash', rpd: 1500 },
    { provider: 'groq', model: 'llama-3.2-11b-vision-preview', rpd: 14_400 },
    { provider: 'groq', model: 'llama-4-scout-17b-vision', rpd: 1000 },
    { provider: 'gemini', model: 'gemini-2.5-pro', rpd: 25 },
  ]),
  endpoints: Object.freeze({
    gemini:
      'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
  }),
});

export const BEHAVIOR = Object.freeze({
  dbName: 'OpenSIN_Behavior_Timeline',
  dbVersion: 1,
  sessionsStore: 'timeline_sessions',
  eventsStore: 'timeline_events',
  flushIntervalMs: 5000,
  maxBufferedEvents: 50,
  maxFlushBatchSize: 100,
  maxRetainedBuffer: 1000,
});

export const SECURITY = Object.freeze({
  blockedUrlSchemes: ['javascript:', 'data:', 'vbscript:', 'blob:'],
  sensitiveInputTypes: new Set(['password', 'credit-card', 'card-number', 'cvv', 'ssn', 'pin']),
  sensitiveFieldPattern:
    /password|passwort|secret|token|credit.?card|card.?number|cvv|ssn|social.?security|pin\b/i,
});

export const STORAGE_KEYS = Object.freeze({
  auth: 'openSin.auth',
  config: 'openSin.config',
  visionKeys: 'openSin.visionKeys',
  behaviorScope: 'openSin.behavior.scope',
  wsAuth: 'openSin.ws.authToken',
});

/**
 * Flattened view of config used by transports + service worker. Mutable so
 * initConfig() can layer overrides on top at boot.
 */
export const CONFIG = {
  version: BRIDGE.version,
  name: BRIDGE.name,
  wsUrl: TRANSPORT.websocket.defaultUrl,
  nativeHost: NATIVE_HOST.name,
  ws: {
    backoffMinMs: TRANSPORT.websocket.reconnectBaseMs,
    backoffMaxMs: TRANSPORT.websocket.reconnectMaxMs,
    backoffJitter: TRANSPORT.websocket.reconnectJitter,
    heartbeatMs: TRANSPORT.websocket.pingIntervalMs,
    pongTimeoutMs: TRANSPORT.websocket.pongTimeoutMs,
  },
  autostart: {
    ws: true,
    native: false,
  },
  logLevel: 'info',
};

/**
 * Return true if the URL scheme is allowed for navigation / tab creation.
 * We reject anything that can smuggle script execution.
 */
export function isSafeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const lower = url.trim().toLowerCase();
  return !SECURITY.blockedUrlSchemes.some((scheme) => lower.startsWith(scheme));
}

/**
 * Load persisted config overrides and merge them onto the live CONFIG object.
 * Safe to call repeatedly.
 */
export async function initConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.config);
    const overrides = stored?.[STORAGE_KEYS.config];
    if (overrides && typeof overrides === 'object') {
      if (typeof overrides.wsUrl === 'string') CONFIG.wsUrl = overrides.wsUrl;
      if (typeof overrides.nativeHost === 'string') CONFIG.nativeHost = overrides.nativeHost;
      if (typeof overrides.logLevel === 'string') CONFIG.logLevel = overrides.logLevel;
      if (overrides.autostart && typeof overrides.autostart === 'object') {
        Object.assign(CONFIG.autostart, overrides.autostart);
      }
      if (overrides.ws && typeof overrides.ws === 'object') {
        Object.assign(CONFIG.ws, overrides.ws);
      }
    }
  } catch (_err) {
    // Storage can fail early in the lifecycle — non-fatal.
  }
  return CONFIG;
}
