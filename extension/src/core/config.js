/**
 * OpenSIN Bridge v5 - Central configuration
 *
 * All tunable constants live here so the rest of the codebase stays declarative.
 * Runtime overrides may arrive through chrome.storage.local under the
 * `openSin.config` key; see core/state.js for the merge strategy.
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
    defaultUrl: 'wss://openjerro-opensin-bridge-mcp.hf.space/extension',
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
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'menuitem',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'searchbox',
    'option',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'listbox',
  ]),
  structuralRoles: new Set([
    'heading',
    'img',
    'table',
    'row',
    'cell',
    'list',
    'listitem',
    'navigation',
    'main',
    'complementary',
    'banner',
    'contentinfo',
    'form',
    'region',
    'alert',
    'dialog',
    'status',
    'separator',
  ]),
  skipRoles: new Set([
    'none',
    'presentation',
    'generic',
    'InlineTextBox',
    'LineBreak',
    'StaticText',
    'paragraph',
    'group',
    'Section',
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
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}',
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
 * Return true if the URL scheme is allowed for navigation / tab creation.
 * We reject anything that can smuggle script execution.
 */
export function isSafeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const lower = url.trim().toLowerCase();
  return !SECURITY.blockedUrlSchemes.some((scheme) => lower.startsWith(scheme));
}
