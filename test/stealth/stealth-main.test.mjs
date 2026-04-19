/**
 * Node unit test for extension/src/content/stealth-main.js
 * ========================================================
 *
 * The stealth layer is designed to run in a real Chrome main-world,
 * but we can assert its core behaviour in Node by constructing a
 * reasonable `window`/`navigator`/`Navigator.prototype` stub, loading
 * the IIFE with `vm.runInContext`, and then inspecting the resulting
 * globals.
 *
 * What we verify here:
 *   1. The script installs `window.__opensin_stealth__` with a
 *      version string (not just `true`).
 *   2. `window.__opensin_stealth_status__()` returns a dictionary
 *      with the expected module names.
 *   3. Each module reports one of: "applied", "skipped", "partial",
 *      or an "error:" prefix (never raw exceptions bubbling up).
 *   4. `navigator.webdriver` is undefined after load.
 *   5. `window.__opensin_ping__()` returns `{ alive: true }`.
 *   6. Running the script twice on the same context is a no-op
 *      (idempotency).
 *   7. `Function.prototype.toString` on one of our hooked functions
 *      still includes `[native code]`.
 *
 * This test is a SMOKE test -- it does not replace manual sannysoft
 * or CreepJS verification in a real browser. See
 * scripts/benchmark-stealth.md for the end-to-end verification
 * procedure we run before every release.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STEALTH_PATH = resolve(__dirname, '..', '..', 'extension', 'src', 'content', 'stealth-main.js');
const STEALTH_SRC = readFileSync(STEALTH_PATH, 'utf8');

function makeBrowserLikeContext() {
  // Prototype that mimics a tiny subset of what the script touches.
  // Every property is `configurable: true` so the shims can replace
  // them.
  class FakeNavigator {}
  Object.defineProperty(FakeNavigator.prototype, 'webdriver', {
    get() { return true; },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(FakeNavigator.prototype, 'languages', {
    get() { return []; },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(FakeNavigator.prototype, 'plugins', {
    get() { return { length: 0 }; },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(FakeNavigator.prototype, 'mimeTypes', {
    get() { return { length: 0 }; },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(FakeNavigator.prototype, 'hardwareConcurrency', {
    get() { return 0; },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(FakeNavigator.prototype, 'userAgent', {
    get() { return 'Mozilla/5.0 HeadlessChrome/120.0 Safari/537.36'; },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(FakeNavigator.prototype, 'permissions', {
    value: { query: function () { return Promise.resolve({ state: 'default' }); } },
    configurable: true,
    writable: true,
  });

  const navigator = new FakeNavigator();

  // Plugin-array constructors -- empty stubs are enough.
  function PluginArray() {}
  function MimeTypeArray() {}
  function Plugin() {}
  function MimeType() {}
  function HTMLCanvasElement() {}
  function CanvasRenderingContext2D() {}
  function AudioBuffer() {}
  function HTMLIFrameElement() {}
  function WebGLRenderingContext() {}
  WebGLRenderingContext.prototype.getParameter = function (p) { return 'real-' + p; };
  function WebGL2RenderingContext() {}
  WebGL2RenderingContext.prototype.getParameter = function (p) { return 'real-' + p; };

  HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };
  HTMLCanvasElement.prototype.getContext = function () { return null; };
  CanvasRenderingContext2D.prototype.getImageData = function () {
    return { data: new Uint8ClampedArray(16) };
  };
  AudioBuffer.prototype.getChannelData = function () {
    return new Float32Array(16);
  };

  // Iframe desc with a configurable getter so the script can replace it.
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get() { return null; },
    configurable: true,
  });

  const win = {
    Navigator: FakeNavigator,
    navigator,
    PluginArray,
    MimeTypeArray,
    Plugin,
    MimeType,
    HTMLCanvasElement,
    CanvasRenderingContext2D,
    AudioBuffer,
    HTMLIFrameElement,
    WebGLRenderingContext,
    WebGL2RenderingContext,
    outerWidth: 0,
    outerHeight: 0,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: () => {},
    chrome: null, // force chromeRuntime module to run
  };
  win.window = win; // self-referential, like a real browser

  const ctx = createContext(win);
  return ctx;
}

test('stealth v2 installs version string, not true', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  assert.equal(ctx.__opensin_stealth__, '2.0.0');
});

test('status dictionary has every expected module', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const status = ctx.__opensin_stealth_status__();
  const required = [
    'webdriver', 'plugins', 'mimeTypes', 'languages', 'hardware',
    'chromeRuntime', 'webgl', 'canvas', 'audio', 'permissions',
    'iframeContentWindow', 'outerDimensions', 'mediaDevices',
    'battery', 'connection', 'userAgent', 'functionToString',
  ];
  for (const name of required) {
    assert.ok(name in status, `missing module "${name}" in status`);
    const val = status[name];
    assert.ok(
      val === 'applied' || val === 'skipped' || val === 'partial' || String(val).startsWith('error:'),
      `invalid status for "${name}": ${val}`,
    );
  }
});

test('no module reports an error status in the smoke harness', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const status = ctx.__opensin_stealth_status__();
  const errs = Object.entries(status)
    .filter(([, v]) => typeof v === 'string' && v.startsWith('error:'));
  assert.deepEqual(errs, [], 'Modules threw unexpectedly: ' + JSON.stringify(errs));
});

test('navigator.webdriver is undefined after load', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const val = runInContext('navigator.webdriver', ctx);
  assert.equal(val, undefined);
});

test('ping() returns alive:true plus version', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const p = ctx.__opensin_ping__();
  assert.equal(p.alive, true);
  assert.equal(p.v, '2.0.0');
  assert.equal(typeof p.ts, 'number');
});

test('loading twice is idempotent (status unchanged)', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const first = JSON.stringify(ctx.__opensin_stealth_status__());
  runInContext(STEALTH_SRC, ctx);
  const second = JSON.stringify(ctx.__opensin_stealth_status__());
  assert.equal(first, second);
  assert.equal(ctx.__opensin_stealth__, '2.0.0');
});

test('Function.prototype.toString preserves [native code] for hooked fns', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  // The webdriver getter is hooked and marked native. It must toString
  // with "[native code]" inside.
  const str = runInContext(
    'Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get.toString()',
    ctx,
  );
  assert.ok(
    String(str).includes('[native code]'),
    `webdriver getter toString() did not look native: ${str}`,
  );
});

test('languages module replaces empty array with non-empty list', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const langs = runInContext('navigator.languages', ctx);
  assert.ok(Array.isArray(langs));
  assert.ok(langs.length > 0);
});

test('hardwareConcurrency reports >0 after load', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const n = runInContext('navigator.hardwareConcurrency', ctx);
  assert.ok(n > 0, `expected >0 cores, got ${n}`);
});

test('userAgent has HeadlessChrome token stripped', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const ua = runInContext('navigator.userAgent', ctx);
  assert.ok(!String(ua).includes('HeadlessChrome'), `UA still leaks headless: ${ua}`);
});

test('window.chrome.runtime is populated when it was missing', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const rt = runInContext('window.chrome && window.chrome.runtime', ctx);
  assert.ok(rt && typeof rt === 'object');
  assert.ok(rt.OnInstalledReason && rt.PlatformOs);
});

test('webgl getParameter returns spoofed vendor/renderer', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const vendor = runInContext('WebGLRenderingContext.prototype.getParameter.call({}, 0x9245)', ctx);
  const renderer = runInContext('WebGLRenderingContext.prototype.getParameter.call({}, 0x9246)', ctx);
  assert.equal(vendor, 'Intel Inc.');
  assert.equal(renderer, 'Intel Iris OpenGL Engine');
});

test('outerWidth/outerHeight mirror inner when both were 0', () => {
  const ctx = makeBrowserLikeContext();
  runInContext(STEALTH_SRC, ctx);
  const ow = runInContext('outerWidth', ctx);
  const oh = runInContext('outerHeight', ctx);
  assert.equal(ow, 1280);
  assert.equal(oh, 720 + 85);
});
