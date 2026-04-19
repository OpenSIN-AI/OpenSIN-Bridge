/**
 * MV3 service-worker state with optimistic persistence.
 *
 * Supports two surfaces:
 *   - Typed getters/setters (getAuth/setAuth, getBehaviorScope, …)
 *   - Generic patch API (`init`, `patch`, `get`, `has`, `snapshot`, `health`)
 *     used for transport/status info the UI wants to read in bulk.
 *
 * Persisted values live in chrome.storage.local. Anything ephemeral lives in
 * the in-memory singleton so hot paths never hit async storage.
 */

import { STORAGE_KEYS } from './config.js';
import { logger } from './logger.js';

const log = logger('state');

// Persisted compartment — hydrated from chrome.storage.local.
const persisted = {
  auth: null,
  behaviorScope: null,
  wsAuthToken: null,
  visionKeys: null,
  configOverrides: null,
};

// Ephemeral compartment — lost on service-worker suspend.
const live = {
  startedAt: Date.now(),
  booted: false,
};

// Generic bag for transport/status info (ws, native, ready, bootError, …).
const bag = new Map();

const persistQueue = new Map();
let persistTimer = null;

function flushPersistQueue() {
  persistTimer = null;
  if (persistQueue.size === 0) return;
  const payload = Object.fromEntries(persistQueue.entries());
  persistQueue.clear();
  chrome.storage.local.set(payload).catch((error) => {
    log.warn('persist flush failed', { message: error?.message });
  });
}

function schedulePersist(key, value) {
  persistQueue.set(key, value);
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersistQueue, 100);
}

// ------- persisted compartment -------

export async function hydrate() {
  try {
    const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    persisted.auth = stored[STORAGE_KEYS.auth] || null;
    persisted.behaviorScope = stored[STORAGE_KEYS.behaviorScope] || null;
    persisted.wsAuthToken = stored[STORAGE_KEYS.wsAuth] || null;
    persisted.visionKeys = stored[STORAGE_KEYS.visionKeys] || null;
    persisted.configOverrides = stored[STORAGE_KEYS.config] || null;
    log.info('state hydrated', {
      hasAuth: !!persisted.auth,
      behaviorScope: persisted.behaviorScope?.sessionId || null,
    });
  } catch (error) {
    log.warn('state hydrate failed', { message: error?.message });
  }
}

/**
 * Boot the state module. Equivalent to `hydrate()` but returns the module for
 * fluent call-sites.
 */
export async function init() {
  await hydrate();
  live.booted = true;
  return { live, persisted };
}

export function getAuth() { return persisted.auth; }
export function setAuth(value) {
  persisted.auth = value || null;
  schedulePersist(STORAGE_KEYS.auth, persisted.auth);
}

export function getBehaviorScope() { return persisted.behaviorScope; }
export function setBehaviorScope(value) {
  persisted.behaviorScope = value || null;
  schedulePersist(STORAGE_KEYS.behaviorScope, persisted.behaviorScope);
}

export function getWsAuthToken() {
  if (persisted.wsAuthToken) return persisted.wsAuthToken;
  persisted.wsAuthToken = crypto.randomUUID();
  schedulePersist(STORAGE_KEYS.wsAuth, persisted.wsAuthToken);
  return persisted.wsAuthToken;
}

export function getVisionKeys() { return persisted.visionKeys || {}; }
export function setVisionKeys(value) {
  persisted.visionKeys = value && typeof value === 'object' ? { ...value } : null;
  schedulePersist(STORAGE_KEYS.visionKeys, persisted.visionKeys);
}

export function getConfigOverrides() { return persisted.configOverrides || {}; }
export function setConfigOverride(key, value) {
  const next = { ...(persisted.configOverrides || {}) };
  if (value === undefined || value === null) delete next[key];
  else next[key] = value;
  persisted.configOverrides = next;
  schedulePersist(STORAGE_KEYS.config, next);
}

// ------- generic bag -------

/**
 * Patch the generic status bag. Accepts nested objects and merges one level
 * deep: patch({ ws: { status: 'open' } }) replaces the whole `ws` entry.
 */
export function patch(update) {
  if (!update || typeof update !== 'object') return;
  for (const [key, value] of Object.entries(update)) bag.set(key, value);
}

export function get(key) {
  return bag.has(key) ? bag.get(key) : undefined;
}

export function has(key) {
  return bag.has(key);
}

export function snapshot() {
  return Object.fromEntries(bag.entries());
}

export function getUptimeMs() {
  return Date.now() - live.startedAt;
}

/**
 * Operator-facing health summary. Read by the popup and system.health tool.
 *
 * The generic `bag` entries (ws, native, clientId, ready, bootError, …) are
 * flattened to the top level so UIs can read them directly (e.g.
 * `health.ws.status`). Raw bag is still available under `bag`.
 */
export function health() {
  const flat = snapshot();
  return {
    booted: live.booted,
    uptimeMs: getUptimeMs(),
    startedAt: live.startedAt,
    hasAuth: !!persisted.auth,
    behaviorScope: persisted.behaviorScope?.sessionId || null,
    bag: flat,
    ...flat,
  };
}
