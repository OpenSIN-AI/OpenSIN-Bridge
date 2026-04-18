/**
 * ==============================================================================
 * OpenSIN Component: injector.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Content script injector for OpenSIN Bridge.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Facilitates DOM interaction and data extraction.
 *
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If broken, agents lose the ability to 'see' or interact with web pages.
 *
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */

/**
 * ==============================================================================
 * OpenSIN Bridge - Core Component (V4.0.0+)
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * This file is a critical component of the OpenSIN Bridge ecosystem.
 * It enables direct, secure, and reliable communication between the Hugging Face
 * MCP Server and the user's local Chrome browser.
 *
 * ARCHITECTURE / WARUM SO GEBAUT:
 * - We DO NOT use Selenium, Puppeteer, or nodriver here.
 * - We DO NOT launch new Chrome instances with --no-sandbox.
 * - Instead, we use the Native Chrome Extension API (MV3) inside the user's
 *   DEFAULT profile to ensure all cookies, sessions, and extensions remain intact.
 *
 * RULES / REGELN FÜR DIESEN CODE:
 * 1. NO ASSUMPTIONS: Do not assume a tab or window exists. Always verify and handle missing states.
 * 2. EXTENSIVE LOGGING: Every action must be logged. Silent failures are prohibited.
 * 3. FALLBACKS: If an API fails (e.g. tabs.create without a window), fallback gracefully (e.g. create a window).
 *
 * CONSEQUENCES / KONSEQUENZEN WENN GEÄNDERT:
 * - If you break the WebSocket connection here, the entire autonomous agent fleet goes blind.
 * - If you change security policies (CSP), the extension might get banned by Chrome.
 *
 * AUTHOR: SIN-Zeus / A2A Team
 * ==============================================================================
 */

/**
 * OpenSIN Bridge v4.0.0 — Content Script Injector
 * Runs on <all_urls> at document_start in MAIN world.
 *
 * This file intentionally lives in the page's MAIN world because network payload
 * correlation only works reliably when fetch/XHR are patched before application
 * code captures the original browser primitives.
 *
 * SECURITY: All mutating bridge methods remain nonce-gated. Network interception
 * is passive/read-only and emits bounded, privacy-aware events back to the
 * extension runtime for downstream correlation and export.
 */

(function() {
  'use strict';

  // Prevent double-injection because duplicate wrappers would produce duplicate
  // network events and would also overwrite the per-page nonce contract.
  if (window.__SIN_BRIDGE_INJECTED__) return;
  window.__SIN_BRIDGE_INJECTED__ = true;

  // Per-page nonce — generated fresh on every injection so mutating bridge
  // methods cannot be invoked by guessing a stable token.
  const _sinNonce = crypto.randomUUID();

  // Hard bounds keep payload previews deterministic and stop the bridge from
  // copying arbitrarily large request/response bodies into extension memory.
  const MAX_BODY_PREVIEW_LENGTH = 2048;
  const MAX_HEADER_VALUE_LENGTH = 512;

  // Manual subscribers keep the old bridge API contract alive. Existing callers
  // can still register callbacks through interceptFetch()/interceptXHR() without
  // replacing the new automatic MAIN-world capture path.
  const fetchSubscribers = [];
  const xhrSubscribers = [];

  function requireNonce(nonce) {
    if (nonce !== _sinNonce) throw new Error('Unauthorized: invalid bridge nonce');
  }

  /**
   * Clamp any value into a bounded string preview.
   *
   * The export pipeline needs representative snippets, not full binary uploads or
   * giant JSON documents. Truncation happens here so every downstream consumer
   * receives the same deterministic payload shape.
   */
  function clampPreview(value, limit = MAX_BODY_PREVIEW_LENGTH) {
    if (value == null) return '';
    return String(value).slice(0, limit);
  }

  /**
   * Normalize URLs from Request objects, URL objects, or raw strings.
   */
  function normalizeUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    if (input && typeof input.href === 'string') return input.href;
    return String(input || '');
  }

  /**
   * Convert headers-like inputs into a plain JSON-safe object.
   */
  function normalizeHeaders(headers) {
    if (!headers) return {};

    if (typeof headers.entries === 'function') {
      return Object.fromEntries(
        Array.from(headers.entries()).map(([key, value]) => [key, clampPreview(value, MAX_HEADER_VALUE_LENGTH)])
      );
    }

    if (Array.isArray(headers)) {
      return Object.fromEntries(
        headers.map(([key, value]) => [String(key), clampPreview(value, MAX_HEADER_VALUE_LENGTH)])
      );
    }

    if (typeof headers === 'object') {
      return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, clampPreview(value, MAX_HEADER_VALUE_LENGTH)])
      );
    }

    return {};
  }

  /**
   * Classify request/response bodies into a coarse, privacy-aware bucket.
   *
   * Downstream tooling only needs enough information to correlate intent. It does
   * not need raw binary blobs or browser-specific body classes.
   */
  function classifyBody(value) {
    if (value == null) return { bodyKind: null, bodyLength: 0, bodyPreview: '' };

    if (typeof value === 'string') {
      return { bodyKind: 'text', bodyLength: value.length, bodyPreview: clampPreview(value) };
    }

    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
      const serialized = value.toString();
      return { bodyKind: 'urlencoded', bodyLength: serialized.length, bodyPreview: clampPreview(serialized) };
    }

    if (typeof FormData !== 'undefined' && value instanceof FormData) {
      const entries = [];
      for (const [key, entryValue] of value.entries()) {
        entries.push([key, typeof entryValue === 'string' ? clampPreview(entryValue, 128) : '[binary]']);
      }
      const serialized = JSON.stringify(entries);
      return { bodyKind: 'form-data', bodyLength: serialized.length, bodyPreview: clampPreview(serialized) };
    }

    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return { bodyKind: 'blob', bodyLength: value.size || 0, bodyPreview: `[blob:${value.type || 'application/octet-stream'}]` };
    }

    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      return { bodyKind: 'array-buffer', bodyLength: value.byteLength || 0, bodyPreview: '[array-buffer]' };
    }

    if (typeof value === 'object') {
      const serialized = JSON.stringify(value);
      return { bodyKind: 'json', bodyLength: serialized.length, bodyPreview: clampPreview(serialized) };
    }

    return { bodyKind: typeof value, bodyLength: String(value).length, bodyPreview: clampPreview(value) };
  }

  /**
   * Read a Request body without consuming the live request instance.
   *
   * Browsers allow Request.clone() for this exact use-case. If cloning or text()
   * fails we return an explicit placeholder instead of guessing at hidden bytes.
   */
  async function readRequestBodyPreview(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      return classifyBody(init.body);
    }

    if (input && typeof input.clone === 'function') {
      try {
        const clone = input.clone();
        if (typeof clone.text === 'function') {
          const text = await clone.text();
          return classifyBody(text);
        }
      } catch (_error) {
        return { bodyKind: 'unavailable', bodyLength: null, bodyPreview: '[request-body-unavailable]' };
      }
    }

    return { bodyKind: null, bodyLength: 0, bodyPreview: '' };
  }

  /**
   * Read a Response body preview without preventing application code from using it.
   */
  async function readResponseBodyPreview(response) {
    if (!response || typeof response.clone !== 'function') {
      return { bodyKind: null, bodyLength: 0, bodyPreview: '' };
    }

    try {
      const clone = response.clone();
      if (typeof clone.text !== 'function') {
        return { bodyKind: null, bodyLength: 0, bodyPreview: '' };
      }
      const text = await clone.text();
      return classifyBody(text);
    } catch (_error) {
      return { bodyKind: 'unavailable', bodyLength: null, bodyPreview: '[response-body-unavailable]' };
    }
  }

  /**
   * Emit a MAIN-world network event to the service worker.
   *
   * The message structure intentionally mirrors the service worker validator so a
   * hostile page cannot smuggle arbitrary message types through this channel.
   */
  function postNetworkEvent(payload) {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      return;
    }

    try {
      chrome.runtime.sendMessage({
        _sinBridgeType: 'NETWORK_EVENT',
        payload,
      });
    } catch (_error) {
      // MAIN-world capture must never break page execution because messaging is a
      // side-channel for correlation, not part of the page's functional path.
    }
  }

  /**
   * Notify legacy manual subscribers without coupling them to the runtime bridge.
   */
  function notifySubscribers(subscribers, event) {
    for (const callback of subscribers) {
      try {
        callback(event);
      } catch (_error) {
        // Subscriber failures are isolated so one observer cannot break another.
      }
    }
  }

  /**
   * Generate a stable request identifier that survives request/response pairing.
   */
  function createRequestId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  /**
   * Fetch interception must be installed in MAIN world at document_start so page
   * code cannot capture the original fetch reference before we wrap it.
   */
  function installFetchInterceptor() {
    const fetchTarget = typeof window.fetch === 'function' ? window.fetch : globalThis.fetch;
    if (fetchTarget && fetchTarget.__opensinNetworkWrapped__) return;
    const originalFetch = fetchTarget;
    if (typeof originalFetch !== 'function') return;

    const wrappedFetch = async function(input, init) {
      const startedAt = Date.now();
      const requestId = createRequestId('fetch');
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const url = normalizeUrl(input);
      const requestBody = await readRequestBodyPreview(input, init);
      const requestHeaders = normalizeHeaders((init && init.headers) || (input && input.headers) || null);

      const requestEvent = {
        api: 'fetch',
        phase: 'request',
        requestId,
        method,
        url,
        timestamp: startedAt,
        frameUrl: window.location.href,
        request: {
          ...requestBody,
          headers: requestHeaders,
        },
      };

      postNetworkEvent(requestEvent);
      notifySubscribers(fetchSubscribers, requestEvent);

      try {
        const response = await originalFetch.apply(this, arguments);
        const responseBody = await readResponseBodyPreview(response);
        const responseEvent = {
          api: 'fetch',
          phase: 'response',
          requestId,
          method,
          url,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          frameUrl: window.location.href,
          request: {
            ...requestBody,
            headers: requestHeaders,
          },
          response: {
            status: typeof response.status === 'number' ? response.status : null,
            ok: typeof response.ok === 'boolean' ? response.ok : null,
            statusText: response.statusText || null,
            headers: normalizeHeaders(response.headers),
            ...responseBody,
          },
        };

        postNetworkEvent(responseEvent);
        notifySubscribers(fetchSubscribers, responseEvent);
        return response;
      } catch (error) {
        const errorEvent = {
          api: 'fetch',
          phase: 'error',
          requestId,
          method,
          url,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          frameUrl: window.location.href,
          request: {
            ...requestBody,
            headers: requestHeaders,
          },
          error: {
            message: error && error.message ? error.message : 'Fetch failed',
            name: error && error.name ? error.name : 'Error',
          },
        };

        postNetworkEvent(errorEvent);
        notifySubscribers(fetchSubscribers, errorEvent);
        throw error;
      }
    };

    wrappedFetch.__opensinNetworkWrapped__ = true;
    wrappedFetch.__opensinOriginalFetch__ = originalFetch;
    window.fetch = wrappedFetch;
    globalThis.fetch = wrappedFetch;
  }

  /**
   * XHR interception complements fetch interception because many legacy sites still
   * use XMLHttpRequest directly, especially inside older frameworks.
   */
  function installXhrInterceptor() {
    const xhrConstructor = window.XMLHttpRequest || globalThis.XMLHttpRequest;
    if (!xhrConstructor || xhrConstructor.prototype.__opensinNetworkWrapped__) return;

    const xhrProto = xhrConstructor.prototype;
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    const originalSetRequestHeader = xhrProto.setRequestHeader;

    xhrProto.open = function(method, url) {
      this.__opensinRequestMethod = String(method || 'GET').toUpperCase();
      this.__opensinRequestUrl = normalizeUrl(url);
      this.__opensinRequestHeaders = {};
      this.__opensinRequestId = createRequestId('xhr');
      return originalOpen.apply(this, arguments);
    };

    if (typeof originalSetRequestHeader === 'function') {
      xhrProto.setRequestHeader = function(name, value) {
        this.__opensinRequestHeaders = this.__opensinRequestHeaders || {};
        this.__opensinRequestHeaders[name] = value;
        return originalSetRequestHeader.apply(this, arguments);
      };
    }

    xhrProto.send = function(body) {
      const xhr = this;
      const startedAt = Date.now();
      const requestBody = classifyBody(body);
      const method = xhr.__opensinRequestMethod || 'GET';
      const url = xhr.__opensinRequestUrl || '';
      const requestId = xhr.__opensinRequestId || createRequestId('xhr');

      const requestEvent = {
        api: 'xhr',
        phase: 'request',
        requestId,
        method,
        url,
        timestamp: startedAt,
        frameUrl: window.location.href,
        request: {
          ...requestBody,
          headers: normalizeHeaders(xhr.__opensinRequestHeaders),
        },
      };

      postNetworkEvent(requestEvent);
      notifySubscribers(xhrSubscribers, requestEvent);

      function emitTerminalEvent(phase, extra = {}) {
        const event = {
          api: 'xhr',
          phase,
          requestId,
          method,
          url,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          frameUrl: window.location.href,
          request: {
            ...requestBody,
            headers: normalizeHeaders(xhr.__opensinRequestHeaders),
          },
          ...extra,
        };

        postNetworkEvent(event);
        notifySubscribers(xhrSubscribers, event);
      }

      xhr.addEventListener('load', function() {
        emitTerminalEvent('response', {
          response: {
            status: typeof xhr.status === 'number' ? xhr.status : null,
            ok: typeof xhr.status === 'number' ? xhr.status >= 200 && xhr.status < 400 : null,
            statusText: xhr.statusText || null,
            headers: {},
            ...classifyBody(typeof xhr.responseText === 'string' ? xhr.responseText : ''),
          },
        });
      });

      xhr.addEventListener('error', function() {
        emitTerminalEvent('error', {
          error: {
            message: 'XMLHttpRequest failed',
            name: 'XMLHttpRequestError',
          },
        });
      });

      xhr.addEventListener('abort', function() {
        emitTerminalEvent('error', {
          error: {
            message: 'XMLHttpRequest aborted',
            name: 'XMLHttpRequestAbort',
          },
        });
      });

      xhr.addEventListener('timeout', function() {
        emitTerminalEvent('error', {
          error: {
            message: 'XMLHttpRequest timed out',
            name: 'XMLHttpRequestTimeout',
          },
        });
      });

      return originalSend.apply(this, arguments);
    };

    xhrProto.__opensinNetworkWrapped__ = true;
    window.XMLHttpRequest = xhrConstructor;
    globalThis.XMLHttpRequest = xhrConstructor;
  }

  // Install passive network capture immediately so application code on the page
  // is observed from the earliest safe moment after document_start injection.
  installFetchInterceptor();
  installXhrInterceptor();

  // ============================================================
  // SIN API — Injected into page context (MAIN world)
  // ============================================================
  const BRIDGE_VERSION = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
    ? chrome.runtime.getManifest().version
    : '4.0.0';

  window.__SIN_BRIDGE__ = {
    version: '4.0.0',
    injected: true,
    timestamp: Date.now(),
    url: window.location.href,

    // ---- Read-only methods (safe, no nonce needed) ----

    // DOM Query helpers intentionally remain simple here. The feature task in
    // this branch is about network correlation rather than discovery semantics.
    $(selector, context) {
      return deepQuery(selector, context);
    },
    $$(selector, context) {
      return deepQueryAll(selector, context);
    },

    // Get page snapshot for lightweight correlation with network activity.
    snapshot() {
      return {
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        links: Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: (a.textContent || '').trim().slice(0, 50),
        })),
        inputs: Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type,
          name: el.name,
          id: el.id,
          placeholder: el.placeholder,
          visible: el.offsetParent !== null,
        })),
        buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).map(el => ({
          text: (el.textContent || el.value || '').trim().slice(0, 50),
          visible: el.offsetParent !== null,
        })),
      };
    },

    // Get computed styles for verification-oriented tooling.
    getStyles(selector) {
      const el = deepQuery(selector);
      if (!el) return { found: false };
      const style = window.getComputedStyle(el);
      return {
        found: true,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        offsetParent: el.offsetParent !== null,
        rect: el.getBoundingClientRect(),
      };
    },

    // ---- Mutating methods (nonce required) ----

    // Click with full event chain so React/Vue handlers see the same sequence as
    // a real user interaction.
    click(nonce, selector) {
      requireNonce(nonce);
      const el = deepQuery(selector);
      if (!el) return { found: false };
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.click();
      return { found: true, tag: el.tagName, text: truncateText(el.textContent, 100) };
    },

    // Type text with proper events so framework-controlled inputs stay in sync.
    type(nonce, selector, text, clear = true) {
      requireNonce(nonce);
      if (!selector || typeof selector !== 'string') return { error: 'selector required' };
      if (typeof text !== 'string') return { error: 'text must be a string' };
      if (text.length > 10000) return { error: 'text exceeds 10000 character limit' };
      const el = deepQuery(selector);
      if (!el) return { found: false };
      el.focus();
      if (clear) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      for (const char of text) {
        el.value += char;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return { found: true, length: text.length };
    },

    // Wait for element via MutationObserver because the DOM may change after the
    // initial document_start injection has already completed.
    waitFor(nonce, selector, timeout = 10000) {
      requireNonce(nonce);
      return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve({ found: true, tag: el.tagName });
        const observer = new MutationObserver(() => {
          const next = document.querySelector(selector);
          if (next) {
            observer.disconnect();
            resolve({ found: true, tag: next.tagName });
          }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false });
        }, timeout);
      });
    },

    // Legacy bridge API: register an observer for fetch events without replacing
    // the automatic MAIN-world wrapper introduced for network correlation.
    interceptFetch(nonce, callback) {
      requireNonce(nonce);
      if (typeof callback === 'function') {
        fetchSubscribers.push(callback);
      }
      return { intercepted: true, mode: 'subscriber', subscribers: fetchSubscribers.length };
    },

    // Legacy bridge API: register an observer for XHR events without removing the
    // passive capture wrapper that is already installed at document_start.
    interceptXHR(nonce, callback) {
      requireNonce(nonce);
      if (typeof callback === 'function') {
        xhrSubscribers.push(callback);
      }
      return { intercepted: true, mode: 'subscriber', subscribers: xhrSubscribers.length };
    },

    // Anti-detection helper kept intact because many existing workflows expect it.
    stealth(nonce) {
      requireNonce(nonce);
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      delete window.document.$cdc_asdjflasutopfhvcZLmcfl_;
      delete window.document.$chrome_asyncScriptInfo;
      const origQuery = window.navigator.permissions?.query;
      if (origQuery) {
        window.navigator.permissions.query = (parameters) => {
          return parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(parameters);
        };
      }
      return { stealth: true };
    },

    // Form auto-fill stays nonce-gated because it mutates page state.
    fillForm(nonce, data) {
      requireNonce(nonce);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'data must be an object' };
      const entries = Object.entries(data);
      if (entries.length > 50) return { error: 'data exceeds 50 fields limit' };
      const results = {};
      for (const [key, value] of entries) {
        if (typeof key !== 'string' || key.length > 256) {
          results[key] = { filled: false, error: 'invalid key' };
          continue;
        }
        if (typeof value !== 'string' || value.length > 10000) {
          results[key] = { filled: false, error: 'invalid value' };
          continue;
        }
        const safeKey = key.replace(/["\\]/g, '\\$&');
        const el = deepQuery(`[name="${safeKey}"], [id="${safeKey}"], [data-field="${safeKey}"]`);
        if (el) {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results[key] = { filled: true };
        } else {
          results[key] = { filled: false };
        }
      }
      return results;
    },

    // Scroll helper remains intentionally minimal because scrolling itself is not
    // the feature under change in this branch.
    scrollTo(nonce, selector) {
      requireNonce(nonce);
      const el = deepQuery(selector);
      if (!el) return { found: false };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { found: true };
    },
  };

  // The nonce stays hidden behind a shared symbol so privileged bridge code can
  // retrieve it while ordinary property enumeration does not expose it.
  const _sinNonceKey = Symbol.for('__SIN_BRIDGE_NONCE__');
  Object.defineProperty(window.__SIN_BRIDGE__, _sinNonceKey, {
    value: _sinNonce,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
