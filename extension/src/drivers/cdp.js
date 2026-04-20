/**
 * ==============================================================================
 * DATEI: cdp.js
 * PROJEKT: OpenSIN-Bridge - Chrome DevTools Protocol Driver
 * ZWECK: Zentraler Zugriff auf CDP mit Queue-System zur Vermeidung von Race Conditions
 * 
 * WICHTIG FÜR ENTWICKLER:
 * - Alle CDP-Befehle laufen über dieses Modul
 * - Queue-System verhindert Konflikte bei parallelen Zugriffen
 * - Fehler werden korrekt weitergegeben, nicht verschluckt
 * - Auto-Detach bei Tab-Schließung
 * 
 * ACHTUNG: Änderungen hier beeinflussen ALLE Automationstools!
 * ==============================================================================
 */

import { BridgeError, ERROR_CODES, toBridgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { bindBus } from '../core/utils.js';

const log = logger('cdp');

// Status-Tracking: Welche Tabs sind an CDP angebunden?
const attached = new Set();
// Listener für Detach-Events (Cleanup)
const detachListeners = new Set();
// Queue pro TabID: Verhindert Race Conditions bei parallelen Befehlen
const queues = new Map();
// Event-Bus pro TabID: Für CDP Event-Subscriptions (z.B. Network.requestWillBeSent)
const buses = new Map();

/**
 * Holt oder erstellt einen Event-Bus für einen Tab
 * @param {number} tabId - Die Tab-ID
 * @returns {Object} Event-Bus Objekt mit on/off/clear Methoden
 */
function getBus(tabId) {
  let bus = buses.get(tabId);
  if (!bus) {
    bus = bindBus();
    buses.set(tabId, bus);
  }
  return bus;
}

/**
 * Führt eine Funktion in einer Queue aus, um Race Conditions zu vermeiden
 * WICHTIG: Jede CDP-Operation MUSS durch diese Queue laufen!
 * 
 * @param {number} tabId - Die Tab-ID
 * @param {Function} fn - Die auszuführende Funktion (muss Promise zurückgeben)
 * @returns {Promise} Ergebnis der Funktion
 */
async function runQueued(tabId, fn) {
  // Hole vorherige Operation oder starte mit resolved Promise
  const previous = queues.get(tabId) || Promise.resolve();
  
  // Neue Operation an Queue anhängen, Fehler abfangen damit Queue nicht abbricht
  const next = previous.catch(() => null).then(fn);
  
  // Queue speichern, aber nur den Catch-Teil um Memory-Leaks zu vermeiden
  queues.set(tabId, next.catch(() => null));
  
  try {
    return await next;
  } finally {
    // Aufräumen: Wenn diese Operation die letzte in der Queue ist, entfernen
    if (queues.get(tabId) === next.catch(() => null)) {
      queues.delete(tabId);
    }
  }
}

/**
 * Attach zu einem Tab - Aktiviert CDP für diesen Tab
 * WICHTIG: Muss vor jedem send() aufgerufen werden
 * 
 * @param {number} tabId - Die Tab-ID
 */
export async function attach(tabId) {
  // Bereits attached? Dann nichts tun (idempotent)
  if (attached.has(tabId)) return;
  
  // Debugger an Tab anhängen (CDP Version 1.3)
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  
  try {
    // Essenzielle Domains aktivieren
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}),
    ]);
    
    // Accessibility ist optional - manche Tabs unterstützen das nicht
    chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable', {}).catch(() => {});
  } catch (error) {
    // Warnung loggen, aber nicht abbrechen - andere Domains funktionieren vielleicht
    log.warn('domain enable failed', { tabId, message: error?.message });
  }
  
  log.debug('attached', { tabId });
}

/**
 * Detach von einem Tab - Gibt CDP-Ressourcen frei
 * WICHTIG: Wird automatisch bei Tab-Schließung aufgerufen
 * 
 * @param {number} tabId - Die Tab-ID
 */
export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_error) {
    // Tab könnte bereits detached sein - ignorieren
  }
  
  cleanup(tabId);
}

/**
 * Bereinigt alle Ressourcen für einen Tab
 * WICHTIG: Wird intern nach detach() aufgerufen
 * 
 * @param {number} tabId - Die Tab-ID
 */
function cleanup(tabId) {
  // Status entfernen
  attached.delete(tabId);
  queues.delete(tabId);
  
  // Event-Bus leeren und entfernen
  const bus = buses.get(tabId);
  if (bus) {
    bus.clear();
    buses.delete(tabId);
  }
  
  // Alle Detach-Listener benachrichtigen
  for (const listener of detachListeners) {
    try { listener(tabId); } catch (_e) { /* ignore */ }
  }
  
  log.debug('detached', { tabId });
}

/**
 * Alias für detach() - wird an manchen Stellen für klarere Semantik verwendet
 */
export async function detachAll(tabId) {
  return detach(tabId);
}

/**
 * Sendet einen CDP-Befehl an einen Tab
 * WICHTIG: Hauptfunktion für alle CDP-Operationen!
 * 
 * @param {number} tabId - Die Tab-ID (MUSST Integer sein!)
 * @param {string} method - CDP Method Name (z.B. 'DOM.querySelector')
 * @param {Object} params - CDP Parameter
 * @returns {Promise<Object>} CDP Response
 * @throws {BridgeError} Bei Fehlern (kein Integer tabId, CDP-Fehler, etc.)
 */
export async function send(tabId, method, params = {}) {
  // Validierung: tabId MUSST ein Integer sein!
  if (!Number.isInteger(tabId)) {
    throw new BridgeError(
      ERROR_CODES.INVALID_INPUT, 
      `tabId must be an integer, got ${tabId}`
    );
  }
  
  // Erst attachen (wenn noch nicht geschehen)
  try {
    await attach(tabId);
  } catch (error) {
    throw new BridgeError(
      ERROR_CODES.CDP_FAILED, 
      `Failed to attach CDP to tab ${tabId}: ${error?.message}`
    );
  }
  
  // Befehl durch die Queue schicken (verhindert Race Conditions)
  return runQueued(tabId, async () => {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (error) {
      // Fehler in BridgeError umwandeln für konsistente Behandlung
      throw toBridgeError(error, ERROR_CODES.CDP_FAILED);
    }
  });
}

/**
 * Prüft ob ein Tab an CDP angebunden ist
 * @param {number} tabId - Die Tab-ID
 * @returns {boolean} true wenn attached
 */
export function isAttached(tabId) {
  return attached.has(tabId);
}

/**
 * Abonniert ein CDP-Event für einen Tab
 * Beispiel: onEvent(tabId, 'Network.requestWillBeSent', (params) => ...)
 * 
 * @param {number} tabId - Die Tab-ID
 * @param {string} method - Event Name (z.B. 'Network.requestWillBeSent')
 * @param {Function} handler - Callback Funktion
 * @returns {Function} Cleanup-Funktion zum Abbestellen (einfach aufrufen)
 */
export function onEvent(tabId, method, handler) {
  if (typeof handler !== 'function') return () => {};
  return getBus(tabId).on(method, handler);
}

/**
 * Registriert einen Listener für Tab-Detach Events
 * @param {Function} listener - Callback(tabId)
 * @returns {Function} Cleanup-Funktion zum Entfernen
 */
export function onDetach(listener) {
  if (typeof listener === 'function') detachListeners.add(listener);
  return () => detachListeners.delete(listener);
}

/**
 * Installiert globale CDP-Listener - MUSS einmal beim Start aufgerufen werden
 * WICHTIG: Ohne diesen Aufruf funktionieren Events nicht!
 */
export function installCdpListeners() {
  // Listener für Tab-Schließung: Automatisch cleanup
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (attached.has(tabId)) cleanup(tabId);
  });

  // Listener für Debugger-Detach: z.B. wenn User Developer Tools schließt
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId && attached.has(source.tabId)) {
      log.info('detach event', { tabId: source.tabId, reason });
      cleanup(source.tabId);
    }
  });

  // Listener für CDP-Events: Verteilt Events an Subscriber
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source.tabId) return;
    const bus = buses.get(source.tabId);
    if (bus) bus.emit(method, params);
  });
}
