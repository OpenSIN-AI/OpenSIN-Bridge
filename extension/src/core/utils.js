/**
 * Shared, pure helpers used across the bridge.
 *
 * No chrome.* imports here — the utilities are usable from the service worker,
 * content scripts, the popup, and offscreen documents.
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

/**
 * Monotonic(-ish) milliseconds. Uses performance.timeOrigin + now when the
 * host exposes it; falls back to Date.now. Always returns a number.
 */
export function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    // performance.timeOrigin may be undefined in older workers — fallback.
    return Math.round((performance.timeOrigin || 0) + performance.now());
  }
  return Date.now();
}

export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function randomInt(min, max) {
  return Math.round(randomBetween(min, max));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Apply ±jitter as a fraction of `baseMs` (e.g. jitter(1000, 0.3) ~ 700–1300).
 */
export function jitter(baseMs, fraction = 0.3) {
  const factor = 1 + (Math.random() * 2 - 1) * clamp(fraction, 0, 1);
  return Math.max(0, baseMs * factor);
}

/**
 * Exponential backoff delay with full jitter. Useful for reconnect paths.
 */
export function backoffDelay(attempt, baseMs, maxMs, jitterFraction = 0.25) {
  const pure = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const window = pure * jitterFraction;
  return Math.round(pure - window + Math.random() * window * 2);
}

/**
 * Append to a ring buffer in place.
 */
export function pushBounded(list, entry, limit) {
  list.push(entry);
  while (list.length > limit) list.shift();
}

/**
 * Truncate a string to `limit` with an ellipsis suffix.
 */
export function truncate(value, limit) {
  if (typeof value !== 'string') return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

/**
 * Attempt to parse JSON safely, returning `fallback` on failure.
 */
export function safeJsonParse(raw, fallback = null) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Race a promise against a deadline. Rejects with an Error tagged TIMEOUT if
 * the deadline is reached first. Does NOT cancel the underlying work.
 */
export function withTimeout(promise, ms, onTimeoutMessage = 'timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(onTimeoutMessage);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Alias for withTimeout using tool-facing naming.
 */
export const deadline = withTimeout;

/**
 * Generate a deterministic-but-unique id for pairing request/response.
 */
let requestCounter = 0;
export function createRequestId(prefix = 'req') {
  requestCounter += 1;
  return `${prefix}-${Date.now()}-${requestCounter.toString(36)}`;
}

/**
 * RFC4122-ish UUID v4 using crypto when available.
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (rare path, MV3 SW always has crypto).
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += chars[8 + Math.floor(Math.random() * 4)];
    } else {
      out += chars[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

/**
 * Stable non-cryptographic hash (FNV-1a). Used for visual diffs.
 */
export function cheapHash(input) {
  const str = String(input);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * True if the URL is a http(s) URL.
 */
export function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

/**
 * Tiny event bus.
 *   const bus = bindBus();
 *   const off = bus.on('status', (s) => ...);
 *   bus.emit('status', 'open');
 *   off();
 */
export function bindBus() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (typeof handler !== 'function') return () => {};
      const set = listeners.get(event) || new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => this.off(event, handler);
    },
    off(event, handler) {
      const set = listeners.get(event);
      if (set) set.delete(handler);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch (_err) {
          // subscribers must not break the emitter
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
