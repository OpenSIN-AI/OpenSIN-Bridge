/**
 * ==============================================================================
 * OpenSIN Component: injector.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * MAIN-world content script that exposes the OpenSIN bridge API and now also
 * captures a low-level behavior timeline for future replay / automation mining.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * The service worker already knows how to observe pages, record video, and log
 * requests, but only the page context can see the exact DOM element a user just
 * clicked, typed into, or submitted. This script therefore emits compact,
 * privacy-aware behavior events from the DOM side.
 *
 * PERFORMANCE / WARUM SO GEBAUT:
 * - Clicks are throttled so one physical interaction does not fan out into
 *   duplicate synthetic click handlers.
 * - Inputs are debounced so fast typing produces one bounded event instead of a
 *   write for every keystroke.
 * - Navigation markers are deduplicated in short windows to avoid noisy bursts
 *   from history APIs and browser lifecycle events.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If this file breaks, OpenSIN can still query the page, but it loses the core
 * user-behavior capture signals needed for timeline learning and replay.
 * ==============================================================================
 */

(function() {
  'use strict';

  if (window.__SIN_BRIDGE_INJECTED__) return;
  window.__SIN_BRIDGE_INJECTED__ = true;

  const _sinNonce = crypto.randomUUID();
  const BRIDGE_VERSION = typeof chrome !== 'undefined' && chrome.runtime?.getManifest
    ? chrome.runtime.getManifest().version
    : '4.0.0';

  const CAPTURE_CONFIG = {
    clickThrottleMs: 250,
    inputDebounceMs: 400,
    navigationThrottleMs: 250,
    textLimit: 120,
    selectorTrailLimit: 4,
  };

  const captureState = {
    clicks: new Map(),
    inputs: new Map(),
    navigations: new Map(),
  };

  function requireNonce(nonce) {
    if (nonce !== _sinNonce) throw new Error('Unauthorized: invalid bridge nonce');
  }

  function truncateText(value, limit = CAPTURE_CONFIG.textLimit) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function normalizeContext(context) {
    return context && typeof context.querySelectorAll === 'function' ? context : document;
  }

  function safeSendRuntimeMessage(message) {
    try {
      if (!chrome?.runtime?.sendMessage) return false;
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function isVisible(element) {
    if (!element) return false;
    if (element.offsetParent !== null) return true;
    try {
      return typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
    } catch (_error) {
      return false;
    }
  }

  function buildElementLabel(element) {
    if (!element || !element.tagName) return 'unknown';
    const tag = String(element.tagName).toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const name = element.name ? `[name="${truncateText(element.name, 40)}"]` : '';
    const type = element.type ? `[type="${truncateText(element.type, 24)}"]` : '';
    return `${tag}${id}${name}${type}`;
  }

  function buildSelectorTrail(element) {
    const parts = [];
    let current = element;
    while (current && current.tagName && parts.length < CAPTURE_CONFIG.selectorTrailLimit) {
      parts.unshift(buildElementLabel(current));
      current = current.parentElement || null;
    }
    return parts.join(' > ');
  }

  function buildElementPayload(element) {
    const text = truncateText(element?.innerText || element?.textContent || element?.value || '');
    return {
      tag: element?.tagName ? String(element.tagName).toLowerCase() : 'unknown',
      id: element?.id || '',
      name: element?.name || '',
      inputType: element?.type || '',
      text,
      selectorTrail: buildSelectorTrail(element),
      visible: isVisible(element),
      href: element?.href || '',
      action: element?.action || element?.formAction || '',
    };
  }

  function buildTargetKey(element) {
    return [
      buildElementLabel(element),
      truncateText(element?.placeholder || '', 40),
      truncateText(element?.ariaLabel || '', 40),
      buildSelectorTrail(element),
    ].join('::');
  }

  function emitBehaviorEvent(payload) {
    return safeSendRuntimeMessage({
      _sinBridgeType: 'BEHAVIOR_EVENT',
      payload: {
        ...payload,
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
      },
    });
  }

  function shouldThrottle(map, key, windowMs) {
    const now = Date.now();
    const lastSeenAt = map.get(key) || 0;
    if (now - lastSeenAt < windowMs) return true;
    map.set(key, now);
    return false;
  }

  function handleClick(event) {
    const target = event?.target?.closest ? event.target.closest('button, a[href], input, textarea, select, [role="button"], label') : event?.target;
    if (!target) return false;

    const key = buildTargetKey(target);
    if (shouldThrottle(captureState.clicks, key, CAPTURE_CONFIG.clickThrottleMs)) {
      return false;
    }

    return emitBehaviorEvent({
      type: 'CLICK',
      trusted: event?.isTrusted !== false,
      target: buildElementPayload(target),
    });
  }

  function flushInputEvent(key) {
    const pending = captureState.inputs.get(key);
    if (!pending) return false;

    captureState.inputs.delete(key);
    const { element, trusted, eventType } = pending;

    return emitBehaviorEvent({
      type: 'INPUT',
      trusted,
      eventType,
      target: buildElementPayload(element),
      name: element?.name || '',
      inputType: element?.type || '',
      value: truncateText(element?.value || ''),
    });
  }

  function handleInput(event) {
    const target = event?.target;
    if (!target || !target.tagName) return false;

    const tagName = String(target.tagName).toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tagName)) return false;

    const key = buildTargetKey(target);
    const previous = captureState.inputs.get(key);
    if (previous?.timer) clearTimeout(previous.timer);

    const timer = setTimeout(() => {
      flushInputEvent(key);
    }, CAPTURE_CONFIG.inputDebounceMs);

    captureState.inputs.set(key, {
      element: target,
      trusted: event?.isTrusted !== false,
      eventType: event?.type || 'input',
      timer,
    });

    return true;
  }

  function flushPendingInputs() {
    for (const key of Array.from(captureState.inputs.keys())) {
      const pending = captureState.inputs.get(key);
      if (pending?.timer) clearTimeout(pending.timer);
      flushInputEvent(key);
    }
  }

  function handleSubmit(event) {
    const form = event?.target?.tagName && String(event.target.tagName).toLowerCase() === 'form'
      ? event.target
      : event?.target?.closest
        ? event.target.closest('form')
        : null;

    if (!form) return false;

    flushPendingInputs();

    return emitBehaviorEvent({
      type: 'FORM_SUBMIT',
      trusted: event?.isTrusted !== false,
      target: buildElementPayload(form),
      formAction: form.action || '',
      method: (form.method || 'get').toLowerCase(),
    });
  }

  function recordNavigationMarker(marker, extra = {}) {
    const key = `${marker}:${window.location.href}`;
    if (shouldThrottle(captureState.navigations, key, CAPTURE_CONFIG.navigationThrottleMs)) {
      return false;
    }

    flushPendingInputs();

    return emitBehaviorEvent({
      type: 'NAVIGATION',
      marker,
      ...extra,
    });
  }

  function installBehaviorCaptureHooks() {
    document.addEventListener('click', handleClick, { capture: true, passive: true });
    document.addEventListener('input', handleInput, { capture: true, passive: true });
    document.addEventListener('change', handleInput, { capture: true, passive: true });
    document.addEventListener('submit', handleSubmit, { capture: true, passive: true });

    const originalPushState = window.history?.pushState?.bind(window.history);
    if (originalPushState) {
      window.history.pushState = function(...args) {
        const result = originalPushState(...args);
        recordNavigationMarker('history-push-state');
        return result;
      };
    }

    const originalReplaceState = window.history?.replaceState?.bind(window.history);
    if (originalReplaceState) {
      window.history.replaceState = function(...args) {
        const result = originalReplaceState(...args);
        recordNavigationMarker('history-replace-state');
        return result;
      };
    }

    window.addEventListener('hashchange', () => recordNavigationMarker('hashchange'), { passive: true });
    window.addEventListener('popstate', () => recordNavigationMarker('popstate'), { passive: true });
    window.addEventListener('beforeunload', () => recordNavigationMarker('beforeunload'), { passive: true });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => recordNavigationMarker('dom-content-loaded'), { once: true, passive: true });
    } else {
      recordNavigationMarker('document-ready');
    }

    window.addEventListener('load', () => recordNavigationMarker('window-load'), { once: true, passive: true });
    recordNavigationMarker('initial-document');
  }

  window.__SIN_BRIDGE__ = {
    version: BRIDGE_VERSION,
    injected: true,
    timestamp: Date.now(),
    url: window.location.href,

    $(selector, context) {
      return normalizeContext(context).querySelector(selector);
    },

    $$(selector, context) {
      return Array.from(normalizeContext(context).querySelectorAll(selector));
    },

    snapshot() {
      return {
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        links: Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
          href: anchor.href,
          text: truncateText(anchor.textContent, 50),
        })),
        inputs: Array.from(document.querySelectorAll('input, textarea, select')).map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.type,
          name: element.name,
          id: element.id,
          placeholder: element.placeholder,
          visible: isVisible(element),
        })),
        buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).map((element) => ({
          text: truncateText(element.textContent || element.value, 50),
          visible: isVisible(element),
        })),
      };
    },

    getStyles(selector) {
      const element = document.querySelector(selector);
      if (!element) return { found: false };
      const style = window.getComputedStyle(element);
      return {
        found: true,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        offsetParent: element.offsetParent !== null,
        rect: element.getBoundingClientRect(),
      };
    },

    click(nonce, selector) {
      requireNonce(nonce);
      const element = document.querySelector(selector);
      if (!element) return { found: false };
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      element.click();
      return { found: true, tag: element.tagName, text: truncateText(element.textContent, 100) };
    },

    type(nonce, selector, text, clear = true) {
      requireNonce(nonce);
      if (!selector || typeof selector !== 'string') return { error: 'selector required' };
      if (typeof text !== 'string') return { error: 'text must be a string' };
      if (text.length > 10000) return { error: 'text exceeds 10000 character limit' };
      const element = document.querySelector(selector);
      if (!element) return { found: false };
      element.focus();
      if (clear) {
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      for (const char of text) {
        element.value += char;
        element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return { found: true, length: text.length };
    },

    waitFor(nonce, selector, timeout = 10000) {
      requireNonce(nonce);
      return new Promise((resolve) => {
        const existing = document.querySelector(selector);
        if (existing) return resolve({ found: true, tag: existing.tagName });
        const observer = new MutationObserver(() => {
          const discovered = document.querySelector(selector);
          if (discovered) {
            observer.disconnect();
            resolve({ found: true, tag: discovered.tagName });
          }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false });
        }, timeout);
      });
    },

    interceptFetch(nonce, callback) {
      requireNonce(nonce);
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        if (callback) callback({ url: args[0], status: response.status, method: 'GET' });
        return response;
      };
      return { intercepted: true };
    },

    interceptXHR(nonce, callback) {
      requireNonce(nonce);
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._sin_method = method;
        this._sin_url = url;
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        if (callback) callback({ url: this._sin_url, method: this._sin_method, body });
        return originalSend.apply(this, arguments);
      };
      return { intercepted: true };
    },

    stealth(nonce) {
      requireNonce(nonce);
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      delete window.document.$cdc_asdjflasutopfhvcZLmcfl_;
      delete window.document.$chrome_asyncScriptInfo;
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => {
          return parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
        };
      }
      return { stealth: true };
    },

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
        const element = document.querySelector(`[name="${safeKey}"], [id="${safeKey}"], [data-field="${safeKey}"]`);
        if (element) {
          element.focus();
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          results[key] = { filled: true };
        } else {
          results[key] = { filled: false };
        }
      }
      return results;
    },

    scrollTo(nonce, selector) {
      requireNonce(nonce);
      const element = document.querySelector(selector);
      if (!element) return { found: false };
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { found: true };
    },
  };

  const nonceKey = Symbol.for('__SIN_BRIDGE_NONCE__');
  Object.defineProperty(window.__SIN_BRIDGE__, nonceKey, {
    value: _sinNonce,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const captureTestKey = Symbol.for('__SIN_BRIDGE_CAPTURE_TEST__');
  Object.defineProperty(window.__SIN_BRIDGE__, captureTestKey, {
    value: {
      handleClick,
      handleInput,
      handleSubmit,
      recordNavigationMarker,
      flushPendingInputs,
      emitBehaviorEvent,
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });

  window._sinDeepQuery = function(selector, context) {
    return normalizeContext(context).querySelector(selector);
  };

  window._sinDeepQueryAll = function(selector, context) {
    return Array.from(normalizeContext(context).querySelectorAll(selector));
  };

  window._sinHumanClick = async function(element) {
    if (!element) return { error: 'Element not found' };
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5, isTrusted: true }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 5, clientY: 5 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    return { success: true, entropy_applied: true };
  };

  installBehaviorCaptureHooks();
})();
