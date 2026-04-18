/**
 * ============================================================================== 
 * OpenSIN Component: session-export.mjs
 * ============================================================================== 
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Shared helpers for the stable OpenSIN session export schema.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Both the MV3 service worker and Node-based tests need one canonical place for
 * the export contract. Keeping the schema here prevents drift between runtime,
 * docs, and downstream tooling.
 *
 * RULES / REGELN:
 * 1. KEEP THE SHAPE STABLE: Downstream replay/inference tooling depends on these keys.
 * 2. BE EXPLICIT: Every normalization step must explain how raw capture data becomes export data.
 * 3. DO NOT GUESS: Missing values are represented as null/empty values instead of invented data.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If this schema drifts silently, session replay and inference pipelines will parse
 * the same recording differently and produce inconsistent automation output.
 */

export const OPENSIN_SESSION_EXPORT_SCHEMA = 'opensin.session-export/v1';
export const OPENSIN_RRWEB_PLUGIN_NAME = 'opensin.network';

const MAX_TEXT_PREVIEW = 2048;
const MAX_HEADER_VALUE_LENGTH = 512;

/**
 * Clamp untrusted text into a deterministic preview field.
 *
 * We intentionally keep the preview bounded because network payloads can become
 * arbitrarily large. The export schema carries representative snippets, not raw
 * infinite blobs.
 */
function clampText(value, limit = MAX_TEXT_PREVIEW) {
  if (value == null) return '';
  return String(value).slice(0, limit);
}

/**
 * Normalize an object of header-like values into a plain JSON-safe object.
 *
 * Chrome fetch/XHR surfaces can expose Headers, arrays, or plain objects. The
 * export schema must stay serializable without leaking browser-specific classes.
 */
function normalizeHeaders(headers) {
  if (!headers) return {};

  if (typeof headers.entries === 'function') {
    return Object.fromEntries(
      Array.from(headers.entries()).map(([key, value]) => [key, clampText(value, MAX_HEADER_VALUE_LENGTH)])
    );
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map((entry) => [String(entry[0]), clampText(entry[1], MAX_HEADER_VALUE_LENGTH)])
    );
  }

  if (typeof headers === 'object') {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, clampText(value, MAX_HEADER_VALUE_LENGTH)])
    );
  }

  return {};
}

/**
 * Turn any browser/runtime timestamp into a numeric epoch value.
 *
 * Consumers should never have to branch on string-vs-number timestamps. Missing
 * timestamps fall back to the supplied default rather than invented chronology.
 */
function normalizeTimestamp(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Normalize a MAIN-world network event captured by the injector.
 *
 * The result intentionally carries both an OpenSIN-native view and compatibility
 * mirrors for rrweb-style plugin events plus DevTools Recorder-oriented steps.
 */
export function normalizeMainWorldNetworkEvent(event = {}, index = 0) {
  const timestamp = normalizeTimestamp(event.timestamp, Date.now());
  const requestId = event.requestId || `main-${timestamp}-${index}`;
  const method = String(event.method || 'GET').toUpperCase();
  const url = event.url ? String(event.url) : '';
  const phase = event.phase || 'request';
  const api = event.api || 'fetch';
  const request = event.request && typeof event.request === 'object' ? event.request : {};
  const response = event.response && typeof event.response === 'object' ? event.response : {};
  const error = event.error && typeof event.error === 'object' ? event.error : null;

  return {
    eventId: `network-${requestId}-${phase}-${index}`,
    timestamp,
    category: 'network',
    source: event.source || 'main-world',
    api,
    phase,
    requestId,
    correlationKey: `${method} ${url}`,
    method,
    url,
    tabId: typeof event.tabId === 'number' ? event.tabId : null,
    frameUrl: event.frameUrl || null,
    durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
    request: {
      bodyKind: request.bodyKind || null,
      bodyLength: typeof request.bodyLength === 'number' ? request.bodyLength : null,
      bodyPreview: clampText(request.bodyPreview || ''),
      headers: normalizeHeaders(request.headers),
    },
    response: {
      status: typeof response.status === 'number' ? response.status : null,
      ok: typeof response.ok === 'boolean' ? response.ok : null,
      statusText: response.statusText || null,
      bodyKind: response.bodyKind || null,
      bodyLength: typeof response.bodyLength === 'number' ? response.bodyLength : null,
      bodyPreview: clampText(response.bodyPreview || ''),
      headers: normalizeHeaders(response.headers),
    },
    error: error
      ? {
          message: error.message || 'Unknown network error',
          name: error.name || 'Error',
        }
      : null,
    rrweb: {
      type: 'plugin',
      plugin: OPENSIN_RRWEB_PLUGIN_NAME,
      data: {
        requestId,
        phase,
        api,
        method,
        url,
        tabId: typeof event.tabId === 'number' ? event.tabId : null,
        frameUrl: event.frameUrl || null,
      },
    },
    devtoolsRecorder: {
      type: 'network',
      requestId,
      phase,
      method,
      url,
      status: typeof response.status === 'number' ? response.status : null,
    },
  };
}

/**
 * Normalize a chrome.webRequest log entry so it can live in the same export file.
 *
 * We keep webRequest-derived metadata separate from MAIN-world payload capture.
 * This preserves the distinction between browser-observed transport metadata and
 * application-layer payload details.
 */
export function normalizeWebRequestEvent(event = {}, index = 0) {
  const timestamp = normalizeTimestamp(event.time, Date.now());
  const url = event.url ? String(event.url) : '';
  const method = String(event.method || 'GET').toUpperCase();
  const phase = event.type || 'request';
  const requestId = event.requestId || `webrequest-${timestamp}-${index}`;

  return {
    eventId: `webrequest-${requestId}-${phase}-${index}`,
    timestamp,
    category: 'network-observer',
    source: 'chrome.webRequest',
    api: 'webRequest',
    phase,
    requestId,
    correlationKey: `${method} ${url}`,
    method,
    url,
    tabId: typeof event.tabId === 'number' ? event.tabId : null,
    frameUrl: null,
    durationMs: null,
    request: {
      bodyKind: null,
      bodyLength: null,
      bodyPreview: '',
      headers: {},
    },
    response: {
      status: typeof event.status === 'number' ? event.status : null,
      ok: null,
      statusText: null,
      bodyKind: null,
      bodyLength: null,
      bodyPreview: '',
      headers: {},
    },
    error: event.error ? { message: String(event.error), name: 'ChromeWebRequestError' } : null,
    rrweb: {
      type: 'plugin',
      plugin: OPENSIN_RRWEB_PLUGIN_NAME,
      data: {
        requestId,
        phase,
        api: 'webRequest',
        method,
        url,
        tabId: typeof event.tabId === 'number' ? event.tabId : null,
        frameUrl: null,
      },
    },
    devtoolsRecorder: {
      type: 'network',
      requestId,
      phase,
      method,
      url,
      status: typeof event.status === 'number' ? event.status : null,
    },
  };
}

/**
 * Build the canonical session export object consumed by replay/inference tooling.
 *
 * The schema deliberately exposes both raw OpenSIN-native events and thin
 * compatibility mirrors. Downstream code can either consume the OpenSIN shape
 * directly or translate from the embedded rrweb/Recorder hints without guessing.
 */
export function buildSessionExport({
  sessionId,
  startedAt,
  exportedAt = Date.now(),
  tabId = null,
  frameUrl = null,
  networkEvents = [],
  webRequestEvents = [],
} = {}) {
  const normalizedMainWorldEvents = networkEvents.map((event, index) => normalizeMainWorldNetworkEvent(event, index));
  const normalizedWebRequestEvents = webRequestEvents.map((event, index) => normalizeWebRequestEvent(event, index));
  const events = [...normalizedMainWorldEvents, ...normalizedWebRequestEvents].sort((left, right) => left.timestamp - right.timestamp);
  const firstTimestamp = events[0]?.timestamp || normalizeTimestamp(startedAt, exportedAt);
  const stableSessionId = sessionId || `session-${firstTimestamp}`;

  return {
    schemaVersion: OPENSIN_SESSION_EXPORT_SCHEMA,
    generatedAt: new Date(exportedAt).toISOString(),
    session: {
      id: stableSessionId,
      startedAt: new Date(normalizeTimestamp(startedAt, firstTimestamp)).toISOString(),
      exportedAt: new Date(exportedAt).toISOString(),
      tabId: typeof tabId === 'number' ? tabId : null,
      frameUrl: frameUrl || null,
    },
    compatibility: {
      rrweb: {
        strategy: 'custom-plugin-event',
        plugin: OPENSIN_RRWEB_PLUGIN_NAME,
      },
      chromeDevToolsRecorder: {
        strategy: 'network-step-mirror',
      },
    },
    events,
    summary: {
      totalEvents: events.length,
      mainWorldNetworkEvents: normalizedMainWorldEvents.length,
      webRequestEvents: normalizedWebRequestEvents.length,
    },
  };
}
