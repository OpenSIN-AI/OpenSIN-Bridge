/**
 * MV3 service-worker state with optimistic persistence.
 *
 * The service worker is suspended aggressively; any data that must survive a
 * restart lives in chrome.storage.local. Everything else stays on the in-memory
 * singleton exposed here so hot paths never hit async storage.
 */

import { STORAGE_KEYS } from './config.js';
import { logger } from './logger.js';

const log = logger('state');

const memory = {
  auth: null,
  behaviorScope: null,
  wsAuthToken: null,
  visionKeys: null,
  configOverrides: null,
  startedAt: Date.now(),
};

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

export async function hydrate() {
  try {
    const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    memory.auth = stored[STORAGE_KEYS.auth] || null;
    memory.behaviorScope = stored[STORAGE_KEYS.behaviorScope] || null;
    memory.wsAuthToken = stored[STORAGE_KEYS.wsAuth] || null;
    memory.visionKeys = stored[STORAGE_KEYS.visionKeys] || null;
    memory.configOverrides = stored[STORAGE_KEYS.config] || null;
    log.info('state hydrated', {
      hasAuth: !!memory.auth,
      behaviorScope: memory.behaviorScope?.sessionId || null,
    });
  } catch (error) {
    log.warn('state hydrate failed', { message: error?.message });
  }
}

export function getAuth() {
  return memory.auth;
}

export function setAuth(value) {
  memory.auth = value || null;
  schedulePersist(STORAGE_KEYS.auth, memory.auth);
}

export function getBehaviorScope() {
  return memory.behaviorScope;
}

export function setBehaviorScope(value) {
  memory.behaviorScope = value || null;
  schedulePersist(STORAGE_KEYS.behaviorScope, memory.behaviorScope);
}

export function getWsAuthToken() {
  if (memory.wsAuthToken) return memory.wsAuthToken;
  memory.wsAuthToken = crypto.randomUUID();
  schedulePersist(STORAGE_KEYS.wsAuth, memory.wsAuthToken);
  return memory.wsAuthToken;
}

export function getVisionKeys() {
  return memory.visionKeys || {};
}

export function setVisionKeys(value) {
  memory.visionKeys = value && typeof value === 'object' ? { ...value } : null;
  schedulePersist(STORAGE_KEYS.visionKeys, memory.visionKeys);
}

export function getConfigOverrides() {
  return memory.configOverrides || {};
}

export function setConfigOverride(key, value) {
  const next = { ...(memory.configOverrides || {}) };
  if (value === undefined || value === null) delete next[key];
  else next[key] = value;
  memory.configOverrides = next;
  schedulePersist(STORAGE_KEYS.config, next);
}

export function getUptimeMs() {
  return Date.now() - memory.startedAt;
}
