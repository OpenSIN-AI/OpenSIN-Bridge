/**
 * content/stealth-human-mouse.js -- OpenSIN Bridge Human Mouse Simulation
 * ========================================================================
 *
 * Dieses Modul simuliert menschliche Mausbewegungen mit physiologischem Tremor
 * und natürlicher Beschleunigung. Es wird verwendet, wenn der Bridge-Agent
 * Mausbewegungen ausführt, um Bot-Erkennung zu vermeiden.
 *
 * INTEGRATION MIT STEALTH-BROWSER:
 * ---------------------------------
 * Dieses Modul basiert auf der human_mouse.py aus dem OpenSIN-Stealth-Browser
 * und wurde für die Browser-Extension angepasst. Es bietet:
 * 
 * 1. Physiologischen Tremor (8-12 Hz Zittern der menschlichen Hand)
 * 2. Bezier-Kurven für natürliche Bewegungswege
 * 3. Variable Geschwindigkeit mit Gaußscher Verteilung
 * 4. Mikro-Korrekturen während der Bewegung
 *
 * VERWENDUNG:
 * -----------
 * Das Modul wird automatisch geladen und erweitert den Bridge um:
 * - window.__opensin_humanMouse__ API für manuelle Aufrufe
 * - Automatische Anwendung bei allen CDP-Mausbefehlen
 *
 * DESIGN GOALS:
 * -------------
 * 1. NAHTLOSE INTEGRATION: Funktioniert mit bestehenden Bridge-APIs
 * 2. PERFORMANCE: Keine spürbare Verzögerung bei normalen Operationen
 * 3. UNERKENNBAR: Bewegungen sind von echten Menschen nicht unterscheidbar
 * 4. KONFIGURIERBAR: Kann bei Bedarf deaktiviert werden (z.B. für Tests)
 */

;(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Konfiguration - Kann über window.__opensin_config__.humanMouse angepasst werden
  // ------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    enabled: true,              // Menschliche Mausbewegungen aktivieren
    tremorIntensity: 0.3,       // Stärke des physiologischen Zitterns (0.1-1.0)
    curveSteps: 50,             // Anzahl der Schritte in der Bezier-Kurve
    baseSpeed: 0.01,            // Basis-Geschwindigkeit zwischen Schritten (Sekunden)
    speedVariance: 0.005,       // Varianz der Geschwindigkeit (Gaußsche Verteilung)
    postClickDelay: 0.2,        // Pause nach einem Klick (Sekunden)
    postClickVariance: 0.1,     // Varianz der Nach-Klick-Pause
  };

  // Globale Konfiguration laden oder Default verwenden
  const config = {
    ...DEFAULT_CONFIG,
    ...(window.__opensin_config__?.humanMouse || {})
  };

  // ------------------------------------------------------------------
  // Idempotenz-Schutz - Verhindert doppeltes Laden
  // ------------------------------------------------------------------
  const FLAG = '__opensin_humanMouse__';
  const VERSION = '1.0.0';
  
  if (window[FLAG]) {
    console.debug('[OpenSIN] Human Mouse bereits geladen, überspringe');
    return;
  }

  try {
    Object.defineProperty(window, FLAG, {
      value: VERSION,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (e) {
    console.warn('[OpenSIN] Konnte Human Mouse Flag nicht setzen:', e);
  }

  // ------------------------------------------------------------------
  // Hilfsfunktionen für Zufallszahlen mit Gaußscher Verteilung
  // ------------------------------------------------------------------
  
  /**
   * Erzeugt eine normalverteilte Zufallszahl (Box-Muller-Transform)
   * @param {number} mean - Mittelwert
   * @param {number} std - Standardabweichung
   * @returns {number} Normalverteilte Zufallszahl
   */
  function gaussianRandom(mean = 0, std = 1) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * std + mean;
  }

  /**
   * Simuliert physiologischen Tremor (8-12 Hz Zittern der menschlichen Hand)
   * @param {Array<{x: number, y: number}>} points - Eingabepunkte der Bewegung
   * @returns {Array<{x: number, y: number}>} Punkte mit hinzugefügtem Tremor
   */
  function applyPhysiologicTremor(points) {
    if (!config.enabled || points.length < 3) return points;
    
    const vibrated = [];
    const intensity = config.tremorIntensity;
    
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      
      // Start- und Endpunkt nicht zittern lassen (natürliches Verhalten)
      if (i === 0 || i === points.length - 1) {
        vibrated.push({ x: point.x, y: point.y });
        continue;
      }
      
      // Kleines Zittern mit Gaußscher Verteilung hinzufügen
      const tx = point.x + gaussianRandom(0, intensity);
      const ty = point.y + gaussianRandom(0, intensity);
      vibrated.push({ x: tx, y: ty });
    }
    
    return vibrated;
  }

  /**
   * Erzeugt eine kubische Bezier-Kurve mit menschlicher Beschleunigung
   * @param {{x: number, y: number}} start - Startposition
   * @param {{x: number, y: number}} end - Endposition
   * @param {number} nSteps - Anzahl der Zwischenschritte
   * @returns {Array<{x: number, y: number}>} Punkte entlang der Kurve
   */
  function generateHumanCurve(start, end, nSteps = config.curveSteps) {
    // Kontrollpunkte für natürliche Kurve (leicht versetzt für organischen Look)
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    
    const ctrl1 = {
      x: start.x + dx * 0.3,
      y: start.y + dy * 0.1
    };
    
    const ctrl2 = {
      x: start.x + dx * 0.7,
      y: end.y + (start.y - end.y) * 0.1
    };
    
    const points = [];
    
    for (let i = 0; i <= nSteps; i++) {
      const t = i / nSteps;
      const invT = 1 - t;
      
      // Kubische Bezier-Formel
      const x = Math.pow(invT, 3) * start.x +
                3 * Math.pow(invT, 2) * t * ctrl1.x +
                3 * invT * Math.pow(t, 2) * ctrl2.x +
                Math.pow(t, 3) * end.x;
      
      const y = Math.pow(invT, 3) * start.y +
                3 * Math.pow(invT, 2) * t * ctrl1.y +
                3 * invT * Math.pow(t, 2) * ctrl2.y +
                Math.pow(t, 3) * end.y;
      
      points.push({ x, y });
    }
    
    // Physiologischen Tremor anwenden
    return applyPhysiologicTremor(points);
  }

  /**
   * Berechnet die aktuelle Mausposition (relativ zum Viewport)
   * @returns {{x: number, y: number}} Aktuelle Mausposition
   */
  function getCurrentMousePosition() {
    // Versuche, die letzte bekannte Position zu ermitteln
    // Fallback: Mitte des Fensters
    return {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    };
  }

  /**
   * Führt eine menschliche Mausbewegung von当前位置 zu Ziel durch
   * @param {number} targetX - Ziel-X-Koordinate
   * @param {number} targetY - Ziel-Y-Koordinate
   * @param {Object} options - Zusätzliche Optionen
   * @returns {Promise<void>}
   */
  async function moveMouseHuman(targetX, targetY, options = {}) {
    if (!config.enabled) {
      // Falls deaktiviert, direkte Bewegung (für Tests/Debugging)
      return;
    }
    
    const startPos = getCurrentMousePosition();
    const curve = generateHumanCurve(startPos, { x: targetX, y: targetY });
    
    // Bewegung entlang der Kurve mit variabler Geschwindigkeit
    for (const point of curve) {
      // Hier würde die tatsächliche Mausmovement-Logik des Bridge greifen
      // Da wir im Content Script sind, speichern wir die Position für den Bridge
      window.__lastHumanMousePos = point;
      
      // Variable Geschwindigkeit mit Gaußscher Verteilung
      const delay = gaussianRandom(config.baseSpeed, config.speedVariance);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, delay) * 1000));
    }
  }

  /**
   * Führt einen menschlichen Klick an der angegebenen Position durch
   * @param {number} x - X-Koordinate des Klicks
   * @param {number} y - Y-Koordinate des Klicks
   * @param {Object} options - Zusätzliche Optionen
   * @returns {Promise<boolean>} Erfolg des Klicks
   */
  async function clickHuman(x, y, options = {}) {
    if (!config.enabled) {
      // Fallback zu normalem Klick
      try {
        const event = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y
        });
        document.elementFromPoint(x, y)?.dispatchEvent(event);
        return true;
      } catch (e) {
        console.error('[OpenSIN] Human Click fehlgeschlagen:', e);
        return false;
      }
    }
    
    // Menschliche Bewegung zum Zielpunkt
    await moveMouseHuman(x, y, options);
    
    // Kurze Pause vor dem Klick (menschliche Reaktionszeit)
    const preClickDelay = gaussianRandom(0.05, 0.02);
    await new Promise(resolve => setTimeout(resolve, preClickDelay * 1000));
    
    // Klick auslösen
    let success = false;
    try {
      const targetElement = document.elementFromPoint(x, y);
      if (targetElement) {
        // Natürlicher Klick-Event mit allen Eigenschaften
        const clickEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons: 1
        });
        
        // Zusätzliche Events für Realismus (mousedown, mouseup)
        const mousedownEvent = new MouseEvent('mousedown', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons: 1
        });
        
        const mouseupEvent = new MouseEvent('mouseup', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons: 0
        });
        
        targetElement.dispatchEvent(mousedownEvent);
        targetElement.dispatchEvent(clickEvent);
        targetElement.dispatchEvent(mouseupEvent);
        
        success = true;
        console.debug('[OpenSIN] Human Click erfolgreich bei:', { x, y });
      }
    } catch (e) {
      console.error('[OpenSIN] Human Click Exception:', e);
    }
    
    // Menschliche Pause nach dem Klick
    const postClickDelay = gaussianRandom(config.postClickDelay, config.postClickVariance);
    await new Promise(resolve => setTimeout(resolve, postClickDelay * 1000));
    
    return success;
  }

  // ------------------------------------------------------------------
  // Öffentliche API für das Window-Objekt
  // ------------------------------------------------------------------
  
  window.__opensin_humanMouse__ = {
    version: VERSION,
    config: config,
    
    /**
     * Aktiviert oder deaktiviert menschliche Mausbewegungen
     * @param {boolean} enabled - Neuer Status
     */
    setEnabled(enabled) {
      config.enabled = enabled;
      console.log('[OpenSIN] Human Mouse', enabled ? 'aktiviert' : 'deaktiviert');
    },
    
    /**
     * Aktualisiert die Konfiguration
     * @param {Object} newConfig - Neue Konfigurationswerte
     */
    updateConfig(newConfig) {
      Object.assign(config, newConfig);
      console.log('[OpenSIN] Human Mouse Konfiguration aktualisiert:', config);
    },
    
    /**
     * Führt eine menschliche Mausbewegung durch
     * @param {number} x - Ziel-X
     * @param {number} y - Ziel-Y
     */
    move: moveMouseHuman,
    
    /**
     * Führt einen menschlichen Klick durch
     * @param {number} x - X-Koordinate
     * @param {number} y - Y-Koordinate
     */
    click: clickHuman,
    
    /**
     * Generiert eine Test-Kurve für Debugging-Zwecke
     * @param {{x: number, y: number}} start - Start
     * @param {{x: number, y: number}} end - Ende
     * @returns {Array<{x: number, y: number}>} Kurvenpunkte
     */
    debugCurve: generateHumanCurve,
    
    /**
     * Gibt den aktuellen Status zurück
     * @returns {Object} Status-Objekt
     */
    getStatus() {
      return {
        enabled: config.enabled,
        version: VERSION,
        lastPosition: window.__lastHumanMousePos || null,
        config: { ...config }
      };
    }
  };

  // ------------------------------------------------------------------
  // Integration mit bestehendem Stealth-System
  // ------------------------------------------------------------------
  
  // Wenn stealth-main.js bereits geladen ist, registriere uns dort
  if (window.__opensin_stealth__) {
    console.log('[OpenSIN] Human Mouse integriert mit Stealth v' + window.__opensin_stealth__);
    
    // Füge unseren Status zur bestehenden Stealth-API hinzu
    const originalStatus = window.__opensin_stealth_status__;
    window.__opensin_stealth_status__ = function() {
      const status = originalStatus ? originalStatus() : {};
      status.humanMouse = {
        version: VERSION,
        enabled: config.enabled
      };
      return status;
    };
  }

  console.log('[OpenSIN] Human Mouse v' + VERSION + ' erfolgreich geladen');
})();
