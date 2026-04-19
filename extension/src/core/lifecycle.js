/**
 * Service-worker lifecycle helpers.
 *
 * MV3 service workers get suspended aggressively. The bridge relies on
 * chrome.alarms for a predictable keep-alive cadence plus explicit install,
 * startup, and suspend hooks.
 */

import { logger } from './logger.js';

const log = logger('lifecycle');

const KEEPALIVE_NAME = 'openSin.keepalive';
const KEEPALIVE_PERIOD_MIN = 0.4;

const installHooks = [];
const startupHooks = [];
const suspendHooks = [];
const alarmHooks = new Map();

export function onInstalled(hook) {
  installHooks.push(hook);
}

export function onStartup(hook) {
  startupHooks.push(hook);
}

export function onSuspend(hook) {
  suspendHooks.push(hook);
}

export function onAlarm(name, hook) {
  alarmHooks.set(name, hook);
}

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

export function installLifecycle() {
  chrome.runtime.onInstalled.addListener((details) => {
    log.info('installed', { reason: details.reason });
    runHooks(installHooks, 'install', details);
  });

  chrome.runtime.onStartup.addListener(() => {
    log.info('startup');
    runHooks(startupHooks, 'startup');
  });

  // Fires right before MV3 suspends the SW. Best-effort only.
  if (chrome.runtime.onSuspend) {
    chrome.runtime.onSuspend.addListener(() => {
      log.info('suspend');
      runHooks(suspendHooks, 'suspend');
    });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_NAME) {
      // Swap in your own logic via onAlarm(KEEPALIVE_NAME, fn) if needed.
    }
    const hook = alarmHooks.get(alarm.name);
    if (hook) {
      Promise.resolve(hook(alarm)).catch((error) => {
        log.error('alarm hook failed', { alarm: alarm.name, message: error?.message });
      });
    }
  });
}

export const KEEPALIVE_ALARM = KEEPALIVE_NAME;
