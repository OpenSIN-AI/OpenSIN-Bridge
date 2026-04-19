/**
 * Shared, pure helpers used across the bridge.
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
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
 * Exponential backoff delay with full jitter. Useful for reconnect paths.
 */
export function backoffDelay(attempt, baseMs, maxMs, jitter = 0.25) {
  const pure = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitterWindow = pure * jitter;
  return Math.round(pure - jitterWindow + Math.random() * jitterWindow * 2);
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
 * Resolve with the function's result or reject with a TIMEOUT after ms.
 * Does NOT cancel the underlying work — callers must treat timeout as a hint
 * to fail fast.
 */
export function withTimeout(promise, ms, onTimeoutMessage = 'timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
    promise.then(
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
 * Generate a deterministic-but-unique id for pairing request/response.
 */
let requestCounter = 0;
export function createRequestId(prefix = 'req') {
  requestCounter += 1;
  return `${prefix}-${Date.now()}-${requestCounter.toString(36)}`;
}

/**
 * Stable hash used for visual diffs. Not cryptographic.
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
 * True if the URL is safe to treat as the start of a navigation target.
 */
export function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}
