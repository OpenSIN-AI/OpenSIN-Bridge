const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const injectorSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'injector.js'), 'utf8');

function createHarness() {
  const messages = [];
  const documentListeners = new Map();
  const windowListeners = new Map();

  const document = {
    title: 'OpenSIN Page',
    readyState: 'complete',
    body: {},
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };

  const windowObject = {
    location: { href: 'https://example.com/app' },
    history: {
      pushState() {},
      replaceState() {},
    },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    getComputedStyle() {
      return { display: 'block', visibility: 'visible', opacity: '1' };
    },
    document,
  };

  const context = {
    window: windowObject,
    document,
    chrome: {
      runtime: {
        getManifest: () => ({ version: '4.0.0-test' }),
        sendMessage: (payload, callback) => {
          messages.push(payload);
          if (callback) callback({ success: true });
        },
        lastError: null,
      },
    },
    crypto: { randomUUID: () => 'nonce-for-test' },
    navigator: { permissions: { query: () => Promise.resolve({ state: 'granted' }) } },
    Notification: { permission: 'granted' },
    MutationObserver: class FakeMutationObserver {
      observe() {}
      disconnect() {}
    },
    XMLHttpRequest: class FakeXMLHttpRequest {
      open() {}
      send() {}
    },
    Event: class FakeEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MouseEvent: class FakeMouseEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    KeyboardEvent: class FakeKeyboardEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    setTimeout,
    clearTimeout,
    console,
  };

  windowObject.window = windowObject;
  vm.createContext(context);
  vm.runInContext(injectorSource, context, { filename: 'injector.js' });

  return {
    bridge: windowObject.__SIN_BRIDGE__,
    messages,
    documentListeners,
    windowListeners,
  };
}

function createElement(overrides = {}) {
  const parent = overrides.parentElement || null;
  return {
    tagName: overrides.tagName || 'BUTTON',
    id: overrides.id || '',
    name: overrides.name || '',
    type: overrides.type || '',
    value: overrides.value || '',
    textContent: overrides.textContent || '',
    innerText: overrides.innerText || overrides.textContent || '',
    placeholder: overrides.placeholder || '',
    href: overrides.href || '',
    action: overrides.action || '',
    formAction: overrides.formAction || '',
    method: overrides.method || '',
    offsetParent: {},
    parentElement: parent,
    getClientRects() { return [{ x: 0, y: 0, width: 10, height: 10 }]; },
    closest(selector) {
      if (selector === 'form' && overrides.form) return overrides.form;
      return this;
    },
  };
}

test('injector behavior capture throttles clicks and debounces inputs', async () => {
  const { bridge, messages } = createHarness();
  const hooks = bridge[Symbol.for('__SIN_BRIDGE_CAPTURE_TEST__')];
  const button = createElement({ tagName: 'BUTTON', id: 'save-button', textContent: 'Save' });
  const input = createElement({ tagName: 'INPUT', id: 'email', name: 'email', type: 'email', value: 'first@example.com' });

  hooks.handleClick({ target: button, isTrusted: true });
  hooks.handleClick({ target: button, isTrusted: true });
  assert.equal(messages.filter((entry) => entry.payload.type === 'CLICK').length, 1);

  hooks.handleInput({ target: input, type: 'input', isTrusted: true });
  input.value = 'second@example.com';
  hooks.handleInput({ target: input, type: 'input', isTrusted: true });
  hooks.flushPendingInputs();

  const inputMessages = messages.filter((entry) => entry.payload.type === 'INPUT');
  assert.equal(inputMessages.length, 1);
  assert.equal(inputMessages[0].payload.value, 'second@example.com');
});

test('injector behavior capture emits submit and navigation markers', () => {
  const { bridge, messages } = createHarness();
  const hooks = bridge[Symbol.for('__SIN_BRIDGE_CAPTURE_TEST__')];
  const form = createElement({ tagName: 'FORM', action: 'https://example.com/submit', method: 'post' });

  hooks.handleSubmit({ target: form, isTrusted: true });
  hooks.recordNavigationMarker('history-push-state');
  hooks.recordNavigationMarker('history-push-state');

  const submitMessages = messages.filter((entry) => entry.payload.type === 'FORM_SUBMIT');
  const navigationMessages = messages.filter((entry) => entry.payload.type === 'NAVIGATION' && entry.payload.marker === 'history-push-state');

  assert.equal(submitMessages.length, 1);
  assert.equal(submitMessages[0].payload.formAction, 'https://example.com/submit');
  assert.equal(navigationMessages.length, 1);
});
