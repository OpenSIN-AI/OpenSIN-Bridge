/**
 * Chrome DevTools Protocol driver.
 *
 * All CDP access goes through this module so:
 *   - we attach to a tab once and reuse the session
 *   - every send() is queued per-tab, preventing races when multiple tools
 *     hit the same tab concurrently
 *   - event subscriptions are dispatched via chrome.debugger.onEvent
 *   - auto-detach on tab close / debugger detach
 */

import { BridgeError, ERROR_CODES, toBridgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { bindBus } from '../core/utils.js';

const log = logger('cdp');

const attached = new Set();
const detachListeners = new Set();
const queues = new Map();
// tabId -> bus  (CDP event subscriptions keyed by "Domain.event")
const buses = new Map();

function getBus(tabId) {
  let bus = buses.get(tabId);
  if (!bus) {
    bus = bindBus();
    buses.set(tabId, bus);
  }
  return bus;
}

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
      chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}),
    ]);
    // Accessibility is optional — not all tabs support it.
    chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable', {}).catch(() => {});
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
  cleanup(tabId);
}

function cleanup(tabId) {
  attached.delete(tabId);
  queues.delete(tabId);
  const bus = buses.get(tabId);
  if (bus) {
    bus.clear();
    buses.delete(tabId);
  }
  for (const listener of detachListeners) {
    try { listener(tabId); } catch (_e) { /* ignore */ }
  }
  log.debug('detached', { tabId });
}

/**
 * Alias — some call-sites use detachAll to emphasise cleanup semantics.
 */
export async function detachAll(tabId) {
  return detach(tabId);
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

/**
 * Subscribe to a CDP event on a specific tab.
 *   const off = onEvent(tabId, 'Network.requestWillBeSent', (p) => ...)
 *   off()  // to unsubscribe
 */
export function onEvent(tabId, method, handler) {
  if (typeof handler !== 'function') return () => {};
  return getBus(tabId).on(method, handler);
}

export function onDetach(listener) {
  if (typeof listener === 'function') detachListeners.add(listener);
  return () => detachListeners.delete(listener);
}

/**
 * Install the global listeners. Call once at boot.
 */
export function installCdpListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (attached.has(tabId)) cleanup(tabId);
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId && attached.has(source.tabId)) {
      log.info('detach event', { tabId: source.tabId, reason });
      cleanup(source.tabId);
    }
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source.tabId) return;
    const bus = buses.get(source.tabId);
    if (bus) bus.emit(method, params);
  });
}
