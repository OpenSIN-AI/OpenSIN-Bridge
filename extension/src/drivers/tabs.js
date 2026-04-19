/**
 * Tab lifecycle helpers.
 *
 * Agents drive browser state without a UI, so every tool that operates "on the
 * active tab" funnels through here. We transparently ensure a window + tab
 * exist, so the agent never has to think about cold-start states.
 */

import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { isSafeUrl } from '../core/config.js';
import { logger } from '../core/logger.js';

const log = logger('tabs');

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

export async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    throw new BridgeError(ERROR_CODES.TAB_GONE, `Tab ${tabId} is gone: ${error?.message}`);
  }
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
export async function createTab({ url, active = true, windowId } = {}) {
  if (url && !isSafeUrl(url)) {
    throw new BridgeError(ERROR_CODES.FORBIDDEN, `Blocked URL scheme: ${url}`);
  }

  const windows = await chrome.windows.getAll({ populate: false });
  if (windows.length === 0) {
    const ensured = await ensureActiveTab(url || 'about:blank');
    return { tabId: ensured.tab.id, url: ensured.tab.url || url, windowId: ensured.window.id, createdWindow: true };
  }

  try {
    const params = { active };
    if (url) params.url = url;
    if (windowId !== undefined) params.windowId = windowId;
    const tab = await chrome.tabs.create(params);
    return { tabId: tab.id, url: tab.url, windowId: tab.windowId, createdWindow: false };
  } catch (error) {
    log.warn('tabs.create fell back to ensureActiveTab', { message: error?.message });
    const ensured = await ensureActiveTab(url || 'about:blank');
    return { tabId: ensured.tab.id, url: ensured.tab.url || url, windowId: ensured.window.id, createdWindow: true };
  }
}

/**
 * Wait until the tab reports `status: "complete"`. Resolves with the final
 * tab object. Useful after navigate().
 */
export function waitForComplete(tabId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new BridgeError(ERROR_CODES.TIMEOUT, `Tab ${tabId} did not finish loading in ${timeoutMs}ms`));
    }, timeoutMs);

    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }, (error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new BridgeError(ERROR_CODES.TAB_GONE, error?.message || 'Tab is gone'));
    });
  });
}

/**
 * Execute a function in the target tab's MAIN world. Wrappers that just want to
 * run a snippet can call this instead of reimplementing chrome.scripting.
 */
export async function executeInTab(tabId, func, args = [], { world = 'MAIN', allFrames = false } = {}) {
  const tab = await getTab(tabId);
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
