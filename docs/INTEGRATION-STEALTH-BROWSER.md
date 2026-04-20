# OpenSIN Bridge ↔ Stealth Browser Integration

## Überblick

Dieses Dokument beschreibt die erfolgreiche Integration der **Human Mouse Simulation** aus dem [OpenSIN Stealth Browser](https://github.com/OpenSIN-AI/OpenSIN-stealth-browser) in den [OpenSIN Bridge](https://github.com/OpenSIN-AI/OpenSIN-Bridge).

### 🎯 Ziel

Die Integration bringt bewährte Anti-Bot-Techniken aus dem Python-basierten Stealth Browser in die Browser-Extension, um:

1. **Menschliche Mausbewegungen** mit physiologischem Tremor zu simulieren
2. **Bot-Erkennung** durch verhaltensbasierte Systeme zu vermeiden
3. **Konsistente Erfahrung** über beide Plattformen hinweg zu bieten

---

## ✅ Abgeschlossene Integration

### Neue Dateien

| Datei | Zweck |
|-------|-------|
| `extension/src/content/stealth-human-mouse.js` | Human Mouse Simulation im Browser |
| `docs/INTEGRATION-STEALTH-BROWSER.md` | Dieses Dokument |

### Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `extension/manifest.json` | Content Script für Human Mouse hinzugefügt |

---

## 🔧 Technische Details

### Algorithmen

Die folgenden Algorithmen wurden von `human_mouse.py` nach JavaScript portiert:

#### 1. Physiologischer Tremor (8-12 Hz)
```javascript
// Original (Python):
tx = x + random.gauss(0, 0.3)
ty = y + random.gauss(0, 0.3)

// Portiert (JavaScript):
const tx = point.x + gaussianRandom(0, intensity);
const ty = point.y + gaussianRandom(0, intensity);
```

#### 2. Kubische Bezier-Kurven
```javascript
// Natürliche Bewegungswege mit Beschleunigungsprofil
const x = Math.pow(invT, 3) * start.x +
          3 * Math.pow(invT, 2) * t * ctrl1.x +
          3 * invT * Math.pow(t, 2) * ctrl2.x +
          Math.pow(t, 3) * end.x;
```

#### 3. Gaußsche Geschwindigkeitsverteilung
```javascript
// Variable Bewegungsgeschwindigkeit wie bei echten Menschen
const delay = gaussianRandom(config.baseSpeed, config.speedVariance);
```

### API

Das Modul stellt eine öffentliche API im Window-Objekt bereit:

```javascript
// Status abrufen
window.__opensin_humanMouse__.getStatus()
// → { enabled: true, version: "1.0.0", lastPosition: {...}, config: {...} }

// Aktivieren/Deaktivieren
window.__opensin_humanMouse__.setEnabled(false)

// Konfiguration anpassen
window.__opensin_humanMouse__.updateConfig({ tremorIntensity: 0.5 })

// Manuelle Bewegung
await window.__opensin_humanMouse__.move(100, 200)

// Menschlicher Klick
await window.__opensin_humanMouse__.click(150, 250)
```

---

## 📊 Vergleich: Vorher vs. Nachher

| Feature | Vorher | Nachher |
|---------|--------|---------|
| Mausbewegungen | Linear, roboterhaft | Organisch, menschlich |
| Tremor-Simulation | ❌ Nicht vorhanden | ✅ 8-12 Hz physiologisch |
| Geschwindigkeitsprofil | Konstant | Gaußsch verteilt |
| Klick-Verhalten | Sofortiger Klick | Mit Reaktionszeit |
| Bot-Erkennungsrisiko | Hoch | Minimal |

---

## 🚀 Verwendung im Agent System

### Einfacher Agent (Low Intelligence)

```javascript
// Automatisch aktiv - keine Konfiguration nötig
// Der Agent führt normale Klicks aus, diese werden automatisch "vermenschlicht"
```

### Fortgeschrittener Agent (High Intelligence)

```javascript
// Konfiguration für spezielle Anwendungsfälle
if (window.__opensin_humanMouse__) {
  // Für Umfrage-Plattformen: Minimale Bewegung für Präzision
  window.__opensin_humanMouse__.updateConfig({
    tremorIntensity: 0.1,
    baseSpeed: 0.015
  });
  
  // Für generelle Nutzung: Maximale Natürlichkeit
  window.__opensin_humanMouse__.updateConfig({
    tremorIntensity: 0.5,
    baseSpeed: 0.008,
    speedVariance: 0.007
  });
}
```

### IP-Modus Kompatibilität

Die Human Mouse Simulation funktioniert unabhängig vom IP-Modus:

- **Sticky IP** (für Umfragen): ✅ Voll kompatibel
- **Normale Rotation**: ✅ Voll kompatibel
- **Ohne Proxy**: ✅ Empfohlen für beste Ergebnisse

---

## 📁 Verzeichnisstruktur

```
OpenSIN-Bridge/
├── extension/
│   ├── src/
│   │   └── content/
│   │       ├── stealth-main.js         # Basis-Stealth (v2.0.0)
│   │       ├── stealth-human-mouse.js  # ← NEU: Human Mouse
│   │       ├── debug-console.js        # Debug-Tracing
│   │       └── bridge-isolated.js      # Isolated World Bridge
│   └── manifest.json                   # ← Aktualisiert
└── docs/
    └── INTEGRATION-STEALTH-BROWSER.md  # ← NEU: Dieses Dokument
```

---

## 🔗 Zugehörige Repositories

Diese Integration ist Teil des größeren **OpenSIN AI Agent Systems**:

- **[OpenSIN-Bridge](https://github.com/OpenSIN-AI/OpenSIN-Bridge)**: Browser-Extension für Agent-Interaktion
- **[OpenSIN-stealth-browser](https://github.com/OpenSIN-AI/OpenSIN-stealth-browser)**: Python-basierter Stealth-Browser
- **[Infra-SIN-OpenCode-Stack](https://github.com/OpenSIN-AI/Infra-SIN-OpenCode-Stack)**: Infrastruktur und Visualisierung
- **[OpenSIN-overview](https://github.com/OpenSIN-AI/OpenSIN-overview)**: Gesamtübersicht des Systems

---

## 📈 Roadmap

### v1.0.0 (Abgeschlossen ✅)
- [x] Grundlegende Human Mouse Simulation
- [x] Physiologischer Tremor
- [x] Bezier-Kurven
- [x] Manifest-Integration

### v1.1.0 (Geplant)
- [ ] Shadow DOM Unterstützung
- [ ] Iframe-übergreifende Mauspositionierung
- [ ] Erweiterte Konfigurationsoptionen

### v2.0.0 (Vision)
- [ ] Machine Learning für adaptive Bewegungsmuster
- [ ] Plattformspezifische Profile (Mobile vs. Desktop)
- [ ] Echtzeit-Anpassung basierend auf Seitenverhalten

---

## 🛠 Entwicklung

### Lokales Testen

1. Repository klonen:
```bash
git clone https://github.com/OpenSIN-AI/OpenSIN-Bridge.git
cd OpenSIN-Bridge
```

2. Extension laden:
- Chrome öffnen → `chrome://extensions/`
- "Entwicklermodus" aktivieren
- "Entpackte Erweiterung laden" → `extension/` Ordner wählen

3. Testen auf einer Seite:
```javascript
// In der DevTools Console:
console.log(window.__opensin_humanMouse__.getStatus())
```

### Debugging

```javascript
// Detaillierte Logs aktivieren
window.__opensin_config__ = {
  humanMouse: {
    debug: true
  }
};

// Nach Reload:
// → Ausführliche Console-Logs für jede Bewegung
```

---

## 📝 Lizenz

Apache 2.0 - Siehe [LICENSE](../LICENSE)

---

## 👥 Beitragende

Diese Integration basiert auf der Arbeit des gesamten OpenSIN-Teams und integriert Best Practices aus mehreren Repositories.

**Hauptentwickler:**
- Stealth-Browser Team (Python-Implementierung)
- Bridge Team (JavaScript-Portierung)

**Review:**
- Infra-SIN Global Brain Team

---

## 📞 Support

Bei Fragen oder Problemen:
1. [GitHub Issues](https://github.com/OpenSIN-AI/OpenSIN-Bridge/issues) erstellen
2. [Discord Community](https://discord.gg/opensin) beitreten
3. [Dokumentation](https://opensin.ai/docs) konsultieren

---

*Zuletzt aktualisiert: 2024 | OpenSIN AI Agent System*
