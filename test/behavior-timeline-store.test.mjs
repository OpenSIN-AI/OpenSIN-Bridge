import test from 'node:test';
import assert from 'node:assert/strict';
import { createBehaviorTimelineStore } from '../extension/background/behavior_timeline_store.mjs';

function createFakeAdapter() {
  const sessions = new Map();
  const events = [];

  return {
    sessions,
    events,
    async getSession(sessionId) {
      return sessions.get(sessionId) || null;
    },
    async upsertSession(sessionRecord) {
      sessions.set(sessionRecord.sessionId, { ...sessionRecord });
      return sessionRecord;
    },
    async persistEvents(sessionRecord, batch) {
      events.push(...batch.map((entry) => ({ ...entry })));
      sessions.set(sessionRecord.sessionId, {
        ...sessionRecord,
        eventCount: (sessionRecord.eventCount || 0) + batch.length,
        lastEventAt: batch[batch.length - 1]?.timestamp || null,
        updatedAt: Date.now(),
      });
      return { written: batch.length };
    },
    async listSessions(limit) {
      return Array.from(sessions.values()).slice(0, limit);
    },
    async listEvents(sessionId, limit) {
      return events.filter((entry) => entry.sessionId === sessionId).slice(-limit);
    },
  };
}

test('behavior timeline store flushes in bounded batches', async () => {
  const adapter = createFakeAdapter();
  const store = createBehaviorTimelineStore({
    adapter,
    config: {
      maxBufferedEvents: 10,
      maxFlushBatchSize: 3,
      flushIntervalMs: 1000,
      maxBufferedRetention: 20,
    },
  });

  const session = await store.ensureSession({ domain: 'example.com', tabId: 7, startedAt: 111 });
  await store.appendEvents([
    { type: 'CLICK', timestamp: 1 },
    { type: 'INPUT', timestamp: 2 },
    { type: 'FORM_SUBMIT', timestamp: 3 },
    { type: 'NAVIGATION', timestamp: 4 },
    { type: 'CLICK', timestamp: 5 },
  ], { scope: { domain: 'example.com', tabId: 7, startedAt: 111, sessionId: session.sessionId } });

  const firstFlush = await store.flushNow('test-first');
  assert.equal(firstFlush.flushed, 3);
  assert.equal(firstFlush.buffered, 2);
  assert.equal(adapter.events.length, 3);

  const secondFlush = await store.flushNow('test-second');
  assert.equal(secondFlush.flushed, 2);
  assert.equal(secondFlush.buffered, 0);
  assert.equal(adapter.events.length, 5);

  const persisted = await store.listEvents(session.sessionId, 10);
  assert.deepEqual(persisted.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
});

test('behavior timeline store schedules timer-based flushes', async () => {
  const adapter = createFakeAdapter();
  const store = createBehaviorTimelineStore({
    adapter,
    config: {
      maxBufferedEvents: 50,
      maxFlushBatchSize: 10,
      flushIntervalMs: 20,
      maxBufferedRetention: 50,
    },
  });

  const session = await store.ensureSession({ domain: 'example.com', tabId: 1, startedAt: 222 });
  await store.appendEvents([{ type: 'NAVIGATION', timestamp: 10 }], {
    scope: { domain: 'example.com', tabId: 1, startedAt: 222, sessionId: session.sessionId },
  });

  assert.equal(adapter.events.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(adapter.events.length, 1);

  const sessions = await store.listSessions(5);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, session.sessionId);
});
