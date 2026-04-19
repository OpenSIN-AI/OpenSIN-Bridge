/**
 * Chrome DevTools Protocol driver.
 *
 * All CDP access goes through this module so:
 * - we attach to a tab once and reuse the session
 * - every send() is retried through a single sequencer (prevents CDP "promise
 *   rejected with: Another debugger is already attached" races)
 * - automatic detach on tab close / debugger detach
 */

import { BridgeError, ERROR_CODES, toBridgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';

const log = logger('cdp');

const attached = new Set();
const detachListeners = new Set();
const queues = new Map();

async function runQueued(tabId, fn) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => null).then(fn);
  queues.set(tabId, next.catch(() => null));
  try {
    return await next;
  } finally {
    if (queues.get(tabId) === next.catch(() => null)) {
      queues.delete(tabId);
    }
  }
}

/**
 * Attach to the given tab, enabling the domains we rely on.
 */
export async function attach(tabId) {
  if (attached.has(tabId)) return;

  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);

  try {
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}),
    ]);
  } catch (error) {
    log.warn('domain enable failed', { tabId, message: error?.message });
  }

  log.debug('attached', { tabId });
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_error) {
    // may already be detached
  }
  attached.delete(tabId);
  queues.delete(tabId);
  for (const listener of detachListeners) listener(tabId);
  log.debug('detached', { tabId });
}

export async function send(tabId, method, params = {}) {
  if (!Number.isInteger(tabId)) {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, `tabId must be an integer, got ${tabId}`);
  }
  try {
    await attach(tabId);
  } catch (error) {
    throw new BridgeError(ERROR_CODES.CDP_FAILED, `Failed to attach CDP to tab ${tabId}: ${error?.message}`);
  }

  return runQueued(tabId, async () => {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (error) {
      throw toBridgeError(error, ERROR_CODES.CDP_FAILED);
    }
  });
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export function onDetach(listener) {
  if (typeof listener === 'function') detachListeners.add(listener);
  return () => detachListeners.delete(listener);
}

export function installCdpListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (attached.has(tabId)) {
      attached.delete(tabId);
      queues.delete(tabId);
      for (const listener of detachListeners) listener(tabId);
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId && attached.has(source.tabId)) {
      attached.delete(source.tabId);
      queues.delete(source.tabId);
      log.info('detach event', { tabId: source.tabId, reason });
      for (const listener of detachListeners) listener(source.tabId);
    }
  });
}
