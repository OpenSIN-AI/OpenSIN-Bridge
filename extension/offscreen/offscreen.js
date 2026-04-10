/**
 * ==============================================================================
 * OpenSIN Component: offscreen.js
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * Source file for the OpenSIN ecosystem.
 * 
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Essential logic for autonomous agent cooperation.
 * 
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 * 
 * CONSEQUENCES / KONSEQUENZEN:
 * Incorrect modification may disrupt agent communication or task execution.
 * 
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */


/**
 * OpenSIN Bridge v4.0.0 — Offscreen Document Script
 * 
 * Runs in a hidden offscreen document for:
 * - Persistent background processing
 * - Network request logging and analysis
 * - DOM parsing without visible tabs
 * - Local storage operations
 * - Blob processing
 * 
 * Communicates with service_worker.js via window.postMessage
 */

(function() {
  'use strict';

  console.log('[SIN Bridge Offscreen] Initializing...');

  // ============================================================
  // STATE
  // ============================================================
  const requestLog = [];
  const MAX_LOG_SIZE = 1000;
  const eventListeners = {};

  // ============================================================
  // REQUEST LOGGING
  // ============================================================
  function addRequest(entry) {
    requestLog.push({ ...entry, loggedAt: Date.now() });
    if (requestLog.length > MAX_LOG_SIZE) {
      requestLog.splice(0, requestLog.length - MAX_LOG_SIZE);
    }
  }

  function getRequests(count = 50, filter = null) {
    let entries = requestLog.slice(-count);
    if (filter) {
      entries = entries.filter(e => {
        if (filter.type && e.type !== filter.type) return false;
        if (filter.url && !e.url?.includes(filter.url)) return false;
        if (filter.tabId && e.tabId !== filter.tabId) return false;
        return true;
      });
    }
    return entries;
  }

  function clearRequests() {
    requestLog.length = 0;
  }

  // ============================================================
  // DOM PARSER (for parsing HTML without rendering)
  // ============================================================
  function parseHTML(htmlString) {
    try {
      if (typeof htmlString !== 'string') return { error: 'html must be a string' };
      if (htmlString.length > 2 * 1024 * 1024) return { error: 'html exceeds 2MB limit' };
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      return {
        title: doc.title,
        links: Array.from(doc.querySelectorAll('a[href]')).map(a => ({
          href: a.href, text: a.textContent?.trim() || ''
        })),
        forms: Array.from(doc.querySelectorAll('form')).map(f => ({
          action: f.action, method: f.method,
          fields: Array.from(f.querySelectorAll('input, textarea, select')).map(el => ({
            name: el.name, type: el.type, id: el.id
          }))
        })),
        meta: Array.from(doc.querySelectorAll('meta')).map(m => ({
          name: m.name || m.property, content: m.content
        })),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ============================================================
  // BLOB PROCESSING
  // ============================================================
  function processBlob(dataUrl, type = 'base64') {
    try {
      const byteString = atob(dataUrl.split(',')[1]);
      const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });
      return { size: blob.size, type: mimeString };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ============================================================
  // LOCAL STORAGE MANAGER
  // ============================================================
  const storageManager = {
    _validateKey(key) {
      if (!key || typeof key !== 'string') return 'key must be a non-empty string';
      if (key.length > 256) return 'key exceeds 256 character limit';
      if (!/^[\w\-.:]+$/.test(key)) return 'key contains invalid characters';
      return null;
    },
    set(key, value) {
      const err = this._validateKey(key);
      if (err) return { error: err };
      try {
        const json = JSON.stringify(value);
        if (json.length > 512 * 1024) return { error: 'value exceeds 512KB limit' };
        localStorage.setItem(`sin_${key}`, json);
        return { success: true };
      } catch (e) {
        return { error: e.message };
      }
    },
    get(key) {
      const err = this._validateKey(key);
      if (err) return { error: err };
      try {
        const raw = localStorage.getItem(`sin_${key}`);
        return { value: raw ? JSON.parse(raw) : null };
      } catch (e) {
        return { error: e.message };
      }
    },
    delete(key) {
      const err = this._validateKey(key);
      if (err) return { error: err };
      localStorage.removeItem(`sin_${key}`);
      return { success: true };
    },
    clear() {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('sin_'));
      for (const k of keys) localStorage.removeItem(k);
      return { cleared: keys.length };
    },
    list() {
      return { keys: Object.keys(localStorage).filter(k => k.startsWith('sin_')) };
    },
  };

  // ============================================================
  // EVENT SYSTEM
  // ============================================================
  function on(event, handler) {
    if (!eventListeners[event]) eventListeners[event] = [];
    eventListeners[event].push(handler);
  }

  function emit(event, data) {
    if (eventListeners[event]) {
      eventListeners[event].forEach(h => { h(data); });
    }
  }

  // ============================================================
  // MESSAGE HANDLER (from service worker via window.postMessage)
  // ============================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const { type, payload } = event.data || {};
    if (type !== 'offscreen_request') return;

    let response;
    switch (payload?.type) {
      case 'get_requests':
        response = { requests: getRequests(payload.count, payload.filter) };
        break;
      case 'clear_requests':
        clearRequests();
        response = { cleared: true };
        break;
      case 'parse_html':
        response = { parsed: parseHTML(payload.html) };
        break;
      case 'process_blob':
        response = { blob: processBlob(payload.dataUrl, payload.type) };
        break;
      case 'storage_set':
        response = storageManager.set(payload.key, payload.value);
        break;
      case 'storage_get':
        response = storageManager.get(payload.key);
        break;
      case 'storage_delete':
        response = storageManager.delete(payload.key);
        break;
      case 'storage_clear':
        response = storageManager.clear();
        break;
      case 'storage_list':
        response = storageManager.list();
        break;
      case 'ping':
        response = { pong: true, timestamp: Date.now() };
        break;
      default:
        response = { error: `Unknown offscreen request: ${payload?.type}` };
    }

    window.postMessage({ type: 'offscreen_response', payload: response }, window.location.origin);
  });

  // ============================================================
  // FETCH INTERCEPTOR (for logging network in offscreen context)
  // ============================================================
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const startTime = Date.now();
    try {
      const response = await origFetch.apply(this, args);
      addRequest({
        type: 'fetch_completed',
        url: args[0]?.toString() || 'unknown',
        method: args[1]?.method || 'GET',
        status: response.status,
        duration: Date.now() - startTime,
      });
      return response;
    } catch (e) {
      addRequest({
        type: 'fetch_error',
        url: args[0]?.toString() || 'unknown',
        method: args[1]?.method || 'GET',
        error: e.message,
        duration: Date.now() - startTime,
      });
      throw e;
    }
  };

  // ============================================================
  // INIT
  // ============================================================
  console.log('[SIN Bridge Offscreen] Ready — DOM Parser, Blob, Storage active');

  // Signal readiness
  window.postMessage({
    type: 'offscreen_response',
    payload: { ready: true, timestamp: Date.now() }
  }, window.location.origin);
})();
