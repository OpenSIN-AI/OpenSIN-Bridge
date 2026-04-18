import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENSIN_SESSION_EXPORT_SCHEMA,
  buildSessionExport,
} from '../extension/shared/session-export.mjs';

test('buildSessionExport emits a stable OpenSIN schema with rrweb and Recorder compatibility mirrors', () => {
  const exported = buildSessionExport({
    sessionId: 'session-123',
    startedAt: 1700000000000,
    tabId: 41,
    frameUrl: 'https://app.example/dashboard',
    networkEvents: [
      {
        requestId: 'fetch-1',
        api: 'fetch',
        phase: 'request',
        method: 'POST',
        url: 'https://api.example/tasks',
        timestamp: 1700000000001,
        tabId: 41,
        frameUrl: 'https://app.example/dashboard',
        request: {
          bodyKind: 'json',
          bodyLength: 17,
          bodyPreview: '{"task":"open"}',
          headers: { 'content-type': 'application/json' },
        },
      },
      {
        requestId: 'fetch-1',
        api: 'fetch',
        phase: 'response',
        method: 'POST',
        url: 'https://api.example/tasks',
        timestamp: 1700000000200,
        durationMs: 199,
        tabId: 41,
        frameUrl: 'https://app.example/dashboard',
        request: {
          bodyKind: 'json',
          bodyLength: 17,
          bodyPreview: '{"task":"open"}',
          headers: { 'content-type': 'application/json' },
        },
        response: {
          status: 201,
          ok: true,
          statusText: 'Created',
          bodyKind: 'json',
          bodyLength: 15,
          bodyPreview: '{"ok":true}',
          headers: { 'content-type': 'application/json' },
        },
      },
    ],
    webRequestEvents: [
      {
        requestId: 'wr-1',
        type: 'completed',
        method: 'POST',
        url: 'https://api.example/tasks',
        tabId: 41,
        status: 201,
        time: 1700000000205,
      },
    ],
  });

  assert.equal(exported.schemaVersion, OPENSIN_SESSION_EXPORT_SCHEMA);
  assert.equal(exported.session.id, 'session-123');
  assert.equal(exported.session.tabId, 41);
  assert.equal(exported.compatibility.rrweb.strategy, 'custom-plugin-event');
  assert.equal(exported.compatibility.chromeDevToolsRecorder.strategy, 'network-step-mirror');
  assert.equal(exported.summary.totalEvents, 3);
  assert.equal(exported.summary.mainWorldNetworkEvents, 2);
  assert.equal(exported.summary.webRequestEvents, 1);
  assert.equal(exported.events[0].requestId, 'fetch-1');
  assert.equal(exported.events[0].rrweb.type, 'plugin');
  assert.equal(exported.events[1].devtoolsRecorder.type, 'network');
  assert.equal(exported.events[1].response.status, 201);
  assert.equal(exported.events[2].source, 'chrome.webRequest');
});
