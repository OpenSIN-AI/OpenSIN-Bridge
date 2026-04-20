# 🌉 OpenSIN Bridge

> **Die ultimative Brücke zwischen AI-Agenten und echtem Chrome**  
> 🔒 Session-bound Automation | 🎭 Unsichtbar für Bot-Detektoren | ⚡ 92 RPC Tools

[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/OpenSIN-AI/OpenSIN-Bridge/releases)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Stealth](https://img.shields.io/badge/stealth-v2_success-green.svg)](docs/BENCHMARKS.md)
[![Tools](https://img.shields.io/badge/tools-92-orange.svg)](#agent-tool-surface)

---

## 📋 Inhaltsverzeichnis

- [Was ist OpenSIN Bridge?](#-was-ist-opensin-bridge)
- [Warum Bridge statt Playwright?](#-warum-bridge-statt-playwright)
- [Architektur](#-architektur)
- [Installation](#-installation)
- [Schnellstart](#-schnellstart)
- [Tool-Referenz](#-tool-referenz)
- [Stealth Layer v2](#-stealth-layer-v2)
- [Entwicklung](#-entwicklung)
- [Testing & Benchmarks](#-testing--benchmarks)
- [Integration mit OpenSIN Stealth Browser](#-integration-mit-opensin-stealth-browser)
- [Wichtige Hinweise für Entwickler](#-wichtige-hinweise-für-entwickler)

---

## 🚀 Was ist OpenSIN Bridge?

**OpenSIN Bridge** ist eine Chrome Manifest V3 Extension, die den echten Chrome-Browser eines Benutzers in einen scriptfähigen Browser für AI-Agenten verwandelt.

### 🔑 Kernmerkmale

| Feature | Beschreibung |
|---------|-------------|
| **Echte Sessions** | Nutzt echte Cookies, Passwörter, Autofill und Fingerprints |
| **92 RPC Tools** | Vollständige Kontrolle über Tabs, DOM, Cookies, Network und mehr |
| **Stealth v2** | 17-Evasion-Module neutralisieren Bot-Erkennung |
| **Multi-Transport** | WebSocket, Native Messaging, extern_connectable |
| **Session-Bound** | Perfekt für Plattformen, die Playwright/Puppeteer blockieren |

### 💡 Anwendungsfälle

- ✅ Bezahlte Umfrage-Plattformen (Session-Erhaltung)
- ✅ CRM-Automatisierung mit echten Logins
- ✅ E-Commerce Preis-Monitoring mit Account-Zugang
- ✅ Social Media Management mit echten Profilen
- ✅ Jede Plattform, die Headless-Browser erkennt und blockiert

---

## ⚔️ Warum Bridge statt Playwright?

Die meisten Agent-Browser starten ein frisches Chromium ohne Profil. Das ist perfekt für Tests, aber katastrophal für Seiten, die auf echte User-Sessions prüfen.

### Vergleichstabelle

| Dimension | Playwright/Puppeteer | **OpenSIN Bridge** |
|-----------|---------------------|-------------------|
| **Chrome Instanz** | Gespawnetes Chromium | **Echtes installiertes Chrome** |
| **Profil/Cookies/2FA** | Leer, synthetisch | **Echt, vor-authentifiziert** |
| **navigator.webdriver** | `true` (leckt!) | **`undefined` (v2 Stealth)** |
| **Headful** | Optional | **Standard — User sieht alles** |
| **Fingerprint** | Generisch | **Individuell wie echter User** |
| **Use Case** | Testing, Scraping | **Session-bound Automation** |

> **💡 WICHTIG FÜR ENTWICKLER:**  
> Diese Extension ist NICHT für hermetic testing gedacht. Dafür bleibt Playwright die bessere Wahl. Bridge ist spezialisiert auf Szenarien, wo Session-State (Cookies, Logins, History) überlebenswichtig ist.

---

## 🏗️ Architektur

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    OPEN SIN BRIDGE ARCHITEKTUR                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────┐         JSON-RPC / JWT        ┌─────────────┐│
│  │  Chrome MV3          │ <---------------------------> │  Cloudflare ││
│  │  Extension           │                               │  Workers    ││
│  │                      │                               │  API        ││
│  │  • 92 RPC Tools      │                               │             ││
│  │  • Accessibility-Tree│                               │  • Auth     ││
│  │  • Multi-Strategy    │                               │  • Rate Lim ││
│  │    Clicker (CDP→DOM) │                               │  • Tracking ││
│  │  • Stealth Layer v2  │                               │  • Stripe   ││
│  │  • Offscreen Doc     │                               └──────┬──────┘│
│  │  • Native Messaging  │                                        │      │
│  └──────────┬───────────┘                                        │      │
│             │                                                    │      │
│             │ WebSocket / Native                                 │      │
│             ▼                                                    ▼      │
│  ┌──────────────────────┐                              ┌─────────────┐│
│  │  Real User Chrome    │                              │  Supabase   ││
│  │  (Echtes Profil)     │                              │  + Stripe   ││
│  │                      │                              │             ││
│  │  • Echte Cookies     │                              │  • DB       ││
│  │  • Echte Sessions    │                              │  • Subs     ││
│  │  • Echter Fingerprint│                              │  • Usage    ││
│  └──────────────────────┘                              └─────────────┘│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Datenfluss (Schritt-für-Schritt)

1. **AI Agent** sendet JSON-RPC Request (z.B. `{"method": "dom.click", "params": {...}}`)
2. **Cloudflare Worker** validiert JWT, prüft Rate-Limits, loggt Usage
3. **WebSocket/Native Messaging** transportiert zum Chrome Extension
4. **Extension Background** routet zur richtigen Tool-Implementierung
5. **Content Script** führt Aktion im MAIN-World Kontext aus (mit Stealth v2)
6. **Ergebnis** wird zurückgemeldet mit Proof (Screenshot-Delta, DOM-Hash)

> **⚠️ ACHTUNG ENTWICKLER:**  
> Ändere NIEMALS die Reihenfolge der Stealth-Module in `stealth-main.js`. Die Idempotenz und Try-Catch-Wrap ist kritisch für die Stabilität. Jeder Fehler hier macht die gesamte Extension erkennbar!

---

## 🛠️ Installation

### Voraussetzungen

- Node.js >= 18.x
- pnpm >= 8.x (`npm install -g pnpm`)
- Chrome >= 116 (Manifest V3 Support)
- Cloudflare Account (für Server-Deployment)
- Supabase Project (für Auth/DB)

### Schritt-für-Schritt

```bash
# 1. Repository klonen
git clone https://github.com/OpenSIN-AI/OpenSIN-Bridge.git
cd OpenSIN-Bridge

# 2. Dependencies installieren
pnpm install

# 3. Environment Variables setzen
cp .env.example .env
# Bearbeite .env mit deinen Keys (SUPABASE_URL, SUPABASE_KEY, STRIPE_SECRET)

# 4. Extension im Dev-Modus laden
pnpm run ext:dev
# → Öffne chrome://extensions
# → Aktiviere "Developer Mode"
# → Klicke "Load unpacked" und wähle ./extension

# 5. Server deployen (optional für Cloud-Nutzung)
pnpm run deploy:server

# 6. Tests ausführen
pnpm test
```

### Native Messaging Host installieren (für lokale Kommunikation)

```bash
cd native-host
chmod +x install_host.sh
./install_host.sh
```

> **📝 HINWEIS:** Der Native Messaging Host ermöglicht die Kommunikation zwischen lokalen Python-Skripten und der Chrome Extension ohne WebSocket. Perfekt für lokale Agenten!

---

## 🚀 Schnellstart

### Beispiel: Login auf einer Website automatisieren

```javascript
// Beispiel: Python Agent mit WebSocket
import asyncio
import websockets
import json

async def login_agent():
    uri = "ws://localhost:8787"  # Lokaler Server oder Cloudflare URL
    async with websockets.connect(uri) as ws:
        # 1. Navigiere zur Login-Seite
        await ws.send(json.dumps({
            "type": "tool_request",
            "id": 1,
            "method": "nav.goto",
            "params": {"url": "https://example.com/login"}
        }))
        response = await ws.recv()
        print("Navigation:", response)
        
        # 2. Fülle Email-Feld aus
        await ws.send(json.dumps({
            "type": "tool_request",
            "id": 2,
            "method": "dom.type",
            "params": {
                "selector": "input[type='email']",
                "text": "user@example.com"
            }
        }))
        
        # 3. Fülle Passwort-Feld aus
        await ws.send(json.dumps({
            "type": "tool_request",
            "id": 3,
            "method": "dom.type",
            "params": {
                "selector": "input[type='password']",
                "text": "geheim123"
            }
        }))
        
        # 4. Klicke Login-Button (mit menschlicher Maus!)
        await ws.send(json.dumps({
            "type": "tool_request",
            "id": 4,
            "method": "dom.click",
            "params": {"selector": "button[type='submit']"}
        }))
        
        # 5. Warte auf Erfolg
        await asyncio.sleep(2)
        print("✅ Login abgeschlossen!")

asyncio.run(login_agent())
```

### Beispiel: Snapshot der Seite holen (Accessibility Tree)

```python
# Holt einen kompakten Snapshot der aktuellen Seite
response = await ws.send(json.dumps({
    "type": "tool_request",
    "id": 5,
    "method": "dom.snapshot",
    "params": {}
}))
# Antwort enthält kompakte AX-Tree mit Handles (@e1, @e2, ...)
# Viel kleiner als voller DOM (ca. 4KB vs 200KB+)
```

---

## 🧰 Tool-Referenz

Alle 92 Tools sind über JSON-RPC verfügbar. Hier die wichtigsten Kategorien:

### Tabs-Management

| Tool | Beschreibung | Beispiel |
|------|-------------|----------|
| `tabs.list` | Liste alle offenen Tabs | `{"method": "tabs.list"}` |
| `tabs.create` | Erstelle neuen Tab | `{"method": "tabs.create", "params": {"url": "..."}}` |
| `tabs.close` | Schließe Tab | `{"method": "tabs.close", "params": {"tabId": 123}}` |
| `tabs.activate` | Aktiviere Tab | `{"method": "tabs.activate", "params": {"tabId": 123}}` |

### Navigation

| Tool | Beschreibung | Beispiel |
|------|-------------|----------|
| `nav.goto` | Navigiere zu URL | `{"method": "nav.goto", "params": {"url": "..."}}` |
| `nav.back` | Zurück | `{"method": "nav.back"}` |
| `nav.reload` | Neu laden | `{"method": "nav.reload"}` |
| `nav.waitForLoad` | Warte auf Load-Event | `{"method": "nav.waitForLoad"}` |

### DOM-Interaktion (HERZSTÜCK!)

| Tool | Beschreibung | Besonderheit |
|------|-------------|--------------|
| `dom.click` | Klicke Element | **3-Stage Fallback:** CDP → DOM.click() → MouseEvent |
| `dom.type` | Tippe Text | Mit menschlichen Verzögerungen |
| `dom.fill` | Fülle Formular | Smart Field Detection |
| `dom.hover` | Hover über Element | Für Dropdown-Menüs |
| `dom.scroll` | Scrolle Seite | Pixel-genau |
| `dom.snapshot` | Hole AX-Tree | Kompakt, mit Handles |
| `dom.evaluate` | JS ausführen | Im Page-Kontext |

> **💡 WICHTIG:** Der `dom.click` verwendet eine intelligente 3-Stufen-Strategie:
> 1. **CDP Mouse Input** (echte Mausbewegung via Chrome Debugger Protocol)
> 2. **DOM click()** (Fallback wenn CDP blockiert ist)
> 3. **MouseEvent Dispatch** (letzter Ausweg)
> 
> Jeder Klick wird verifiziert durch DOM-Diff-Hash und optional Screenshot-Delta.
> **Kein false positive!** Wenn die Seite nicht reagiert, bekommst du ehrliches Feedback.

### Cookies & Storage

| Tool | Beschreibung |
|------|-------------|
| `cookies.get` | Hole Cookies für Domain |
| `cookies.set` | Setze Cookie |
| `cookies.getAll` | Alle Cookies |
| `storage.local.get` | LocalStorage lesen |
| `storage.session.set` | SessionStorage schreiben |

### Network

| Tool | Beschreibung |
|------|-------------|
| `net.fetch` | HTTP Request ausführen |
| `net.setUserAgent` | User-Agent ändern |
| `net.block` | Ressourcen blocken (Ads, Tracker) |
| `net.captureStart` | Network-Traffic mitschneiden |

### Vision (OCR & Element-Lokalisierung)

| Tool | Beschreibung |
|------|-------------|
| `vision.locate` | Finde Element per Bilderkennung |
| `vision.read` | OCR Texterkennung |

### Behavior Recording

| Tool | Beschreibung |
|------|-------------|
| `behavior.start` | Starte Aufnahme |
| `behavior.stop` | Stoppe Aufnahme |
| `behavior.export` | Exportiere Timeline |

---

## 🎭 Stealth Layer v2

Das Herzstück der Unsichtbarkeit. 17 Evasion-Module laufen als MAIN-World Content Script bei `document_start`.

### Abgedeckte Fingerprints

| Kategorie | Module | Status |
|-----------|--------|--------|
| **Navigator** | `webdriver`, `plugins`, `mimeTypes`, `languages` | ✅ |
| **Hardware** | `hardwareConcurrency`, `deviceMemory` | ✅ |
| **Permissions** | `permissions.query` | ✅ |
| **Media** | `mediaDevices`, `getBattery`, `connection` | ✅ |
| **Chrome Runtime** | `window.chrome.runtime` | ✅ |
| **Window Size** | `outerWidth`, `outerHeight` | ✅ |
| **iFrames** | `HTMLIFrameElement.contentWindow` | ✅ |
| **WebGL** | `getParameter` (Vendor/Renderer Spoof) | ✅ |
| **Canvas** | `toDataURL`, `getImageData` (Micro-Noise) | ✅ |
| **AudioContext** | `getChannelData` (Micro-Noise) | ✅ |
| **Function.toString** | Proxy-preserved native signature | ✅ |

### So funktioniert's

Jedes Modul ist:
- **Idempotent:** Kann mehrfach ausgeführt werden ohne Seiteneffekte
- **Try-Catch-gewrappt:** Ein Fehler stoppt nicht den gesamten Stealth
- **Introspektierbar:** `window.__opensin_stealth_status__()` gibt Status zurück

### Testing gegen Bot-Detektoren

```bash
# 1. Extension bauen und laden
pnpm run ext:dev

# 2. Test-Seite öffnen
# Gehe zu: https://bot.sannysoft.com

# 3. Probe-Script in DevTools Console einfügen
# Datei: test/stealth/sannysoft-probe.js

# 4. Alle Checks müssen PASS melden!
```

> **⚠️ KRITISCH FÜR ENTWICKLER:**  
> Teste JEDE Änderung an Stealth-Modulen gegen mindestens 3 Detektoren:
> - https://bot.sannysoft.com
> - https://abrahamjuliot.github.io/creepjs/
> - https://pixelscan.net
> 
> Dokumentiere Ergebnisse in `docs/BENCHMARKS.md`. Ohne Benchmark-Update kein Merge!

---

## 👨‍💻 Entwicklung

### Projektstruktur

```
OpenSIN-Bridge/
├── extension/                 # Chrome MV3 Extension
│   ├── manifest.json          # ⚠️ ACHTUNG: CSP muss proxy + DNR erlauben!
│   ├── icons/
│   └── src/
│       ├── background/        # Service Worker (Hirn der Extension)
│       ├── content/           # Content Scripts
│       │   ├── bridge-isolated.js  # RPC Handler (isolated world)
│       │   ├── stealth-main.js     # 🎭 Stealth v2 (MAIN world!)
│       │   └── stealth-legacy.js   # v1 Shim (Rollback)
│       ├── core/              # Config, Logger, Errors, RPC
│       ├── drivers/           # Tabs, CDP, Offscreen
│       ├── automation/        # Human, Clicker, Typer, Snapshot
│       ├── tools/             # 92 Tool-Implementierungen
│       ├── transports/        # WebSocket, Native, External
│       └── shared/            # Deterministische Primitives
├── native-host/               # Python Native Messaging Host
├── server.js                  # WebSocket Relay (Cloudflare)
├── docs/                      # Dokumentation
├── test/                      # Testsuite
└── scripts/                   # Build & Deploy
```

### Wichtige Entwicklungsregeln

1. **NIEMALS** im default Branch arbeiten! Immer Issue-Worktrees nutzen:
   ```bash
   pnpm run issue:worktree -- --issue 42 --branch feature/mein-feature
   ```

2. **IMMER** Tests schreiben bevor Code geändert wird (Test-Driven Development)

3. **IMMER** Benchmarks aktualisieren bei Stealth-Änderungen

4. **NIEMALS** Secrets committen! `.env` steht in `.gitignore`

5. **IMMER** Comments hinzufügen! Andere Entwickler sind oft dumm und kaputtmachen ist leicht.

### Nützliche Commands

```bash
# Extension im Dev-Modus laden
pnpm run ext:dev

# Stealth Unit Tests
pnpm run test:stealth

# Alle Tests
pnpm test

# Extension packen (für Chrome Web Store)
pnpm run ext:package

# Server deployen
pnpm run deploy:server

# Issue-Worktree erstellen
pnpm run issue:worktree -- --issue <NUMMER>

# Scope-Verification
pnpm run verify:issue-scope -- <DATEIEN>
```

---

## 🧪 Testing & Benchmarks

### Test-Suites

| Suite | Beschreibung | Command |
|-------|-------------|---------|
| **Stealth v2** | Unit-Tests für Stealth-Module | `pnpm run test:stealth` |
| **Bridge Contract** | Tool-API-Verifikation | `pnpm run test:contract` |
| **Behavior Timeline** | Recording/Playback-Tests | `pnpm run test:behavior` |
| **Native Host** | Python-Host-Integration | `pnpm run test:native` |
| **Issue Worktree** | Isolationstests | `pnpm run test:issue-worktree` |

### Benchmark-Prozedur

Siehe [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) für detaillierte Anleitung.

**Kurzversion:**

1. Extension bauen und installieren
2. Test-Seiten besuchen (sannysoft, creepjs, pixelscan)
3. Probe-Scripts in DevTools ausführen
4. Ergebnisse in `docs/BENCHMARKS.md` dokumentieren
5. Nur mergen wenn ALLE Tests grün!

---

## 🔗 Integration mit OpenSIN Stealth Browser

OpenSIN Bridge und OpenSIN Stealth Browser teilen sich dieselben Algorithmen für menschliche Interaktionen.

### Gemeinsame Features

| Feature | Bridge (JS) | Stealth Browser (Python) |
|---------|-------------|-------------------------|
| **Bezier-Kurven** | ✅ `automation/human.js` | ✅ `input/human_mouse.py` |
| **Physiologischer Tremor** | ✅ ±0.4px Jitter | ✅ ±0.4px Jitter |
| **Variable Geschwindigkeit** | ✅ Gauss-Verteilung | ✅ Gauss-Verteilung |
| **3-Stage Clicker** | ✅ CDP → DOM → Dispatch | ✅ Vision → DOM → JS-Force |
| **Smart Frame Scan** | ✅ Iframe-Rekursion | ✅ Iframe-Rekursion |

### Code-Beispiel: Gleiche Algorithmen in beiden Sprachen

**JavaScript (Bridge):**
```javascript
// extension/src/automation/human.js
function applyPhysiologicTremor(points) {
    return points.map((p, i) => {
        if (i === 0 || i === points.length - 1) return p;
        return {
            x: p.x + (Math.random() - 0.5) * 0.8,
            y: p.y + (Math.random() - 0.5) * 0.8
        };
    });
}
```

**Python (Stealth Browser):**
```python
# input/human_mouse.py
def _apply_physiologic_tremor(pts):
    vibrated = []
    for i, (x, y) in enumerate(pts):
        if i == 0 or i == len(pts) - 1:
            vibrated.append((x, y))
            continue
        tx = x + random.uniform(-0.4, 0.4)
        ty = y + random.uniform(-0.4, 0.4)
        vibrated.append((tx, ty))
    return vibrated
```

> **💡 SYNERGIE:** Beide Projekte profitieren voneinander! Verbesserungen an einem Algorithmus sollten immer in BOTH Repositories eingespielt werden. Siehe [`docs/INTEGRATION-STEALTH-BROWSER.md`](docs/INTEGRATION-STEALTH-BROWSER.md).

---

## ⚠️ Wichtige Hinweise für Entwickler

### 🔴 DOs (Unbedingt beachten!)

✅ **IMMER ausführliche Kommentare schreiben**  
Andere Entwickler verstehen sonst den Code nicht und machen alles kaputt.

✅ **IMMER Issue-Worktrees nutzen**  
Nie direkt auf `main` committen!  
```bash
pnpm run issue:worktree -- --issue 42 --branch feature/xyz
```

✅ **IMMER Tests vor Änderungen schreiben**  
Test-Driven Development verhindert Regressionen.

✅ **IMMER Benchmarks bei Stealth-Änderungen updaten**  
Dokumentiere in `docs/BENCHMARKS.md`.

✅ **IMMER Secrets in `.env` lagern**  
Nie `.env` committen! Steht in `.gitignore`.

### 🔴 DON'Ts (Auf keinen Fall!)

❌ **NIEMALS Stealth-Modul-Reihenfolge ändern**  
Die Idempotenz ist kritisch!

❌ **NIEMALS `headless: true` verwenden**  
Sofortige Erkennung! Bridge braucht zwingend headful.

❌ **NIEMALS CDP-Attach ohne Stealth v2**  
Der Debugger hinterlässt Fingerabdrücke.

❌ **NIEMALS ohne Tests mergen**  
Auch kleine Änderungen brechen unerwartet Dinge.

❌ **NIEMALS `.env` committen**  
GitGuardian scannt automatisch und blockt Commits.

---

## 📄 License

**Proprietary. All rights reserved.**

Der Server-seitige Code ist Trade-Secret-Material und nicht öffentlich zugänglich.  
Die Extension-Quellen sind für Kunden unter NDA einsehbar.

---

## 🌟 Contributors

Dieses Projekt ist Teil des **OpenSIN AI Ökosystems**:

- **[OpenSIN Overview](https://github.com/OpenSIN-AI/OpenSIN-overview)** – Zentrale Übersicht
- **[OpenSIN Stealth Browser](https://github.com/OpenSIN-AI/OpenSIN-stealth-browser)** – Python-basierter Stealth-Browser
- **[Infra-SIN Global Brain](https://github.com/OpenSIN-AI/Infra-SIN-Global-Brain)** – Zentrale AI-Orchestrierung

---

## 📞 Support & Kontakt

- **Issues:** https://github.com/OpenSIN-AI/OpenSIN-Bridge/issues
- **Discord:** [Link einfügen]
- **Email:** support@opensin.ai

---

<div align="center">

**Made with ❤️ by the OpenSIN Team**

[![Stars](https://img.shields.io/github/stars/OpenSIN-AI/OpenSIN-Bridge?style=social)](https://github.com/OpenSIN-AI/OpenSIN-Bridge/stargazers)
[![Forks](https://img.shields.io/github/forks/OpenSIN-AI/OpenSIN-Bridge?style=social)](https://github.com/OpenSIN-AI/OpenSIN-Bridge/network/members)

</div>
