/**
 * Structured logger for the MV3 service worker.
 *
 * Goals:
 * - every log has a timestamp, level, scope, and optional structured payload
 * - a bounded ring buffer is exposed via `getRecent()` so the popup/options UI
 *   can render operator-facing diagnostics without re-scraping console
 * - no PII leaks: payloads are shallow-cloned, values are capped, buffer-size bounded
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
    return { name: value.name, message: clampString(value.message), stack: clampString(value.stack || '') };
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

  const serialized = entry.data === undefined
    ? `[${entry.scope}] ${entry.message}`
    : `[${entry.scope}] ${entry.message}`;

  const fn = console[level] || console.log;
  if (entry.data === undefined) fn(serialized);
  else fn(serialized, entry.data);

  publish(entry);

  // Hard cap payload bytes to protect storage / UI consumers.
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
 * Shorthand helpers. `scope` is the logical subsystem name.
 */
export function logger(scope) {
  return {
    debug: (message, data) => log('debug', scope, message, data),
    info: (message, data) => log('info', scope, message, data),
    warn: (message, data) => log('warn', scope, message, data),
    error: (message, data) => log('error', scope, message, data),
  };
}

export function setMinLevel(level) {
  if (LEVELS[level]) minLevel = LEVELS[level];
}

export function onLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecent(count = 50) {
  const slice = ring.slice(-count);
  return slice.map((entry) => ({ ...entry }));
}

export function clearRecent() {
  ring.length = 0;
}
