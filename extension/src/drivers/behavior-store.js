/**
 * Behavior timeline store: durable session + event stream backed by IndexedDB.
 *
 * Contract:
 * - capture and persist is opt-in; if nothing calls enableRecording(), the
 *   store idles and never writes
 * - writes are buffered so bursts don't thrash IndexedDB
 * - bounded retention so a runaway page cannot OOM the service worker
 * - privacy redaction happens in the caller; this module is privacy-blind
 */

import { BEHAVIOR } from '../core/config.js';
import { logger } from '../core/logger.js';

const log = logger('behavior-store');

let dbPromise = null;
let activeSession = null;
let buffered = [];
let flushTimer = null;
let flushInFlight = false;
let sequence = 0;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(BEHAVIOR.dbName, BEHAVIOR.dbVersion);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(BEHAVIOR.sessionsStore)) {
        const sessions = db.createObjectStore(BEHAVIOR.sessionsStore, { keyPath: 'sessionId' });
        sessions.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(BEHAVIOR.eventsStore)) {
        const events = db.createObjectStore(BEHAVIOR.eventsStore, { keyPath: 'id' });
        events.createIndex('sessionId', 'sessionId', { unique: false });
        events.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('open db failed'));
  });
  return dbPromise;
}

function buildSessionId(scope) {
  const domain = String(scope.domain || 'global').replace(/[^a-zA-Z0-9.-]+/g, '-');
  const tab = scope.tabId == null ? 'tab-any' : `tab-${scope.tabId}`;
  return `${domain}:${tab}:${scope.startedAt}`;
}

async function upsertSession(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BEHAVIOR.sessionsStore, 'readwrite');
    tx.objectStore(BEHAVIOR.sessionsStore).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

async function persistEvents(session, events) {
  if (events.length === 0) return { written: 0 };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BEHAVIOR.sessionsStore, BEHAVIOR.eventsStore], 'readwrite');
    const eventStore = tx.objectStore(BEHAVIOR.eventsStore);
    for (const event of events) eventStore.put(event);

    tx.objectStore(BEHAVIOR.sessionsStore).put({
      ...session,
      eventCount: (session.eventCount || 0) + events.length,
      lastEventAt: events[events.length - 1].timestamp,
      updatedAt: Date.now(),
    });

    tx.oncomplete = () => resolve({ written: events.length });
    tx.onerror = () => reject(tx.error);
  });
}

function scheduleFlush(delayMs = BEHAVIOR.flushIntervalMs) {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow('timer').catch((error) => log.warn('timer flush failed', { message: error?.message }));
  }, Math.max(0, delayMs));
}

export async function ensureSession({ domain = null, tabId = null, startedAt = Date.now(), source = 'runtime' } = {}) {
  const scope = { domain: domain || null, tabId: Number.isInteger(tabId) ? tabId : null, startedAt, source };
  const sessionId = buildSessionId(scope);

  if (activeSession?.sessionId === sessionId) return activeSession;

  const record = {
    sessionId,
    scope,
    startedAt,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    eventCount: 0,
    lastEventAt: null,
  };
  await upsertSession(record);
  activeSession = record;
  return activeSession;
}

export async function appendEvents(events, { scope, reason = 'runtime' } = {}) {
  if (!Array.isArray(events) || events.length === 0) return { accepted: 0, buffered: buffered.length };
  const session = await ensureSession(scope || activeSession?.scope || {});

  const normalized = events.map((event) => {
    sequence += 1;
    const safe = event && typeof event === 'object' ? event : {};
    return {
      ...safe,
      id: `${session.sessionId}:${sequence}`,
      sessionId: session.sessionId,
      sequence,
      timestamp: Number.isFinite(safe.timestamp) ? safe.timestamp : Date.now(),
      receivedAt: Date.now(),
      type: typeof safe.type === 'string' ? safe.type : 'UNKNOWN',
      reason,
    };
  });

  buffered.push(...normalized);
  if (buffered.length > BEHAVIOR.maxRetainedBuffer) {
    buffered.splice(0, buffered.length - BEHAVIOR.maxRetainedBuffer);
  }

  if (buffered.length >= BEHAVIOR.maxBufferedEvents) {
    scheduleFlush(0);
  } else {
    scheduleFlush();
  }

  return { accepted: normalized.length, buffered: buffered.length, sessionId: session.sessionId };
}

export async function flushNow(reason = 'manual') {
  if (flushInFlight || !activeSession || buffered.length === 0) {
    return { reason, flushed: 0, buffered: buffered.length, sessionId: activeSession?.sessionId || null };
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushInFlight = true;
  const batch = buffered.splice(0, BEHAVIOR.maxFlushBatchSize);

  try {
    const result = await persistEvents(activeSession, batch);
    if (buffered.length > 0) scheduleFlush(0);
    return { reason, flushed: result.written, buffered: buffered.length, sessionId: activeSession.sessionId };
  } catch (error) {
    log.error('flush failed', { message: error?.message });
    buffered = batch.concat(buffered).slice(-BEHAVIOR.maxRetainedBuffer);
    scheduleFlush();
    throw error;
  } finally {
    flushInFlight = false;
  }
}

export async function listSessions(limit = 20) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BEHAVIOR.sessionsStore, 'readonly');
    const request = tx.objectStore(BEHAVIOR.sessionsStore).getAll();
    request.onsuccess = () => {
      const sessions = request.result || [];
      sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(sessions.slice(0, limit));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function listEvents(sessionId, limit = 200) {
  if (!sessionId) return [];
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BEHAVIOR.eventsStore, 'readonly');
    const index = tx.objectStore(BEHAVIOR.eventsStore).index('sessionId');
    const request = index.getAll(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const events = request.result || [];
      events.sort((a, b) => a.sequence - b.sequence);
      resolve(events.slice(-limit));
    };
    request.onerror = () => reject(request.error);
  });
}

export function getStatus() {
  return {
    sessionId: activeSession?.sessionId || null,
    buffered: buffered.length,
    flushInFlight,
    flushScheduled: flushTimer !== null,
  };
}

export async function shutdown() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flushNow('shutdown');
}

export function resetForTests() {
  activeSession = null;
  buffered = [];
  sequence = 0;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
