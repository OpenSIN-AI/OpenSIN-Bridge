/**
 * Service-worker lifecycle helpers.
 *
 * MV3 service workers get suspended aggressively. The bridge relies on
 * chrome.alarms for a predictable keep-alive cadence plus explicit install,
 * startup, suspend, and action-click hooks.
 *
 * The public entry is `initLifecycle({ ws?, native?, router? })` — it wires
 * sensible defaults (keep-alive, open popup on action click, shutdown
 * transports on suspend) plus lets callers add their own hooks via onInstalled
 * / onStartup / onSuspend / onAlarm.
 */

import { logger } from './logger.js';
import { shutdown as shutdownBehavior } from '../drivers/behavior-store.js';

const log = logger('lifecycle');

const KEEPALIVE_NAME = 'openSin.keepalive';
const KEEPALIVE_PERIOD_MIN = 0.4;

const installHooks = [];
const startupHooks = [];
const suspendHooks = [];
const alarmHooks = new Map();

let installed = false;

export function onInstalled(hook) { installHooks.push(hook); }
export function onStartup(hook) { startupHooks.push(hook); }
export function onSuspend(hook) { suspendHooks.push(hook); }
export function onAlarm(name, hook) { alarmHooks.set(name, hook); }

export function scheduleKeepalive() {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
}

async function runHooks(hooks, label, payload) {
  for (const hook of hooks) {
    try {
      await hook(payload);
    } catch (error) {
      log.error(`${label} hook failed`, { message: error?.message });
    }
  }
}

function installRawListeners() {
  if (installed) return;
  installed = true;

  chrome.runtime.onInstalled.addListener((details) => {
    log.info('installed', { reason: details.reason });
    scheduleKeepalive();
    runHooks(installHooks, 'install', details);
  });

  chrome.runtime.onStartup.addListener(() => {
    log.info('startup');
    scheduleKeepalive();
    runHooks(startupHooks, 'startup');
  });

  if (chrome.runtime.onSuspend) {
    chrome.runtime.onSuspend.addListener(() => {
      log.info('suspend');
      runHooks(suspendHooks, 'suspend');
    });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_NAME) {
      // A tick is enough to keep the SW alive; no work required.
    }
    const hook = alarmHooks.get(alarm.name);
    if (hook) {
      Promise.resolve(hook(alarm)).catch((error) => {
        log.error('alarm hook failed', { alarm: alarm.name, message: error?.message });
      });
    }
  });
}

/**
 * Full init with sensible defaults for this extension. Services passed in
 * (`ws`, `native`) are shut down gracefully on suspend.
 */
export function initLifecycle({ ws, native } = {}) {
  installRawListeners();
  scheduleKeepalive();

  onSuspend(async () => {
    try { ws?.stop?.(); } catch (_err) { /* ignore */ }
    try { native?.stop?.(); } catch (_err) { /* ignore */ }
    try { await shutdownBehavior(); } catch (_err) { /* ignore */ }
  });

  // Click on the toolbar action opens the popup (declared in manifest) — no
  // extra work needed here. Provide a fallback for environments without a
  // popup by opening the options page.
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage().catch(() => {});
  });
}

/**
 * Low-level variant used by callers who want to own their own wiring.
 */
export function installLifecycle() {
  installRawListeners();
}

export const KEEPALIVE_ALARM = KEEPALIVE_NAME;
