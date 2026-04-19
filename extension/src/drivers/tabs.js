/**
 * Tab lifecycle helpers.
 *
 * Agents drive browser state without a UI, so every tool that operates "on the
 * active tab" funnels through here. We transparently ensure a window + tab
 * exist, so the agent never has to think about cold-start states.
 *
 * Exposed:
 *   resolveTabId, activeTabId, get, query, create, update, remove, reload,
 *   ensureActiveTab, waitForComplete / waitForLoad, executeInTab, sendToTab,
 *   onTabRemoved, captureTab, focusWindow
 */

import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { isSafeUrl } from '../core/config.js';
import { logger } from '../core/logger.js';

const log = logger('tabs');

/**
 * Resolve a tab id:
 *   - explicit number → validated
 *   - "active" or undefined → current active tab in last-focused window
 *   - { active: true, windowId } → chrome.tabs.query
 * Always returns a number; throws on missing tab.
 */
export async function resolveTabId(value, options = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Validate it exists — throw early with a clear code if not.
    try {
      const tab = await chrome.tabs.get(value);
      if (!tab) throw new BridgeError(ERROR_CODES.TAB_GONE, `Tab ${value} not found`);
      return tab.id;
    } catch (error) {
      throw new BridgeError(ERROR_CODES.TAB_GONE, `Tab ${value} is gone: ${error?.message || error}`);
    }
  }
  return activeTabId(options);
}

/**
 * Resolve the currently active tab, creating a starter tab if the browser
 * window is somehow empty.
 */
export async function activeTabId(options = {}) {
  const query = { active: true, lastFocusedWindow: true };
  let tabs = await chrome.tabs.query(query);
  let tab = tabs[0];

  if (!tab) {
    tabs = await chrome.tabs.query({ active: true });
    tab = tabs[0];
  }

  if (!tab) {
    if (options.createIfMissing === false) {
      throw new BridgeError(ERROR_CODES.TAB_GONE, 'No active tab found');
    }
    const { tab: ensured } = await ensureActiveTab(options.fallbackUrl || 'about:blank');
    tab = ensured;
  }

  if (!tab || typeof tab.id !== 'number') {
    throw new BridgeError(ERROR_CODES.TAB_GONE, 'Unable to resolve active tab id');
  }
  return tab.id;
}

export async function get(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    throw new BridgeError(ERROR_CODES.TAB_GONE, `Tab ${tabId} is gone: ${error?.message}`);
  }
}

/**
 * Alias kept for older call-sites.
 */
export const getTab = get;

export async function query(filter = {}) {
  return chrome.tabs.query(filter);
}

/**
 * Ensure a Chrome window + active tab exist. Returns { window, tab }.
 */
export async function ensureActiveTab(url = 'about:blank') {
  const windows = await chrome.windows.getAll({ populate: true });
  let win = windows.find((w) => w.focused) || windows[0];

  if (!win) {
    const created = await chrome.windows.create({ url, focused: true });
    win = created;
  } else if (!win.tabs || win.tabs.length === 0) {
    win.tabs = await chrome.tabs.query({ windowId: win.id });
  }

  let tab = win.tabs?.find((t) => t.active) || win.tabs?.[0];
  if (!tab) {
    tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  }
  return { window: win, tab };
}

/**
 * Create a tab, gracefully falling back to window creation when Chrome is
 * windowless.
 */
export async function create({ url, active = true, pinned = false, windowId, index, openerTabId } = {}) {
  if (url && !isSafeUrl(url)) {
    throw new BridgeError(ERROR_CODES.FORBIDDEN, `Blocked URL scheme: ${url}`);
  }

  const windows = await chrome.windows.getAll({ populate: false });
  if (windows.length === 0) {
    const ensured = await ensureActiveTab(url || 'about:blank');
    return ensured.tab;
  }

  try {
    const params = { active, pinned };
    if (url) params.url = url;
    if (windowId !== undefined) params.windowId = windowId;
    if (index !== undefined) params.index = index;
    if (openerTabId !== undefined) params.openerTabId = openerTabId;
    return await chrome.tabs.create(params);
  } catch (error) {
    log.warn('tabs.create fell back to ensureActiveTab', { message: error?.message });
    const ensured = await ensureActiveTab(url || 'about:blank');
    return ensured.tab;
  }
}

/**
 * Back-compat: older callers expect the flat shape below. New code should use
 * `create()` which returns the raw Chrome tab object.
 */
export async function createTab(opts = {}) {
  const tab = await create(opts);
  return {
    id: tab.id,
    tabId: tab.id,
    url: tab.url,
    windowId: tab.windowId,
  };
}

export async function update(tabId, updateProperties = {}) {
  return chrome.tabs.update(tabId, updateProperties);
}

export async function remove(tabIds) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  return chrome.tabs.remove(ids);
}

export async function reload(tabId, { bypassCache = false } = {}) {
  return chrome.tabs.reload(tabId, { bypassCache });
}

/**
 * Capture the visible area of the given window. Screenshot tool.
 */
export async function captureTab(windowId, options = { format: 'png' }) {
  return chrome.tabs.captureVisibleTab(windowId, options);
}

export async function focusWindow(windowId) {
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch (_error) {
    // best-effort
  }
}

/**
 * Wait until the tab reports `status: "complete"` (or "loading" if requested).
 */
export function waitForComplete(tabId, timeoutMs = 20_000, { state = 'complete' } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new BridgeError(ERROR_CODES.TIMEOUT, `Tab ${tabId} did not reach ${state} in ${timeoutMs}ms`));
    }, timeoutMs);

    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId) return;
      if (changeInfo.status === state) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab && tab.status === state) {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      },
      (error) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new BridgeError(ERROR_CODES.TAB_GONE, error?.message || 'Tab is gone'));
      },
    );
  });
}

/**
 * Convenience alias used by tool modules.
 */
export function waitForLoad(tabId, { timeout = 30_000, state = 'complete' } = {}) {
  return waitForComplete(tabId, timeout, { state });
}

/**
 * Execute a function in the target tab's MAIN world. Wrappers that just want to
 * run a snippet can call this instead of reimplementing chrome.scripting.
 */
export async function executeInTab(tabId, func, args = [], { world = 'MAIN', allFrames = false } = {}) {
  const tab = await get(tabId);
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
    throw new BridgeError(ERROR_CODES.FORBIDDEN, 'Cannot execute script on internal Chrome pages');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    func,
    args,
    world,
  });
  return results?.[0]?.result;
}

/**
 * Send a message to the ISOLATED-world content script in the target tab /
 * frame. Returns the content script's response or throws a BridgeError if the
 * tab is gone / no receiver is listening.
 *
 * The content script's response envelope is deliberately minimal:
 *   success → the raw result object (often `{ ok: true, ... }`)
 *   failure → `{ error: string, code?: string }`
 * We translate failures into BridgeError so the RPC layer surfaces them with
 * a stable code.
 */
export async function sendToTab(tabId, message, options = {}) {
  const opts = {};
  if (Number.isInteger(options.frameId)) opts.frameId = options.frameId;
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, opts, (response) => {
      const rtErr = chrome.runtime.lastError;
      if (rtErr) {
        reject(new BridgeError(ERROR_CODES.TAB_GONE, rtErr.message || 'sendToTab failed'));
        return;
      }
      if (response == null) {
        reject(new BridgeError(ERROR_CODES.TAB_GONE, 'No response from content script'));
        return;
      }
      // Error envelope: { error: "msg", code: "CODE" }
      if (typeof response === 'object' && typeof response.error === 'string') {
        reject(new BridgeError(response.code || ERROR_CODES.INTERNAL_ERROR, response.error));
        return;
      }
      // Nested envelope: { ok: false, error: { code, message } }
      if (typeof response === 'object' && response.ok === false && response.error && typeof response.error === 'object') {
        reject(new BridgeError(
          response.error.code || ERROR_CODES.INTERNAL_ERROR,
          response.error.message || 'content script error',
          response.error.data,
        ));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Subscribe to tab-removed events. Returns an unsubscribe fn.
 */
export function onTabRemoved(handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (tabId, info) => handler(tabId, info);
  chrome.tabs.onRemoved.addListener(listener);
  return () => chrome.tabs.onRemoved.removeListener(listener);
}
