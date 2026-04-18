import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const injectorSource = fs.readFileSync(
  path.join(process.cwd(), 'extension', 'content', 'injector.js'),
  'utf8',
);

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeHeaders {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
  }

  entries() {
    return this.map.entries();
  }
}

class FakeResponse {
  constructor({ status = 200, ok = true, statusText = 'OK', body = '', headers = {} } = {}) {
    this.status = status;
    this.ok = ok;
    this.statusText = statusText;
    this._body = body;
    this.headers = new FakeHeaders(headers);
  }

  clone() {
    return new FakeResponse({
      status: this.status,
      ok: this.ok,
      statusText: this.statusText,
      body: this._body,
      headers: Object.fromEntries(this.headers.entries()),
    });
  }

  async text() {
    return this._body;
  }
}

class FakeXMLHttpRequestBase {
  constructor() {
    this.listeners = new Map();
    this.responseText = '{"saved":true}';
    this.status = 202;
    this.statusText = 'Accepted';
  }

  addEventListener(type, callback) {
    const list = this.listeners.get(type) || [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  dispatch(type) {
    for (const callback of this.listeners.get(type) || []) {
      callback.call(this, new FakeEvent(type));
    }
  }

  open(method, url) {
    this._openArgs = { method, url };
  }

  setRequestHeader(name, value) {
    this._headers = this._headers || {};
    this._headers[name] = value;
  }

  send(body) {
    this._body = body;
    this.dispatch('load');
  }
}

function createHarness() {
  const sentMessages = [];
  const fetchEvents = [];
  const xhrEvents = [];

  class HarnessXMLHttpRequest extends FakeXMLHttpRequestBase {}

  const document = {
    title: 'OpenSIN Test Page',
    readyState: 'complete',
    body: {},
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const windowObject = {
    location: { href: 'https://app.example/dashboard' },
    document,
    navigator: { permissions: { query: () => Promise.resolve({ state: 'granted' }) } },
    Notification: { permission: 'granted' },
    fetch: async () => new FakeResponse({
      status: 201,
      ok: true,
      statusText: 'Created',
      body: '{"id":1}',
      headers: { 'content-type': 'application/json' },
    }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout,
    clearTimeout,
  };

  const context = {
    window: windowObject,
    document,
    chrome: {
      runtime: {
        sendMessage: (message) => {
          sentMessages.push(message);
        },
      },
    },
    crypto: { randomUUID: () => 'nonce-for-test' },
    navigator: windowObject.navigator,
    Notification: windowObject.Notification,
    fetch: windowObject.fetch,
    XMLHttpRequest: HarnessXMLHttpRequest,
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    FormData,
    Blob,
    ArrayBuffer,
    console,
    Symbol,
    Date,
    Math,
  };

  windowObject.window = windowObject;
  windowObject.chrome = context.chrome;
  windowObject.crypto = context.crypto;
  windowObject.XMLHttpRequest = HarnessXMLHttpRequest;

  vm.createContext(context);
  vm.runInContext(injectorSource, context, { filename: 'injector.js' });

  const bridge = windowObject.__SIN_BRIDGE__;
  const nonce = bridge[Symbol.for('__SIN_BRIDGE_NONCE__')];
  bridge.interceptFetch(nonce, (event) => fetchEvents.push(event));
  bridge.interceptXHR(nonce, (event) => xhrEvents.push(event));

  return {
    bridge,
    nonce,
    sentMessages,
    fetchEvents,
    xhrEvents,
    window: windowObject,
    context,
  };
}

test('injector auto-captures MAIN-world fetch request/response pairs and still supports manual subscribers', async () => {
  const { sentMessages, fetchEvents, window } = createHarness();

  await window.fetch('https://api.example/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'open' }),
  });

  assert.equal(fetchEvents.length, 2);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0]._sinBridgeType, 'NETWORK_EVENT');
  assert.equal(sentMessages[0].payload.api, 'fetch');
  assert.equal(sentMessages[0].payload.phase, 'request');
  assert.equal(sentMessages[0].payload.request.bodyKind, 'text');
  assert.match(sentMessages[0].payload.request.bodyPreview, /task/);
  assert.equal(sentMessages[1].payload.phase, 'response');
  assert.equal(sentMessages[1].payload.response.status, 201);
  assert.equal(sentMessages[1].payload.response.bodyKind, 'text');
});

test('injector auto-captures MAIN-world XHR request/response pairs and keeps callback compatibility', () => {
  const { sentMessages, xhrEvents, context } = createHarness();

  vm.runInContext(`
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', 'https://api.example/tasks/1');
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.send('{\"status\":\"done\"}');
  `, context);

  assert.equal(xhrEvents.length, 2);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].payload.api, 'xhr');
  assert.equal(sentMessages[0].payload.phase, 'request');
  assert.equal(sentMessages[0].payload.request.bodyKind, 'text');
  assert.equal(sentMessages[1].payload.phase, 'response');
  assert.equal(sentMessages[1].payload.response.status, 202);
  assert.equal(sentMessages[1].payload.response.bodyKind, 'text');
});
