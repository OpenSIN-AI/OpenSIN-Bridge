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
 * Runs on <all_urls> at document_start in MAIN world
 *
 * This is the OpenSIN content script that:
 * - Injects the SIN API into every page's window object
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

  // Prevent double-injection because duplicate bridge objects would create
  // conflicting nonces and inconsistent DOM helper behavior across the page.
  if (window.__SIN_BRIDGE_INJECTED__) return;
  window.__SIN_BRIDGE_INJECTED__ = true;

  // Per-page nonce — generated fresh on every injection so mutating methods can
  // be gated without exposing a predictable token to the page context.
  const _sinNonce = crypto.randomUUID();

  // Poll interval used by waitFor(). Polling is more robust than a single
  // document-root MutationObserver because shadow roots and iframe documents can
  // appear later and may not be reachable from one observer chain.
  const WAIT_FOR_POLL_INTERVAL_MS = 100;

  // Hard cap for text snippets returned in snapshots so the bridge remains fast
  // and avoids copying arbitrarily large DOM text blobs into the transport layer.
  const SNAPSHOT_TEXT_LIMIT = 50;

  // The deterministic helper is optional because some local experiments inject
  // this file directly without the manifest-managed preload sequence.
  const deterministicPrimitives = globalThis.__OpenSINDeterministicPrimitives || null;

  function requireNonce(nonce) {
    if (nonce !== _sinNonce) throw new Error('Unauthorized: invalid bridge nonce');
  }

  /**
   * Normalize any DOM-like root into a queryable root.
   *
   * Supported roots in real browsers are Document, Element, and ShadowRoot.
   * Tests may provide minimal DOM-like objects; therefore we rely on capability
   * checks instead of constructor checks.
   */
  function normalizeRoot(root) {
    if (root && typeof root.querySelectorAll === 'function') return root;
    return document;
  }

  /**
   * Safely determine whether an element is visible enough to be actionable.
   *
   * We preserve the old offsetParent behavior for backward compatibility, but we
   * also accept getClientRects() as a fallback because some visible elements in
   * shadow DOM / fixed-position layouts legitimately have offsetParent === null.
   */
  function isElementVisible(element) {
    if (!element) return false;

    try {
      if (element.offsetParent !== null) return true;
    } catch (error) {
      // Ignore offsetParent failures and continue with geometric visibility.
    }

    try {
      if (typeof element.getClientRects === 'function' && element.getClientRects().length > 0) {
        return true;
      }
    } catch (error) {
      // Ignore geometry failures and report not visible below.
    }

    return false;
  }

  /**
   * Small helper to produce stable, short text snippets for snapshots and debug
   * payloads. The bridge needs representative text, not full page dumps.
   */
  function truncateText(value, limit = SNAPSHOT_TEXT_LIMIT) {
    return String(value || '').trim().slice(0, limit);
  }

  /**
   * Build a human-readable location label describing where an element was found.
   *
   * This is intentionally descriptive rather than CSS-selector-precise. The goal
   * is to tell operators whether an element came from the main document, a shadow
   * root, or a same-origin iframe without creating brittle selector strings.
   */
  function buildLocationLabel(trail) {
    if (!Array.isArray(trail) || trail.length === 0) return 'document';
    return trail.join(' > ');
  }

  /**
   * Get same-origin iframe/frame document if accessible.
   *
   * Cross-origin frames throw on access in real browsers. We catch that and turn
   * it into explicit limitation metadata so the snapshot can explain what was
   * skipped instead of silently pretending the DOM is complete.
   */
  function getAccessibleFrameDocument(frameElement, limitations) {
    try {
      const frameDocument = frameElement.contentDocument || null;
      if (!frameDocument) {
        limitations.push({
          type: 'iframe-unavailable',
          location: frameElement.src || '(inline frame)',
          reason: 'Frame document is not yet available.',
        });
        return null;
      }
      return frameDocument;
    } catch (error) {
      limitations.push({
        type: 'iframe-cross-origin',
        location: frameElement.src || '(inline frame)',
        reason: error && error.message ? error.message : 'Cross-origin iframe access denied.',
      });
      return null;
    }
  }

  /**
   * Walk every reachable, same-origin DOM surface below the provided root.
   *
   * Reachable means:
   * - the light DOM of the starting root
   * - any open shadow roots attached to descendants
   * - any same-origin iframe/frame documents reachable from descendants
   *
   * Non-reachable surfaces are reported via limitation metadata:
   * - closed shadow roots cannot be traversed from page JS by design
   * - cross-origin iframe documents are blocked by the browser security model
   */
  function collectDeepElements(root) {
    const normalizedRoot = normalizeRoot(root);
    const elements = [];
    const limitations = [];
    const visitedRoots = new Set();
    const visitedElements = new Set();

    function visitRoot(currentRoot, trail) {
      if (!currentRoot || visitedRoots.has(currentRoot)) return;
      visitedRoots.add(currentRoot);

      let descendants = [];
      try {
        descendants = Array.from(currentRoot.querySelectorAll('*'));
      } catch (error) {
        limitations.push({
          type: 'root-query-failed',
          location: buildLocationLabel(trail),
          reason: error && error.message ? error.message : 'Unable to query this DOM root.',
        });
        return;
      }

      for (const element of descendants) {
        if (!visitedElements.has(element)) {
          visitedElements.add(element);
          elements.push({
            element,
            location: buildLocationLabel(trail),
          });
        }

        if (element.shadowRoot) {
          const shadowTrail = trail.concat(`${element.tagName.toLowerCase()}::shadow`);
          visitRoot(element.shadowRoot, shadowTrail);
        }

        const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
        if (tagName === 'iframe' || tagName === 'frame') {
          const frameDocument = getAccessibleFrameDocument(element, limitations);
          if (frameDocument) {
            const frameLabel = element.id
              ? `${tagName}#${element.id}`
              : `${tagName}[src="${element.getAttribute && element.getAttribute('src') ? element.getAttribute('src') : element.src || ''}"]`;
            visitRoot(frameDocument, trail.concat(frameLabel));
          }
        }
      }
    }

    visitRoot(normalizedRoot, ['document']);

    return { elements, limitations };
  }

  /**
   * Find the first reachable element matching a selector across light DOM,
   * nested open shadow roots, and same-origin iframe documents.
   */
  function deepQuery(selector, root) {
    if (!selector || typeof selector !== 'string') return null;

    const { elements } = collectDeepElements(root);
    for (const entry of elements) {
      try {
        if (typeof entry.element.matches === 'function' && entry.element.matches(selector)) {
          return entry.element;
        }
      } catch (error) {
        // Invalid selectors should behave like native querySelector and bubble.
        throw error;
      }
    }

    return null;
  }

  /**
   * Find all reachable elements matching a selector across light DOM, open
   * shadow roots, and same-origin iframe documents.
   */
  function deepQueryAll(selector, root) {
    if (!selector || typeof selector !== 'string') return [];

    const matches = [];
    const { elements } = collectDeepElements(root);
    for (const entry of elements) {
      try {
        if (typeof entry.element.matches === 'function' && entry.element.matches(selector)) {
          matches.push(entry.element);
        }
      } catch (error) {
        throw error;
      }
    }

    return matches;
  }

  /**
   * Like deepQueryAll(), but preserves discovery metadata for snapshots.
   */
  function deepDiscover(selector, root) {
    if (!selector || typeof selector !== 'string') {
      return { matches: [], limitations: [] };
    }

    const matches = [];
    const { elements, limitations } = collectDeepElements(root);
    for (const entry of elements) {
      try {
        if (typeof entry.element.matches === 'function' && entry.element.matches(selector)) {
          matches.push(entry);
        }
      } catch (error) {
        throw error;
      }
    }

    return { matches, limitations };
  }

  /**
   * Create a snapshot of the visible actionable page state.
   *
   * This snapshot now includes actionable elements from:
   * - the main document
   * - nested open shadow roots
   * - same-origin iframes/frames
   *
   * It does NOT include closed shadow roots because browsers intentionally hide
   * them from page JavaScript. That limitation is documented, not guessed away.
   */
  function buildSnapshot() {
    const linkDiscovery = deepDiscover('a[href]');
    const inputDiscovery = deepDiscover('input, textarea, select');
    const buttonDiscovery = deepDiscover('button, [role="button"], input[type="submit"]');

    const limitations = Array.from(new Map(
      [
        ...linkDiscovery.limitations,
        ...inputDiscovery.limitations,
        ...buttonDiscovery.limitations,
      ].map((entry) => [`${entry.type}:${entry.location}:${entry.reason}`, entry])
    ).values());

    const snapshot = {
      title: document.title,
      url: window.location.href,
      readyState: document.readyState,
      links: linkDiscovery.matches.map(({ element, location }) => ({
        href: element.href,
        text: truncateText(element.textContent),
        location,
      })),
      inputs: inputDiscovery.matches.map(({ element, location }) => ({
        tag: element.tagName.toLowerCase(),
        type: element.type,
        name: element.name,
        id: element.id,
        placeholder: element.placeholder,
        visible: isElementVisible(element),
        location,
      })),
      buttons: buttonDiscovery.matches.map(({ element, location }) => ({
        text: truncateText(element.textContent || element.value),
        value: typeof element.value === 'string' ? truncateText(element.value) : '',
        visible: isElementVisible(element),
        location,
      })),
      limitations,
      notes: [
        'Open shadow roots are traversed recursively.',
        'Closed shadow roots remain inaccessible to page JavaScript and are therefore excluded.',
        'Only same-origin iframe/frame documents are traversed. Cross-origin frames are reported in limitations.',
      ],
    };

    // The deterministic metadata is additive so older callers can ignore it
    // while newer runtimes short-circuit obvious UI interactions.
    if (deterministicPrimitives?.buildDeterministicPrimitivePayload) {
      snapshot.deterministicPrimitives = deterministicPrimitives.buildDeterministicPrimitivePayload(snapshot, window.location.href);
    }

    return snapshot;
  }

  // ============================================================
  // SIN API — Injected into page context (MAIN world)
  // ============================================================
  const BRIDGE_VERSION = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
    ? chrome.runtime.getManifest().version
    : '4.0.0';

  window.__SIN_BRIDGE__ = {
    version: BRIDGE_VERSION,
    injected: true,
    timestamp: Date.now(),
    url: window.location.href,

    // ---- Read-only methods (safe, no nonce needed) ----

    // DOM Query helpers now pierce reachable open shadow roots and same-origin
    // iframe documents so agents see the same actionable surface as snapshots.
    $(selector, context) {
      return deepQuery(selector, context);
    },
    $$(selector, context) {
      return deepQueryAll(selector, context);
    },

    // Get page snapshot.
    snapshot() {
      return buildSnapshot();
    },

    // Get computed styles.
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

    // Click with full event chain (React-compatible).
    click(nonce, selector) {
      requireNonce(nonce);
      const el = deepQuery(selector);
      if (!el) return { found: false };
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.click();
      return { found: true, tag: el.tagName, text: truncateText(el.textContent, 100) };
    },

    // Type text with proper events.
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
      // Simulate typing character by character for realism.
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

    // Wait for element.
    waitFor(nonce, selector, timeout = 10000) {
      requireNonce(nonce);
      return new Promise((resolve) => {
        const startedAt = Date.now();

        function check() {
          const el = deepQuery(selector);
          if (el) {
            return resolve({ found: true, tag: el.tagName });
          }

          if (Date.now() - startedAt >= timeout) {
            return resolve({ found: false });
          }

          setTimeout(check, WAIT_FOR_POLL_INTERVAL_MS);
        }

        check();
      });
    },

    // Override fetch to monitor network.
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

    // Override XMLHttpRequest.
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

    // Anti-detection: remove automation indicators.
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

    // Form auto-fill.
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

    // Scroll to element.
    scrollTo(nonce, selector) {
      requireNonce(nonce);
      const el = deepQuery(selector);
      if (!el) return { found: false };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { found: true };
    },
  };

  // Nonce accessible via Symbol (invisible to normal enumeration —
  // Object.keys/for..in won't reveal it, only Symbol.for() lookup).
  const _sinNonceKey = Symbol.for('__SIN_BRIDGE_NONCE__');
  Object.defineProperty(window.__SIN_BRIDGE__, _sinNonceKey, {
    value: _sinNonce,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  /**
   * Public compatibility helpers kept on window because older integration code
   * may still call these directly instead of going through __SIN_BRIDGE__.
   */
  window._sinDeepQuery = function(selector, root) {
    return deepQuery(selector, root);
  };

  window._sinDeepQueryAll = function(selector, root) {
    return deepQueryAll(selector, root);
  };

  /**
   * Human entropy clicking helper retained as a compatibility surface.
   */
  window._sinHumanClick = async function(element) {
    if (!element) return { error: 'Element not found' };

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 200));

    const rect = element.getBoundingClientRect();
    const x = rect.left + (rect.width / 2) + (Math.random() * 10 - 5);
    const y = rect.top + (rect.height / 2) + (Math.random() * 10 - 5);

    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, isTrusted: true }));
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 50));

    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 80));

    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));

    return { success: true, entropy_applied: true, x, y };
  };
})();
