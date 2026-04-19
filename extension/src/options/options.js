/**
 * options/options.js — persists settings into chrome.storage.local under the
 * canonical `openSin.config` key that initConfig() reads at boot.
 *
 * Transports re-read when restarted from the popup; the service worker
 * re-reads on next suspend/resume cycle.
 */

const CONFIG_KEY = 'openSin.config';
const VISION_KEYS_KEY = 'openSin.visionKeys';

const DEFAULTS = {
  wsUrl: 'wss://openjerro-opensin-bridge-mcp.hf.space/extension',
  nativeHost: 'ai.opensin.bridge.host',
  autostartWs: true,
  autostartNative: false,
  heartbeatMs: 20000,
  backoffMaxMs: 30000,
  externallyAllowed: [],
  visionProvider: 'gateway',
  visionKey: '',
};

const $ = (sel) => document.querySelector(sel);

function parseList(text) {
  return String(text || '')
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function load() {
  const stored = await chrome.storage.local.get([CONFIG_KEY, VISION_KEYS_KEY]);
  const cfg = stored[CONFIG_KEY] || {};
  const vk = stored[VISION_KEYS_KEY] || {};

  $('#wsUrl').value = cfg.wsUrl ?? DEFAULTS.wsUrl;
  $('#nativeHost').value = cfg.nativeHost ?? DEFAULTS.nativeHost;
  $('#autostartWs').value = String(cfg.autostart?.ws ?? DEFAULTS.autostartWs);
  $('#autostartNative').value = String(cfg.autostart?.native ?? DEFAULTS.autostartNative);
  $('#heartbeatMs').value = cfg.ws?.heartbeatMs ?? DEFAULTS.heartbeatMs;
  $('#backoffMaxMs').value = cfg.ws?.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
  $('#externallyAllowed').value = (cfg.externallyAllowed || DEFAULTS.externallyAllowed).join('\n');
  $('#visionProvider').value = vk.provider || DEFAULTS.visionProvider;
  $('#visionKey').value = vk.key || DEFAULTS.visionKey;
}

async function save(event) {
  event.preventDefault();
  const cfg = {
    wsUrl: $('#wsUrl').value.trim() || DEFAULTS.wsUrl,
    nativeHost: $('#nativeHost').value.trim() || DEFAULTS.nativeHost,
    autostart: {
      ws: $('#autostartWs').value === 'true',
      native: $('#autostartNative').value === 'true',
    },
    ws: {
      heartbeatMs: Number($('#heartbeatMs').value) || DEFAULTS.heartbeatMs,
      backoffMaxMs: Number($('#backoffMaxMs').value) || DEFAULTS.backoffMaxMs,
    },
    externallyAllowed: parseList($('#externallyAllowed').value),
  };
  const vision = {
    provider: $('#visionProvider').value,
    key: $('#visionKey').value.trim(),
  };

  await chrome.storage.local.set({
    [CONFIG_KEY]: cfg,
    [VISION_KEYS_KEY]: vision,
  });

  const saved = $('#saved');
  saved.textContent = 'saved — restart the bridge from the popup for all changes to take effect';
  setTimeout(() => (saved.textContent = ''), 4000);
}

function reset() {
  $('#wsUrl').value = DEFAULTS.wsUrl;
  $('#nativeHost').value = DEFAULTS.nativeHost;
  $('#autostartWs').value = String(DEFAULTS.autostartWs);
  $('#autostartNative').value = String(DEFAULTS.autostartNative);
  $('#heartbeatMs').value = DEFAULTS.heartbeatMs;
  $('#backoffMaxMs').value = DEFAULTS.backoffMaxMs;
  $('#externallyAllowed').value = DEFAULTS.externallyAllowed.join('\n');
  $('#visionProvider').value = DEFAULTS.visionProvider;
  $('#visionKey').value = DEFAULTS.visionKey;
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('#form').addEventListener('submit', save);
  $('#reset').addEventListener('click', reset);
});
