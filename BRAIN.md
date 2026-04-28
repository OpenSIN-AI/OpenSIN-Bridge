# BRAIN.md — OpenSIN Bridge Knowledge Base

> **⚠️ DEPRECATED — 28. April 2026, 22:30**
> Die Bridge-Extension wird NICHT mehr verwendet.
> Ersetzt durch: **computer-use-mcp** (domdomegg/computer-use-mcp, MIT)
> Siehe: `/Users/jeremy/dev/A2A-SIN-Worker-heypiggy/BRAIN.md` Section 1

---

## Warum deprecated?

Die Bridge hatte 4 fundamentale Bugs:
1. Content-Script Crash (`stealth-human-mouse.js` writable:false)
2. `router(msg)` statt `router.invoke()` (Object vs Function)
3. Falsches Response-Format (`jsonrpc:2.0` statt `type:tool_response`)
4. `@ant/computer-use-swift` + `@ant/computer-use-input` — Anthropic-intern, nicht öffentlich

**computer-use-mcp** löst ALLE diese Probleme:
- Keine Chrome Extension nötig
- Keine kaputten Transport-Dateien
- Kein WebSocket-Protokoll
- Direktes MCP-Protokoll (JSON-RPC über stdin/stdout)
- native nut.js für Maus/Keyboard/Screenshot
- MIT-Lizenz, Open Source

---

## 1. Architektur

```
Chrome Extension (v5.0.0) ──WebSocket──→ Bridge Server (v2.9.2, Port 7777) ──HTTP──→ Worker
        │                                       │
  src/background/                         server.js
  service-worker.js                       /mcp (HTTP)
        │                                  /health
  transports/ws.js ──→ ws://localhost:7777/extension
```

---

## 2. Extension laden (MV3)

1. Chrome → `chrome://extensions/`
2. Developer Mode aktivieren
3. "Entpackte Erweiterung laden"
4. Ordner: `/Users/jeremy/dev/OpenSIN-Bridge/extension/`

**Fehler "Service worker registration failed. Status code: 3":**
→ 4 Dateien fehlen standardmäßig und müssen ERSTELLT werden:

```
src/transports/ws.js          ← WebSocket Transport (mit Keep-Alive-Ping alle 60s)
src/transports/external.js    ← External Messaging Stub
src/transports/native.js      ← Native Messaging Stub
src/tools/behavior.js         ← Behavior Tools Stub
```

---

## 3. Server starten

```bash
cd /Users/jeremy/dev/OpenSIN-Bridge
PORT=7777 node server.js
```

Gesundheitscheck:
```bash
curl http://localhost:7777/health
# → {"status":"ok","extensionConnected":true,"toolsCount":91}
```

---

## 4. Bridge per curl steuern (1 Command = 1 Aktion)

```bash
# Navigieren
curl -s http://localhost:7777/mcp -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"navigate","arguments":{"url":"https://heypiggy.com"}},"id":1}'

# Screenshot
curl -s http://localhost:7777/mcp -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"screenshot"},"id":2}'

# Klick
curl -s http://localhost:7777/mcp -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"click_element","arguments":{"selector":".survey-item"}},"id":3}'

# Text eingeben
curl -s http://localhost:7777/mcp -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"type_text","arguments":{"selector":"input","text":"Hello"}},"id":4}'

# JavaScript ausführen
curl -s http://localhost:7777/mcp -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"execute_script","arguments":{"script":"document.title"}},"id":5}'
```

---

## 5. Bekannte Fehler & Fixes

| Fehler | Ursache | Fix |
|--------|---------|-----|
| Service worker Status code: 3 | Transport-Dateien fehlen | `ws.js`, `external.js`, `native.js`, `behavior.js` erstellen |
| "Extension disconnected" trotz `extensionConnected:true` | Keep-Alive-Ping fehlt (>90s) | ws.js sendet alle 60s `{"method":"ping"}` |
| WebSocket connected, kein Ping | `initLifecycle` hat keinen WebSocket-Ping — nur SW-Wakeup | ws.js `onopen` → `setInterval` Ping |
| HF Spaces Bridge zeigt `extensionConnected: null` | Extension verbindet zu localhost, nicht HF Spaces | Extension Config auf `wss://openjerro-...` ändern ODER lokalen Server starten |

---

## 6. Environment

```bash
# Lokaler Bridge Server
PORT=7777 node server.js                         # HTTP auf :7777, WS auf :7777/extension

# ODER: HF Spaces (Cloud)
BRIDGE_MCP_URL=https://openjerro-opensin-bridge-mcp.hf.space/mcp
```

**Default der Extension:** `ws://localhost:7777/extension` (config.js Zeile 39)

---

## 7. Heute erstellte/gefixte Dateien

```
✅ src/transports/ws.js          — WebSocket + 60s Keep-Alive-Ping
✅ src/transports/external.js    — External messaging stub
✅ src/transports/native.js      — Native messaging stub
✅ src/tools/behavior.js         — Behavior tools stub
✅ src/core/lifecycle.js         — behavior-store-Import auskommentiert
```

---

## 8. ABHÄNGIGKEIT: Heypiggy Worker

Der `A2A-SIN-Worker-heypiggy` nutzt die Bridge via `BRIDGE_MCP_URL`.

**Wichtig:** Ohne Extension läuft GAR NICHTS. Der Worker macht HTTP-Calls an die Bridge, die Bridge leitet per WebSocket an die Extension, die Extension führt in Chrome aus.

```
Worker → curl http://localhost:7777/mcp → Bridge Server → WebSocket → Extension → Chrome
```

---

*Letzte Aktualisierung: 28. April 2026*
