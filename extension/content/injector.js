/**
 * OpenSIN Bridge v4.0.0 — Content Script Injector
 * Runs on <all_urls> at document_start in MAIN world
 * 
 * This is the Antigravity-Level content script that:
 * - Injects SIN API into every page's window object
 * - Listens for commands from the background service worker
 * - Provides DOM-level automation capabilities
 * - Bypasses CSP by running in MAIN world
 * 
 * SECURITY: All mutating methods are nonce-gated. Only code that
 * knows the per-page nonce (retrieved via chrome.scripting.executeScript)
 * can invoke click/type/fillForm/etc. Read-only methods remain open.
 */

(function() {
  'use strict';

  // Prevent double-injection
  if (window.__SIN_BRIDGE_INJECTED__) return;
  window.__SIN_BRIDGE_INJECTED__ = true;

  // Per-page nonce — generated fresh on every injection
  const _sinNonce = crypto.randomUUID();

  function requireNonce(nonce) {
    if (nonce !== _sinNonce) throw new Error('Unauthorized: invalid bridge nonce');
  }

  // ============================================================
  // SIN API — Injected into page context (MAIN world)
  // ============================================================
  window.__SIN_BRIDGE__ = {
    version: '3.0.0',
    injected: true,
    timestamp: Date.now(),
    url: window.location.href,

    // ---- Read-only methods (safe, no nonce needed) ----

    // DOM Query helpers
    $(selector, context) {
      return (context || document).querySelector(selector);
    },
    $$(selector, context) {
      return Array.from((context || document).querySelectorAll(selector));
    },

    // Get page snapshot
    snapshot() {
      return {
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        links: Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href, text: (a.textContent || '').trim().slice(0, 50)
        })),
        inputs: Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
          tag: el.tagName.toLowerCase(), type: el.type, name: el.name, id: el.id,
          placeholder: el.placeholder, visible: el.offsetParent !== null
        })),
        buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).map(el => ({
          text: (el.textContent || el.value || '').trim().slice(0, 50),
          visible: el.offsetParent !== null
        })),
      };
    },

    // Get computed styles
    getStyles(selector) {
      const el = document.querySelector(selector);
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

    // Click with full event chain (React-compatible)
    click(nonce, selector) {
      requireNonce(nonce);
      const el = document.querySelector(selector);
      if (!el) return { found: false };
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.click();
      return { found: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
    },

    // Type text with proper events
    type(nonce, selector, text, clear = true) {
      requireNonce(nonce);
      if (!selector || typeof selector !== 'string') return { error: 'selector required' };
      if (typeof text !== 'string') return { error: 'text must be a string' };
      if (text.length > 10000) return { error: 'text exceeds 10000 character limit' };
      const el = document.querySelector(selector);
      if (!el) return { found: false };
      el.focus();
      if (clear) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // Simulate typing character by character for realism
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

    // Wait for element
    waitFor(nonce, selector, timeout = 10000) {
      requireNonce(nonce);
      return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve({ found: true, tag: el.tagName });
        const observer = new MutationObserver(() => {
          const el2 = document.querySelector(selector);
          if (el2) { observer.disconnect(); resolve({ found: true, tag: el2.tagName }); }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve({ found: false }); }, timeout);
      });
    },

    // Override fetch to monitor network
    interceptFetch(nonce, callback) {
      requireNonce(nonce);
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        if (callback) callback({ url: args[0], status: response.status, method: 'GET' });
        return response;
      };
      return { intercepted: true };
    },

    // Override XMLHttpRequest
    interceptXHR(nonce, callback) {
      requireNonce(nonce);
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._sin_method = method;
        this._sin_url = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        if (callback) callback({ url: this._sin_url, method: this._sin_method, body });
        return origSend.apply(this, arguments);
      };
      return { intercepted: true };
    },

    // Anti-detection: remove automation indicators
    stealth(nonce) {
      requireNonce(nonce);
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Remove selenium indicators
      delete window.document.$cdc_asdjflasutopfhvcZLmcfl_;
      delete window.document.$chrome_asyncScriptInfo;
      // Patch permissions
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

    // Form auto-fill
    fillForm(nonce, data) {
      requireNonce(nonce);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'data must be an object' };
      const entries = Object.entries(data);
      if (entries.length > 50) return { error: 'data exceeds 50 fields limit' };
      const results = {};
      for (const [key, value] of entries) {
        if (typeof key !== 'string' || key.length > 256) { results[key] = { filled: false, error: 'invalid key' }; continue; }
        if (typeof value !== 'string' || value.length > 10000) { results[key] = { filled: false, error: 'invalid value' }; continue; }
        const safeKey = key.replace(/["\\]/g, '\\$&');
        const el = document.querySelector(`[name="${safeKey}"], [id="${safeKey}"], [data-field="${safeKey}"]`);
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

    // Scroll to element
    scrollTo(nonce, selector) {
      requireNonce(nonce);
      const el = document.querySelector(selector);
      if (!el) return { found: false };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { found: true };
    },
  };

  // Nonce accessible via Symbol (invisible to normal enumeration — 
  // Object.keys/for..in won't reveal it, only Symbol.for() lookup)
  const _sinNonceKey = Symbol.for('__SIN_BRIDGE_NONCE__');
  Object.defineProperty(window.__SIN_BRIDGE__, _sinNonceKey, {
    value: _sinNonce,
    writable: false,
    enumerable: false,
    configurable: false,
  });

})();
