/**
 * ==============================================================================
 * OpenSIN Component: injector.test.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Focused tests for the OpenSIN Bridge injector DOM traversal helpers.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Issue #13 requires robust recursive open-shadow-root traversal plus
 * iframe-aware discovery. These tests prove the bridge can see through open
 * shadow roots and same-origin iframes without regressing existing query flows.
 *
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Assertions document the expected bridge contract.
 * 2. NO ASSUMPTIONS: A small fake DOM is constructed explicitly for each case.
 * 3. SECURITY FIRST: Cross-origin iframe access is simulated and must stay
 *    blocked, while the bridge reports that limitation instead of faking access.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If these tests fail, OpenSIN agents may miss actionable elements on modern
 * component-driven pages and produce incomplete snapshots.
 *
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const injectorSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'injector.js'), 'utf8');

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeElement {
  constructor(tagName, attributes = {}, textContent = '') {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
    this.textContent = textContent;
    this.value = attributes.value || '';
    this.type = attributes.type || '';
    this.name = attributes.name || '';
    this.id = attributes.id || '';
    this.placeholder = attributes.placeholder || '';
    this.href = attributes.href || '';
    this.src = attributes.src || '';
    this.dataset = {};
    this.offsetParent = attributes.hidden ? null : {};
    this.dispatchedEvents = [];
    this.clicked = false;
    this.focused = false;
    this.scrollCalls = 0;

    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('data-')) {
        const dataKey = key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
        this.dataset[dataKey] = value;
      }
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  attachShadow(root) {
    this.shadowRoot = root;
    root.host = this;
    return root;
  }

  setFrameDocument(document) {
    this._contentDocument = document;
    Object.defineProperty(this, 'contentDocument', {
      configurable: true,
      enumerable: true,
      get: () => this._contentDocument,
    });
  }

  setCrossOriginFrame(message = 'Blocked a frame with origin "child" from accessing a cross-origin frame.') {
    Object.defineProperty(this, 'contentDocument', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(message);
      },
    });
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  matches(selector) {
    return selector.split(',').some((part) => matchesSingleSelector(this, part.trim()));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];

    function visit(node) {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        visit(child);
      }
    }

    visit(this);
    return results;
  }

  dispatchEvent(event) {
    this.dispatchedEvents.push(event.type);
    return true;
  }

  click() {
    this.clicked = true;
  }

  focus() {
    this.focused = true;
  }

  scrollIntoView() {
    this.scrollCalls += 1;
  }

  getClientRects() {
    return this.offsetParent === null ? [] : [{ x: 0, y: 0, width: 10, height: 10 }];
  }

  getBoundingClientRect() {
    return { left: 1, top: 2, width: 100, height: 30, right: 101, bottom: 32 };
  }
}

class FakeShadowRoot {
  constructor(children = []) {
    this.children = [];
    for (const child of children) {
      this.appendChild(child);
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];

    function visit(node) {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        visit(child);
      }
    }

    visit(this);
    return results;
  }
}

class FakeDocument {
  constructor({ title = 'Test Page', url = 'https://example.com/' } = {}) {
    this.title = title;
    this.readyState = 'complete';
    this.location = { href: url };
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.documentElement.appendChild(this.body);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];

    if (this.documentElement.matches(selector)) {
      results.push(this.documentElement);
    }

    function visit(node) {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        visit(child);
      }
    }

    visit(this.documentElement);
    return results;
  }
}

function matchesSingleSelector(element, selector) {
  if (!selector) return false;
  if (selector === '*') return true;

  let remaining = selector;
  let expectedTag = null;
  const expectedId = selector.match(/#([a-zA-Z0-9_-]+)/)?.[1] || null;
  const attributeMatches = Array.from(selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g));

  remaining = remaining.replace(/#([a-zA-Z0-9_-]+)/g, '').replace(/\[[^\]]+\]/g, '').trim();
  if (remaining) {
    expectedTag = remaining.toUpperCase();
  }

  if (expectedTag && element.tagName !== expectedTag) return false;
  if (expectedId && element.id !== expectedId) return false;

  for (const match of attributeMatches) {
    const attributeName = match[1];
    const expectedValue = match[2];
    const actualValue = element.getAttribute(attributeName);
    if (expectedValue === undefined) {
      if (actualValue == null) return false;
      continue;
    }
    if (String(actualValue) !== expectedValue) return false;
  }

  return true;
}

function createHarness() {
  const document = new FakeDocument({
    title: 'OpenSIN DOM Harness',
    url: 'https://host.example/app',
  });

  const hostButton = new FakeElement('button', { id: 'light-button' }, 'Light Button');
  document.body.appendChild(hostButton);

  const shadowHost = document.body.appendChild(new FakeElement('div', { id: 'shadow-host' }));
  const nestedShadowHost = new FakeElement('section', { id: 'nested-shadow-host' });
  const shadowButton = new FakeElement('button', { id: 'shadow-button' }, 'Shadow Button');
  const shadowInput = new FakeElement('input', {
    id: 'shadow-input',
    name: 'shadow-field',
    placeholder: 'Shadow Input',
    type: 'text',
  });
  const shadowLink = new FakeElement('a', { id: 'shadow-link', href: 'https://shadow.example/' }, 'Shadow Link');
  const nestedShadowRoot = new FakeShadowRoot([shadowButton]);
  nestedShadowHost.attachShadow(nestedShadowRoot);
  const shadowRoot = new FakeShadowRoot([shadowInput, shadowLink, nestedShadowHost]);
  shadowHost.attachShadow(shadowRoot);

  const sameOriginFrame = document.body.appendChild(new FakeElement('iframe', { id: 'same-origin-frame', src: '/same-origin-frame' }));
  const sameOriginDocument = new FakeDocument({
    title: 'Frame Page',
    url: 'https://host.example/frame',
  });
  const frameInput = sameOriginDocument.body.appendChild(new FakeElement('input', {
    id: 'frame-input',
    name: 'frame-field',
    placeholder: 'Frame Input',
    type: 'text',
  }));
  const frameButton = sameOriginDocument.body.appendChild(new FakeElement('button', { id: 'frame-button' }, 'Frame Button'));
  sameOriginFrame.setFrameDocument(sameOriginDocument);

  const crossOriginFrame = document.body.appendChild(new FakeElement('iframe', { id: 'cross-origin-frame', src: 'https://remote.example/' }));
  crossOriginFrame.setCrossOriginFrame();

  const windowObject = {
    location: document.location,
    document,
    navigator: { permissions: { query: () => Promise.resolve({ state: 'granted' }) } },
    Notification: { permission: 'granted' },
    fetch: async () => ({ status: 200 }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout,
    clearTimeout,
  };

  const context = {
    window: windowObject,
    document,
    chrome: { runtime: { getManifest: () => ({ version: '9.9.9-test' }) } },
    crypto: { randomUUID: () => 'nonce-for-test' },
    navigator: windowObject.navigator,
    Notification: windowObject.Notification,
    fetch: windowObject.fetch,
    XMLHttpRequest: class FakeXMLHttpRequest {
      open() {}
      send() {}
    },
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    MutationObserver: class FakeMutationObserver {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    console,
    Symbol,
    Date,
    Math,
  };

  windowObject.window = windowObject;
  windowObject.crypto = context.crypto;

  vm.createContext(context);
  vm.runInContext(injectorSource, context, { filename: 'injector.js' });

  return {
    window: windowObject,
    document,
    bridge: windowObject.__SIN_BRIDGE__,
    sameOriginFrame,
    crossOriginFrame,
    shadowButton,
    shadowInput,
    frameButton,
    frameInput,
  };
}

describe('OpenSIN injector shadow DOM traversal', () => {
  it('surfaces open shadow root and same-origin iframe content in snapshot output', () => {
    const { bridge } = createHarness();

    const snapshot = bridge.snapshot();

    assert.ok(snapshot.buttons.some((entry) => entry.text === 'Shadow Button'));
    assert.ok(snapshot.inputs.some((entry) => entry.id === 'shadow-input'));
    assert.ok(snapshot.links.some((entry) => entry.href === 'https://shadow.example/'));
    assert.ok(snapshot.buttons.some((entry) => entry.text === 'Frame Button'));
    assert.ok(snapshot.inputs.some((entry) => entry.id === 'frame-input'));
    assert.ok(snapshot.buttons.some((entry) => entry.location.includes('::shadow')));
    assert.ok(snapshot.buttons.some((entry) => entry.location.includes('iframe#same-origin-frame')));
    assert.ok(snapshot.limitations.some((entry) => entry.type === 'iframe-cross-origin'));
    assert.ok(snapshot.notes.some((entry) => /Closed shadow roots/.test(entry)));
  });

  it('exposes deep query helpers consistently across bridge and global compatibility APIs', () => {
    const { bridge, shadowButton, frameButton, frameInput, window } = createHarness();

    assert.strictEqual(bridge.$('#shadow-button'), shadowButton);
    assert.strictEqual(bridge.$('#frame-button'), frameButton);
    assert.strictEqual(window._sinDeepQuery('#frame-input'), frameInput);

    const allButtons = bridge.$$('button');
    assert.strictEqual(allButtons.length, 3);
    assert.ok(allButtons.includes(shadowButton));
    assert.ok(allButtons.includes(frameButton));

    const allInputs = window._sinDeepQueryAll('input');
    assert.strictEqual(allInputs.length, 2);
    assert.ok(allInputs.includes(frameInput));
  });

  it('lets mutating bridge methods target elements discovered through deep traversal', () => {
    const { bridge, shadowButton, shadowInput } = createHarness();
    const nonce = bridge[Symbol.for('__SIN_BRIDGE_NONCE__')];

    const clickResult = bridge.click(nonce, '#shadow-button');
    assert.strictEqual(clickResult.found, true);
    assert.strictEqual(shadowButton.clicked, true);
    assert.deepStrictEqual(shadowButton.dispatchedEvents.slice(0, 2), ['mousedown', 'mouseup']);

    const typeResult = bridge.type(nonce, '#shadow-input', 'OpenSIN');
    assert.strictEqual(typeResult.found, true);
    assert.strictEqual(shadowInput.value, 'OpenSIN');
    assert.ok(shadowInput.dispatchedEvents.includes('input'));

    const fillResult = bridge.fillForm(nonce, { 'frame-field': 'From Frame', 'shadow-field': 'Shadow Fill' });
    assert.strictEqual(fillResult['frame-field'].filled, true);
    assert.strictEqual(fillResult['shadow-field'].filled, true);
  });
});
