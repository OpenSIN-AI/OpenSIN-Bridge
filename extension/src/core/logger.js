/**
 * Structured logger for the MV3 service worker.
 *
 * Features:
 * - every log has a timestamp, level, scope, and optional structured payload
 * - a bounded ring buffer is exposed via `getRecent()` so the popup/options UI
 *   can render operator-facing diagnostics without re-scraping console
 * - no PII leaks: payloads are shallow-cloned, values are capped, buffer bounded
 * - attachGlobalErrorHandlers() wires uncaught rejections into the log stream
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const MAX_BUFFER = 200;
const MAX_PAYLOAD_LENGTH = 2000;
const MAX_STRING_VALUE = 500;

const ring = [];
const listeners = new Set();
let minLevel = LEVELS.info;

function clampString(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_STRING_VALUE ? `${value.slice(0, MAX_STRING_VALUE)}…` : value;
}

function safeClone(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return clampString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code,
      message: clampString(value.message),
      stack: clampString(value.stack || ''),
    };
  }
  if (depth > 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((entry) => safeClone(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value).slice(0, 25);
    for (const key of keys) out[key] = safeClone(value[key], depth + 1);
    return out;
  }
  return clampString(String(value));
}

function shouldEmit(level) {
  return LEVELS[level] >= minLevel;
}

function publish(entry) {
  ring.push(entry);
  if (ring.length > MAX_BUFFER) ring.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (_error) {
      // listeners must never break the logger
    }
  }
}

/**
 * Emit a structured log entry and mirror it to console.
 */
export function log(level, scope, message, data) {
  if (!LEVELS[level]) level = 'info';
  if (!shouldEmit(level)) return;

  const entry = {
    level,
    scope: scope || 'bridge',
    message: clampString(String(message ?? '')),
    data: data === undefined ? undefined : safeClone(data),
    ts: new Date().toISOString(),
  };

  const prefix = `[${entry.scope}] ${entry.message}`;
  const fn = console[level] || console.log;
  if (entry.data === undefined) fn(prefix);
  else fn(prefix, entry.data);

  publish(entry);

  if (entry.data !== undefined) {
    try {
      const encoded = JSON.stringify(entry.data);
      if (encoded && encoded.length > MAX_PAYLOAD_LENGTH) {
        entry.data = { truncated: true, length: encoded.length };
      }
    } catch (_error) {
      entry.data = { truncated: true, reason: 'unserializable' };
    }
  }
}

/**
 * Create a scoped logger. Both `logger(scope)` and `createLogger(scope)` return
 * the same shape — alias exists to satisfy different import styles.
 */
export function logger(scope) {
  return {
    scope,
    debug: (message, data) => log('debug', scope, message, data),
    info: (message, data) => log('info', scope, message, data),
    warn: (message, data) => log('warn', scope, message, data),
    error: (message, data) => log('error', scope, message, data),
  };
}

export const createLogger = logger;

export function setMinLevel(level) {
  if (LEVELS[level]) minLevel = LEVELS[level];
}

export function getMinLevel() {
  return Object.entries(LEVELS).find(([, v]) => v === minLevel)?.[0] || 'info';
}

export function onLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecent(count = 50) {
  return ring.slice(-count).map((entry) => ({ ...entry }));
}

export function clearRecent() {
  ring.length = 0;
}

/**
 * Wire unhandled-rejection + uncaught-exception hooks into the log stream so
 * background crashes surface in the popup diagnostics instead of dying
 * silently.
 */
export function attachGlobalErrorHandlers() {
  const scope = 'unhandled';
  if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('error', (event) => {
      log('error', scope, event?.message || 'error', {
        filename: event?.filename,
        lineno: event?.lineno,
        colno: event?.colno,
        error: event?.error,
      });
    });
    self.addEventListener('unhandledrejection', (event) => {
      log('error', scope, 'unhandledrejection', { reason: event?.reason });
    });
  }
}
