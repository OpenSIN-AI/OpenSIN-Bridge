/**
 * ==============================================================================
 * DATEI: lifecycle.js
 * PROJEKT: OpenSIN-Bridge - Service Worker Lifecycle Management
 * ZWECK: Verwaltet den Lebenszyklus der Chrome Extension (MV3 Service Worker)
 *
 * WICHTIG FÜR ENTWICKLER:
 * - MV3 Service Worker werden aggressiv suspendiert (gespeichert/beendet)
 * - Diese Datei stellt sicher, dass die Extension am Leben bleibt
 * - Hooks für Install, Startup, Suspend und Alarm-Events
 * - Graceful Shutdown: Transport-Layer korrekt beenden vor Suspend
 *
 * ACHTUNG: Änderungen hier können dazu führen, dass die Extension abstürzt
 * oder nicht mehr reagiert! Immer testen nach Änderungen!
 * ==============================================================================
 */

import { logger } from './logger.js';
// HINWEIS: behavior-store wurde entfernt (Zeile 15 war: import { shutdown as shutdownBehavior } from '../drivers/behavior-store.js';)
// Der Shutdown-Hook in onSuspend wurde entsprechend angepasst (siehe unten)

const log = logger('lifecycle');

// Name und Periode des Keep-Alive Alarms
// WICHTIG: 0.4 Minuten = 24 Sekunden - häufig genug um Suspend zu verhindern
const KEEPALIVE_NAME = 'openSin.keepalive';
const KEEPALIVE_PERIOD_MIN = 0.4;

// Hook-Sammlungen: Externe Module können sich hier registrieren
const installHooks = [];   // Wird bei Installation ausgeführt
const startupHooks = [];   // Wird bei Browser-Start ausgeführt
const suspendHooks = [];   // Wird VOR dem Suspend ausgeführt (Cleanup!)
const alarmHooks = new Map(); // Alarm-spezifische Hooks (key = Alarm-Name)

// Status-Flag: Wurden die Listener bereits installiert?
let installed = false;

/**
 * Registriert einen Hook für das "onInstalled" Event
 * @param {Function} hook - Callback(details) wird bei Installation aufgerufen
 */
export function onInstalled(hook) { installHooks.push(hook); }

/**
 * Registriert einen Hook für das "onStartup" Event
 * @param {Function} hook - Callback() wird bei Browser-Start aufgerufen
 */
export function onStartup(hook) { startupHooks.push(hook); }

/**
 * Registriert einen Hook für das "onSuspend" Event
 * WICHTIG: Hier muss Cleanup-Code hin (Verbindungen trennen, speichern, etc.)
 * @param {Function} hook - Callback() wird VOR dem Suspend aufgerufen
 */
export function onSuspend(hook) { suspendHooks.push(hook); }

/**
 * Registriert einen Hook für einen spezifischen Alarm
 * @param {string} name - Name des Alarms
 * @param {Function} hook - Callback(alarm) wird bei diesem Alarm ausgeführt
 */
export function onAlarm(name, hook) { alarmHooks.set(name, hook); }

/**
 * Plant den Keep-Alive Alarm
 * WICHTIG: Muss bei jedem Start/Suspend neu geplant werden!
 */
export function scheduleKeepalive() {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
}

/**
 * Führt alle Hooks einer Liste aus, fängt Fehler ab damit ein Hook nicht alle anderen stoppt
 * @param {Array} hooks - Array von Funktionen
 * @param {string} label - Name für Log-Ausgabe (z.B. 'install', 'startup')
 * @param {any} payload - Parameter der an jeden Hook übergeben wird
 */
async function runHooks(hooks, label, payload) {
  for (const hook of hooks) {
    try {
      await hook(payload);
    } catch (error) {
      // Fehler loggen aber weitermachen - andere Hooks müssen auch laufen!
      log.error(`${label} hook failed`, { message: error?.message });
    }
  }
}

/**
 * Installiert die rohen Chrome Event-Listener
 * WICHTIG: Wird nur EINMAL aufgerufen (durch installed-Flag geschützt)
 */
function installRawListeners() {
  if (installed) return;
  installed = true;

  // Event: Extension wurde installiert/aktualisiert
  chrome.runtime.onInstalled.addListener((details) => {
    log.info('installed', { reason: details.reason });
    scheduleKeepalive();
    runHooks(installHooks, 'install', details);
  });

  // Event: Browser wurde gestartet
  chrome.runtime.onStartup.addListener(() => {
    log.info('startup');
    scheduleKeepalive();
    runHooks(startupHooks, 'startup');
  });

  // Event: Service Worker wird suspendiert (nur wenn verfügbar)
  if (chrome.runtime.onSuspend) {
    chrome.runtime.onSuspend.addListener(() => {
      log.info('suspend');
      runHooks(suspendHooks, 'suspend');
    });
  }

  // Event: Alarm ist ausgelöst (Keep-Alive oder andere)
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_NAME) {
      // Ein Tick reicht um den SW wach zu halten - keine Aktion nötig
    }
    // Prüfen ob es einen Hook für diesen Alarm gibt
    const hook = alarmHooks.get(alarm.name);
    if (hook) {
      Promise.resolve(hook(alarm)).catch((error) => {
        log.error('alarm hook failed', { alarm: alarm.name, message: error?.message });
      });
    }
  });
}

/**
 * Vollständige Initialisierung mit sinnvollen Defaults für diese Extension
 * WICHTIG: Diese Funktion MUSS beim Start der Extension aufgerufen werden!
 * 
 * @param {Object} options - Konfigurationsoptionen
 * @param {Object} options.ws - WebSocket Transport (optional)
 * @param {Object} options.native - Native Messaging Transport (optional)
 */
export function initLifecycle({ ws, native } = {}) {
  // Raw Listener installieren (einmalig)
  installRawListeners();
  
  // Keep-Alive Alarm starten
  scheduleKeepalive();

  // Suspend-Hook: Graceful Shutdown aller Komponenten
  onSuspend(async () => {
    try { ws?.stop?.(); } catch (_err) { /* ignore */ }
    try { native?.stop?.(); } catch (_err) { /* ignore */ }
    // HINWEIS: behavior-store Shutdown entfernt (wurde gelöscht)
    // try { await shutdownBehavior(); } catch (_err) { /* ignore */ }
  });

  // Click auf Toolbar-Action öffnet Popup (in manifest deklariert)
  // Fallback: Wenn kein Popup da ist, öffne Options-Page
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage().catch(() => {});
  });
}

/**
 * Low-Level Variante für Caller die eigene Kontrolle wollen
 * Nur die rohen Listener installieren, keine Defaults
 */
export function installLifecycle() {
  installRawListeners();
}

// Exportiere Alarm-Name für externe Verwendung
export const KEEPALIVE_ALARM = KEEPALIVE_NAME;
