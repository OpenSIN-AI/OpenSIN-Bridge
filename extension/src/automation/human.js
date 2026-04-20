/**
 * ==============================================================================
 * DATEI: human.js
 * PROJEKT: OpenSIN Bridge - Extension
 * ZWECK: Menschliche Mausbewegungen und Interaktionen für Anti-Bot-Umgehung
 *
 * WICHTIG FÜR ENTWICKLER:
 * Diese Datei ist das HERZSTÜCK der Stealth-Funktionalität. Jede Änderung hier
 * kann die gesamte Bot-Erkennungsimmunität zerstören. Lies ALLE Kommentare, bevor
 * du etwas änderst. Programmierer machen hier oft dumme Fehler!
 *
 * WAS DIESE DATEI TUT:
 * - Simuliert natürliches Maus-Zittern (physiologischer Tremor)
 * - Erstellt realistische Beschleunigungskurven beim Bewegen
 * - Vermeidet perfekte geometrische Klicks (die sofort auffallen)
 * - Speichert den letzten Mausposition für kontinuierliche Bewegungen
 *
 * ANTI-BOT GRUNDLAGEN:
 * Cloudflare & Co. erkennen Bots an:
 * 1. Perfekt gerade Linien (Menschen zittern immer leicht)
 * 2. Sofortige Teleportation zum Button-Zentrum (Menschen brauchen Anlauf)
 * 3. Immer gleiche Timing-Muster (Menschen variieren stark)
 * Diese Datei bekämpft alle drei Erkennungsmethoden!
 * ==============================================================================
 */

import * as cdp from '../drivers/cdp.js';
import { HUMAN } from '../core/config.js';
import { sleep, randomBetween, randomInt, clamp } from '../core/utils.js';

// Speichert die letzte bekannte Mausposition pro Tab
// WICHTIG: Ohne das würde jede Bewegung bei (0,0) starten = UNNATÜRLICH!
const pointerState = new Map();

/**
 * Berechnet einen natürlichen Landepunkt innerhalb eines Button-Bereichs.
 * 
 * WARUM NICHT DAS ZENTRUM?
 * Ein Bot klickt IMMER exakt ins Zentrum. Menschen klicken ungenau.
 * Diese Funktion fügt zufällige Abweichungen (Jitter) hinzu, die aber
 * immer noch innerhalb des Buttons bleiben.
 * 
 * @param {number[]} border - Die 8 Koordinaten des DOM-Box-Modells [x1,y1,x2,y2,...]
 * @param {number} maxJitterPx - Maximale Abweichung vom Zentrum (default aus Config)
 * @returns {{x: number, y: number, bounds: object}} Die natürliche Klickposition
 * 
 * ENTWICKLER-HINWEIS:
 * Ändere NICHT die Jitter-Berechnung ohne gute Tests! Zu viel Jitter = Klick daneben.
 * Zu wenig Jitter = Bot wird erkannt. Der Sweet Spot ist in HUMAN.pointerJitterPx.
 */
export function pointFromBorder(border, maxJitterPx = HUMAN.pointerJitterPx) {
  // Extrahiere alle X- und Y-Koordinaten aus dem Border-Polygon
  const xs = [border[0], border[2], border[4], border[6]];
  const ys = [border[1], border[3], border[5], border[7]];
  
  // Finde die Grenzen des Elements
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  
  // Berechne Breite und Höhe (mindestens 1 Pixel, um Division durch Null zu vermeiden)
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  
  // Berechne das geometrische Zentrum
  const centerX = minX + width / 2;
  const centerY = minY + height / 2;
  
  // Berechne erlaubten Jitter basierend auf Elementgröße
  // GRUNDREGEL: Größere Buttons dürfen mehr Jitter haben
  // Kleiner Button = präziser Klick nötig
  // Großer Button = mehr menschliche Ungenauigkeit erlaubt
  const jitterX = Math.min(maxJitterPx, Math.max(1, width / 4));
  const jitterY = Math.min(maxJitterPx, Math.max(1, height / 4));

  // Rückgabe: Zufällige Position innerhalb des Jitter-Radius, aber IMMER im Button
  return {
    x: Math.round(clamp(centerX + randomBetween(-jitterX, jitterX), minX + 1, maxX - 1)),
    y: Math.round(clamp(centerY + randomBetween(-jitterY, jitterY), minY + 1, maxY - 1)),
    bounds: { minX, maxX, minY, maxY },
  };
}

/**
 * Bestimmt den Startpunkt für eine Mausbewegung.
 * 
 * WICHTIG: Wenn wir die letzte Position kennen, starten wir DORT.
 * Das erzeugt kontinuierliche, natürliche Bewegungen über mehrere Aktionen hinweg.
 * Wenn keine letzte Position bekannt ist, starten wir leicht versetzt vom Ziel
 * (wie ein Mensch, der erst grob zielt und dann präzise wird).
 * 
 * @param {number} tabId - Die Chrome Tab-ID
 * @param {{x: number, y: number}} target - Die Zielkoordinaten
 * @returns {{x: number, y: number}} Der Startpunkt der Bewegung
 */
function startPoint(tabId, target) {
  const last = pointerState.get(tabId);
  if (last) return { x: last.x, y: last.y };
  // Kein vorheriger Punkt bekannt: Starte mit natürlichem Versatz
  // (Menschen starten nicht perfekt am Ziel, sondern kommen von irgendwo)
  return {
    x: Math.round(target.x + randomBetween(-36, 36)),
    y: Math.round(target.y + randomBetween(-24, 24)),
  };
}

/**
 * BEWEGT die Maus auf natürliche Weise zum Ziel.
 * 
 * DAS IST DIE WICHTIGSTE FUNKTION FÜR ANTI-BOT!
 * 
 * Was sie tut:
 * 1. Erstellt eine Annäherungskurve mit mehreren Zwischenpunkten
 * 2. Fügt bei jedem Schritt mikroskopisches Zittern hinzu (Residual Noise)
 * 3. Variiert die Geschwindigkeit (schneller am Anfang, langsamer am Ziel)
 * 4. Speichert jeden Zwischenpunkt für kontinuierliche nächste Bewegungen
 * 
 * @param {number} tabId - Die Chrome Tab-ID
 * @param {{x: number, y: number, bounds: object}} target - Das Ziel mit Bounds
 * @returns {Promise<{x: number, y: number}>} Die finale Mausposition
 * 
 * ENTWICKLER-WARNUNG:
 * Ändere NIEMALS die Schrittzahl oder Timing-Werte ohne umfangreiche Tests!
 * Diese Werte wurden über Monate optimiert, um Cloudflare zu umgehen.
 */
export async function movePointer(tabId, target) {
  const start = startPoint(tabId, target);
  // Zufällige Schrittzahl für Varianz (Menschen bewegen sich nicht immer gleich)
  const steps = randomInt(HUMAN.pointerApproachSteps.min, HUMAN.pointerApproachSteps.max);
  const { bounds } = target;

  for (let step = 1; step <= steps; step += 1) {
    // Fortschrittsfaktor: 0.0 bis 1.0
    const progress = step / steps;
    
    // Residual Noise: Wird kleiner je näher wir dem Ziel kommen
    // Simuliert die natürliche Präzisionssteigerung beim Zielen
    const residual = 2.5 * (1 - progress);
    
    // Berechne aktuelle Position mit Progress + zufälligem Rauschen
    const x = Math.round(start.x + (target.x - start.x) * progress + randomBetween(-residual, residual));
    const y = Math.round(start.y + (target.y - start.y) * progress + randomBetween(-residual, residual));
    
    // Stelle sicher, dass wir nicht außerhalb der erlaubten Grenzen landen
    // (+/- 48px Puffer für natürliche Überzieher beim Bewegen)
    const point = {
      x: clamp(x, Math.min(bounds.minX, start.x) - 48, Math.max(bounds.maxX, start.x) + 48),
      y: clamp(y, Math.min(bounds.minY, start.y) - 48, Math.max(bounds.maxY, start.y) + 48),
    };

    // Sende das Maus-Bewegungs-Event an Chrome via CDP (Chrome DevTools Protocol)
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    
    // Speichere aktuelle Position für nächste Bewegung (KONTINUITÄT!)
    pointerState.set(tabId, point);
    
    // Kurze Pause zwischen Schritten für natürliches Timing
    await sleep(randomInt(HUMAN.perStepDelayMs.min, HUMAN.perStepDelayMs.max));
  }

  // Speichere finale Zielposition
  pointerState.set(tabId, { x: target.x, y: target.y });
  return { x: target.x, y: target.y };
}

/**
 * Führt ein HOVER (Drüberfahren) auf einem Element aus.
 * 
 * Verwendung: Für Tooltips, Dropdown-Menüs, Hover-Effekte
 * 
 * @param {number} tabId - Die Chrome Tab-ID
 * @param {{x: number, y: number, bounds: object}} target - Das Ziel
 * @returns {Promise<{x: number, y: number}>} Die finale Position
 */
export async function hover(tabId, target) {
  const settled = await movePointer(tabId, target);
  // Kurze natürliche Pause nach dem Bewegen (Menschen verharren kurz)
  await sleep(randomInt(80, 180));
  return settled;
}

/**
 * Führt einen KLICK auf einem Element aus.
 * 
 * Dies ist die am häufigsten verwendete Funktion. Sie kombiniert:
 * 1. Natürliche Annäherung (movePointer)
 * 2. Kurze Denkpause vor dem Klick (preClickDelay)
 * 3. Realistische Klickdauer (pressHold)
 * 4. Pause nach dem Loslassen (postRelease)
 * 
 * @param {number} tabId - Die Chrome Tab-ID
 * @param {{x: number, y: number, bounds: object}} target - Das Ziel
 * @param {{button?: 'left'|'right'|'middle'}} options - Klick-Optionen
 * @returns {Promise<{x: number, y: number}>} Die finale Position
 * 
 * WICHTIG FÜR ENTWICKLER:
 * Die Timing-Werte in HUMAN.* sind KRITISCH! Nicht ändern ohne A/B-Tests.
 * Cloudflare misst genau diese Delays zur Bot-Erkennung.
 */
export async function click(tabId, target, { button = 'left' } = {}) {
  // 1. Bewege Maus natürlich zum Ziel
  const settled = await movePointer(tabId, target);

  // 2. Kurze Denkpause vor dem Klick (Menschen klicken nicht sofort)
  await sleep(randomInt(HUMAN.preClickDelayMs.min, HUMAN.preClickDelayMs.max));
  
  // 3. Mausdruck simulieren
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: settled.x,
    y: settled.y,
    button,
    clickCount: 1,
  });

  // 4. Taste kurz gehalten (nicht zu kurz = Roboter, nicht zu lang = unnatürlich)
  await sleep(randomInt(HUMAN.pressHoldMs.min, HUMAN.pressHoldMs.max));
  
  // 5. Maus loslassen
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: settled.x,
    y: settled.y,
    button,
    clickCount: 1,
  });

  // 6. Kurze Pause nach dem Klick (Menschliche Reaktionszeit)
  await sleep(randomInt(HUMAN.postReleaseMs.min, HUMAN.postReleaseMs.max));
  return settled;
}

/**
 * Gibt Text mit natürlicher Tippgeschwindigkeit ein.
 * 
 * ANTI-BOT MERKMAL:
 * Bots tippen oft alle Buchstaben mit gleicher Geschwindigkeit.
 * Menschen variieren: manche Buchstaben schneller, manche langsamer.
 * Diese Funktion simuliert diese Varianz.
 * 
 * @param {number} tabId - Die Chrome Tab-ID
 * @param {string} text - Der einzugebende Text
 * @param {{delayMs?: number}} options - Optionale feste Verzögerung (für Tests)
 */
export async function typeText(tabId, text, { delayMs = null } = {}) {
  if (!text) return;
  for (const char of String(text)) {
    // Sende einzelnen Buchstaben an Chrome
    await cdp.send(tabId, 'Input.insertText', { text: char });
    
    // Berechne Intervall: Entweder fest (für Tests) oder zufällig variabel
    const interval = delayMs != null
      ? delayMs
      : randomInt(HUMAN.keystrokeDelayMs.min, HUMAN.keystrokeDelayMs.max);
    await sleep(interval);
  }
}

/**
 * Vergisst die gespeicherte Mausposition für einen Tab.
 * 
 * Verwendung: Wenn ein Tab geschlossen wird oder die Session resettet werden muss.
 * Verhindert, dass alte Positionsdaten neue Bewegungen verfälschen.
 * 
 * @param {number} tabId - Die Chrome Tab-ID, deren State gelöscht werden soll
 */
export function forgetPointer(tabId) {
  pointerState.delete(tabId);
}

/**
 * Löscht den Inhalt eines Eingabefelds (Select-All + Backspace).
 * 
 * VERWENDUNG: Bevor neuer Text in ein bestehendes Feld eingegeben wird.
 * 
 * ANTI-BOT ASPEKT:
 * Ein Bot könnte einfach .value = '' setzen. Das ist aber unnatürlich!
 * Echte Nutzer markieren alles (Strg+A) und löschen es (Entf/Rücktaste).
 * Diese Funktion simuliert genau dieses Verhalten.
 * 
 * @param {number} tabId - Die Chrome Tab-ID
 */
export async function clearInput(tabId) {
  // Modifier 2 = Ctrl-Taste (plattformübergreifend für CDP)
  // Strg+A drücken und halten
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers });
  // Strg+A loslassen
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers });
  // Rücktaste drücken und halten
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
  // Rücktaste loslassen
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
}
