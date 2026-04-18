/**
 * ============================================================================== 
 * OpenSIN Component: behavior_timeline_store.mjs
 * ============================================================================== 
 *
 * DESCRIPTION / BESCHREIBUNG:
 * IndexedDB-backed session timeline storage with bounded buffered flushing.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Behavior recording can generate many events in short bursts. Writing every
 * event directly from the service worker into persistent storage would create
 * unnecessary transaction overhead, while keeping everything only in memory
 * would lose data whenever the MV3 worker is suspended.
 *
 * DESIGN / WARUM SO GEBAUT:
 * - IndexedDB stays the durable system of record for full session timelines.
 * - A small in-memory buffer smooths write bursts and keeps capture responsive.
 * - Flushes are deliberately bounded so one huge burst cannot monopolize the
 *   service worker event loop or create oversized transactions.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If this file breaks, recorded user behavior may become incomplete, delayed,
 * or disappear after a worker restart.
 * ============================================================================== 
 */

export const DEFAULT_TIMELINE_STORE_CONFIG = {
  dbName: 'OpenSIN_Behavior_Timeline',
  dbVersion: 1,
  sessionsStoreName: 'timeline_sessions',
  eventsStoreName: 'timeline_events',
  flushIntervalMs: 5000,
  maxBufferedEvents: 40,
  maxFlushBatchSize: 100,
  maxBufferedRetention: 500,
  listLimit: 100,
};

function defaultLogger(level, message, data) {
  const fn = console[level] || console.log;
  if (data === undefined) fn(`[OpenSIN timeline] ${message}`);
  else fn(`[OpenSIN timeline] ${message}`, data);
}

function sanitizeScope(scope = {}) {
  return {
    domain: typeof scope.domain === 'string' && scope.domain ? scope.domain : null,
    tabId: Number.isInteger(scope.tabId) ? scope.tabId : null,
    startedAt: Number.isFinite(scope.startedAt) ? scope.startedAt : Date.now(),
    source: typeof scope.source === 'string' && scope.source ? scope.source : 'bridge',
  };
}

function createSessionId(scope) {
  const safeDomain = String(scope.domain || 'global').replace(/[^a-zA-Z0-9.-]+/g, '-');
  const safeTab = scope.tabId == null ? 'tab-any' : `tab-${scope.tabId}`;
  return `${safeDomain}:${safeTab}:${scope.startedAt}`;
}

function normalizeEvent(event, sessionId, sequence, clock) {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const timestamp = Number.isFinite(safeEvent.timestamp) ? safeEvent.timestamp : clock();
  const type = typeof safeEvent.type === 'string' && safeEvent.type ? safeEvent.type : 'UNKNOWN';

  return {
    ...safeEvent,
    id: `${sessionId}:${sequence}`,
    sessionId,
    sequence,
    timestamp,
    receivedAt: clock(),
    type,
  };
}

export function createIndexedDbTimelineAdapter({
  indexedDBApi = globalThis.indexedDB,
  config = DEFAULT_TIMELINE_STORE_CONFIG,
  clock = () => Date.now(),
} = {}) {
  if (!indexedDBApi || typeof indexedDBApi.open !== 'function') {
    throw new Error('IndexedDB API is unavailable for behavior timeline storage');
  }

  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDBApi.open(config.dbName, config.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(config.sessionsStoreName)) {
          const sessions = db.createObjectStore(config.sessionsStoreName, { keyPath: 'sessionId' });
          sessions.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(config.eventsStoreName)) {
          const events = db.createObjectStore(config.eventsStoreName, { keyPath: 'id' });
          events.createIndex('sessionId', 'sessionId', { unique: false });
          events.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open timeline IndexedDB'));
    });

    return dbPromise;
  }

  async function getSession(sessionId) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(config.sessionsStoreName, 'readonly');
      const store = tx.objectStore(config.sessionsStoreName);
      const request = store.get(sessionId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Failed to read timeline session'));
    });
  }

  async function upsertSession(sessionRecord) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(config.sessionsStoreName, 'readwrite');
      const store = tx.objectStore(config.sessionsStoreName);
      store.put(sessionRecord);
      tx.oncomplete = () => resolve(sessionRecord);
      tx.onerror = () => reject(tx.error || new Error('Failed to write timeline session'));
      tx.onabort = () => reject(tx.error || new Error('Timeline session transaction aborted'));
    });
  }

  async function persistEvents(sessionRecord, events) {
    if (!Array.isArray(events) || events.length === 0) return { written: 0 };

    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([config.sessionsStoreName, config.eventsStoreName], 'readwrite');
      const sessions = tx.objectStore(config.sessionsStoreName);
      const timelineEvents = tx.objectStore(config.eventsStoreName);

      for (const event of events) {
        timelineEvents.put(event);
      }

      sessions.put({
        ...sessionRecord,
        eventCount: (sessionRecord.eventCount || 0) + events.length,
        lastEventAt: events[events.length - 1].timestamp,
        updatedAt: clock(),
      });

      tx.oncomplete = () => resolve({ written: events.length });
      tx.onerror = () => reject(tx.error || new Error('Failed to persist timeline events'));
      tx.onabort = () => reject(tx.error || new Error('Timeline event transaction aborted'));
    });
  }

  async function listSessions(limit = config.listLimit) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(config.sessionsStoreName, 'readonly');
      const store = tx.objectStore(config.sessionsStoreName);
      const request = store.getAll();
      request.onsuccess = () => {
        const sessions = Array.isArray(request.result) ? request.result : [];
        sessions.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
        resolve(sessions.slice(0, limit));
      };
      request.onerror = () => reject(request.error || new Error('Failed to list timeline sessions'));
    });
  }

  async function listEvents(sessionId, limit = config.listLimit) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(config.eventsStoreName, 'readonly');
      const store = tx.objectStore(config.eventsStoreName);
      const index = store.index('sessionId');
      const request = index.getAll(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const events = Array.isArray(request.result) ? request.result : [];
        events.sort((left, right) => left.sequence - right.sequence);
        resolve(events.slice(-limit));
      };
      request.onerror = () => reject(request.error || new Error('Failed to list timeline events'));
    });
  }

  return {
    getSession,
    upsertSession,
    persistEvents,
    listSessions,
    listEvents,
  };
}

export function createBehaviorTimelineStore({
  adapter,
  config = {},
  logger = defaultLogger,
  clock = () => Date.now(),
} = {}) {
  const mergedConfig = { ...DEFAULT_TIMELINE_STORE_CONFIG, ...config };
  const timelineAdapter = adapter || createIndexedDbTimelineAdapter({ config: mergedConfig, clock });

  let activeSession = null;
  let bufferedEvents = [];
  let flushTimer = null;
  let flushInFlight = false;
  let globalSequence = 0;

  function clearFlushTimer() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function scheduleFlush(delayMs = mergedConfig.flushIntervalMs) {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow('timer').catch((error) => {
        logger('error', `Behavior timeline timer flush failed: ${error.message}`);
      });
    }, delayMs);
  }

  async function ensureSession(scope = {}) {
    const normalizedScope = sanitizeScope(scope);
    const sessionId = normalizedScope.sessionId || createSessionId(normalizedScope);

    if (activeSession && activeSession.sessionId === sessionId) {
      return activeSession;
    }

    const existingSession = await timelineAdapter.getSession(sessionId);
    const sessionRecord = existingSession || {
      sessionId,
      scope: normalizedScope,
      startedAt: normalizedScope.startedAt,
      createdAt: clock(),
      updatedAt: clock(),
      eventCount: 0,
      lastEventAt: null,
    };

    await timelineAdapter.upsertSession(sessionRecord);
    activeSession = sessionRecord;
    return activeSession;
  }

  async function appendEvents(events, options = {}) {
    if (!Array.isArray(events) || events.length === 0) {
      return { accepted: 0, buffered: bufferedEvents.length };
    }

    const session = await ensureSession(options.scope || activeSession?.scope || {});

    const normalizedEvents = events.map((event) => {
      globalSequence += 1;
      return normalizeEvent(event, session.sessionId, globalSequence, clock);
    });

    bufferedEvents.push(...normalizedEvents);

    if (bufferedEvents.length > mergedConfig.maxBufferedRetention) {
      const overflow = bufferedEvents.length - mergedConfig.maxBufferedRetention;
      bufferedEvents.splice(0, overflow);
      logger('warn', `Behavior timeline buffer retention cap dropped ${overflow} oldest event(s)`);
    }

    if (bufferedEvents.length >= mergedConfig.maxBufferedEvents) {
      scheduleFlush(0);
    } else {
      scheduleFlush(mergedConfig.flushIntervalMs);
    }

    return {
      accepted: normalizedEvents.length,
      buffered: bufferedEvents.length,
      sessionId: session.sessionId,
    };
  }

  async function flushNow(reason = 'manual') {
    if (flushInFlight || bufferedEvents.length === 0 || !activeSession) {
      return {
        reason,
        flushed: 0,
        buffered: bufferedEvents.length,
        sessionId: activeSession?.sessionId || null,
      };
    }

    clearFlushTimer();
    flushInFlight = true;

    const batch = bufferedEvents.splice(0, mergedConfig.maxFlushBatchSize);

    try {
      const result = await timelineAdapter.persistEvents(activeSession, batch);
      const existingSession = await timelineAdapter.getSession(activeSession.sessionId);
      if (existingSession) activeSession = existingSession;

      if (bufferedEvents.length > 0) {
        scheduleFlush(0);
      }

      return {
        reason,
        flushed: result.written,
        buffered: bufferedEvents.length,
        sessionId: activeSession.sessionId,
      };
    } catch (error) {
      bufferedEvents = batch.concat(bufferedEvents).slice(-mergedConfig.maxBufferedRetention);
      logger('error', `Behavior timeline flush failed: ${error.message}`);
      scheduleFlush(mergedConfig.flushIntervalMs);
      throw error;
    } finally {
      flushInFlight = false;
    }
  }

  async function listEvents(sessionId = activeSession?.sessionId, limit = mergedConfig.listLimit) {
    if (!sessionId) return [];
    return timelineAdapter.listEvents(sessionId, limit);
  }

  async function listSessions(limit = mergedConfig.listLimit) {
    return timelineAdapter.listSessions(limit);
  }

  function getStatus() {
    return {
      sessionId: activeSession?.sessionId || null,
      bufferedEvents: bufferedEvents.length,
      flushInFlight,
      flushScheduled: flushTimer !== null,
      config: {
        flushIntervalMs: mergedConfig.flushIntervalMs,
        maxBufferedEvents: mergedConfig.maxBufferedEvents,
        maxFlushBatchSize: mergedConfig.maxFlushBatchSize,
        maxBufferedRetention: mergedConfig.maxBufferedRetention,
      },
    };
  }

  async function shutdown() {
    clearFlushTimer();
    return flushNow('shutdown');
  }

  return {
    ensureSession,
    appendEvents,
    flushNow,
    listEvents,
    listSessions,
    getStatus,
    shutdown,
    getActiveSession: () => activeSession,
  };
}
