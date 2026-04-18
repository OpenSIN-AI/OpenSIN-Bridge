/**
 * OpenSIN Bridge — Content Script (DOM Bridge)
 *
 * This is a THIN CLIENT. It contains ZERO business logic.
 * It extracts DOM data and executes actions dictated by the server.
 *
 * Responsibilities:
 * - Extract DOM structure and send to server via background script
 * - Execute click/type/scroll actions returned by server
 * - Report action results back to server
 * - Human-like timing jitter on all actions
 */

(function() {
  'use strict';

  const JITTER_MIN = 2000; // ms
  const JITTER_MAX = 5500; // ms

  // The shared helper may or may not be present depending on how this file is
  // injected during local experiments, so we treat it as optional and never let
  // its absence break the legacy extraction path.
  const deterministicPrimitives = globalThis.__OpenSINDeterministicPrimitives || null;

  // --- DOM Extraction (no business logic — just data) ---

  function extractPageData() {
    const buttons = extractButtons();
    const payload = {
      url: window.location.href,
      title: document.title,
      timestamp: Date.now(),
      forms: extractForms(),
      buttons,
      links: extractLinks(),
      text_content: document.body?.innerText?.substring(0, 5000) || '',
    };

    // Deterministic metadata is additive: it enriches the snapshot for the
    // runtime without changing the legacy shape that existing callers already
    // expect. Unknown pages therefore continue to work exactly as before.
    if (deterministicPrimitives?.buildDeterministicPrimitivePayload) {
      payload.deterministic_primitives = deterministicPrimitives.buildDeterministicPrimitivePayload(payload, window.location.href);
    }

    return payload;
  }

  function extractForms() {
    const forms = [];
    document.querySelectorAll('input, select, textarea').forEach(el => {
      forms.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        value: el.value || '',
        label: findLabel(el),
        selector: generateSelector(el),
        visible: el.offsetParent !== null,
      });
    });
    return forms;
  }

  function extractButtons() {
    const buttons = [];
    document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(el => {
      // Input-based submit controls often store their visible label in .value
      // rather than textContent, so we capture both to make deterministic button
      // matching reliable across native and custom form controls.
      buttons.push({
        text: (el.textContent || el.value || '').trim().substring(0, 100),
        value: typeof el.value === 'string' ? el.value.substring(0, 100) : '',
        id: el.id || '',
        selector: generateSelector(el),
        visible: el.offsetParent !== null,
      });
    });
    return buttons;
  }

  function extractLinks() {
    const links = [];
    document.querySelectorAll('a[href]').forEach(el => {
      links.push({
        text: el.textContent?.trim()?.substring(0, 100) || '',
        href: el.href || '',
        selector: generateSelector(el),
        visible: el.offsetParent !== null,
      });
    });
    return links;
  }

  function findLabel(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent?.trim() || '';
    }
    const parent = el.closest('label');
    if (parent) return parent.textContent?.trim() || '';
    return '';
  }

  function generateSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.name) return `[name="${el.name}"]`;
    // Fallback: nth-child path
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      const parent = current.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children).indexOf(current);
      path.unshift(`${current.tagName.toLowerCase()}:nth-child(${index + 1})`);
      current = parent;
    }
    return path.join(' > ');
  }

  // --- Action Executor (server tells us what to do) ---

  async function executeAction(action) {
    // Add human-like jitter
    const delay = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
    await new Promise(r => setTimeout(r, delay));

    switch (action.action) {
      case 'click':
        return executeClick(action.selector);
      case 'type':
        return executeType(action.selector, action.text);
      case 'select':
        return executeSelect(action.selector, action.value);
      case 'scroll':
        return executeScroll(action.selector);
      case 'wait':
        await new Promise(r => setTimeout(r, (action.duration || 5) * 1000));
        return { success: true, action: 'wait' };
      case 'navigate':
        window.location.href = action.url;
        return { success: true, action: 'navigate' };
      case 'extract':
        return { success: true, action: 'extract', data: extractPageData() };
      default:
        return { success: false, error: `Unknown action: ${action.action}` };
    }
  }

  function executeClick(selector) {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `Element not found: ${selector}` };
    if (el.offsetParent === null) return { success: false, error: `Element not visible: ${selector}` };
    
    // Human-like click: mousedown -> mouseup -> click (bypasses React event swallowing)
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    
    return { success: true, action: 'click', selector };
  }

  function executeType(selector, text) {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `Element not found: ${selector}` };
    
    el.focus();
    el.value = '';
    
    // Character-by-character typing for human emulation
    for (const char of text) {
      el.value += char;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    
    return { success: true, action: 'type', selector };
  }

  function executeSelect(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `Element not found: ${selector}` };
    
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    
    return { success: true, action: 'select', selector, value };
  }

  function executeScroll(selector) {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      window.scrollBy({ top: 300, behavior: 'smooth' });
    }
    return { success: true, action: 'scroll' };
  }

  // --- Message Handler (background script commands) ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_PAGE') {
      sendResponse({ success: true, data: extractPageData() });
      return false;
    }

    if (message.type === 'EXECUTE_ACTION') {
      executeAction(message.action)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async
    }
  });

  console.log('[OpenSIN Bridge] Content script loaded on', window.location.href);
})();
