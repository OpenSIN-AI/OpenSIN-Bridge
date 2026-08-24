# OpenSIN Session Export Schema

## Why this exists

OpenSIN now captures **fetch** and **XMLHttpRequest** in the page's **MAIN world** at `document_start`, then exports those correlated events through a stable JSON schema for replay and inference tooling.

This is intentionally layered on top of the existing `chrome.webRequest` metadata logging in `extension/background/service_worker.js`.

- **MAIN-world injector** captures application-layer intent and bounded payload previews.
- **`chrome.webRequest`** continues to capture browser-observed transport metadata.
- **The export schema** keeps both views in one deterministic session file so downstream tooling can correlate them without guessing.

## Capture path

1. `extension/content/injector.js` loads in `world: "MAIN"` at `document_start`.
2. The injector monkey-patches `window.fetch` and `XMLHttpRequest.prototype` immediately.
3. For each request lifecycle stage (`request`, `response`, `error`), the injector sends a `NETWORK_EVENT` message to the MV3 service worker.
4. `extension/background/service_worker.js` validates the message shape, stores MAIN-world network events, and keeps the existing `chrome.webRequest` log intact.
5. `export_recorded_session` returns a stable session export assembled by `extension/shared/session-export.mjs`.

## Export contract

```json
{
  "schemaVersion": "opensin.session-export/v1",
  "generatedAt": "2026-04-10T12:00:00.000Z",
  "session": {
    "id": "session-1700000000000",
    "startedAt": "2026-04-10T11:59:50.000Z",
    "exportedAt": "2026-04-10T12:00:00.000Z",
    "tabId": 41,
    "frameUrl": "https://app.example/dashboard"
  },
  "compatibility": {
    "rrweb": {
      "strategy": "custom-plugin-event",
      "plugin": "opensin.network"
    },
    "chromeDevToolsRecorder": {
      "strategy": "network-step-mirror"
    }
  },
  "events": [
    {
      "eventId": "network-fetch-123-request-0",
      "timestamp": 1700000000001,
      "category": "network",
      "source": "main-world",
      "api": "fetch",
      "phase": "request",
      "requestId": "fetch-123",
      "correlationKey": "POST https://api.example/tasks",
      "method": "POST",
      "url": "https://api.example/tasks",
      "tabId": 41,
      "frameUrl": "https://app.example/dashboard",
      "durationMs": null,
      "request": {
        "bodyKind": "json",
        "bodyLength": 17,
        "bodyPreview": "{"task":"open"}",
        "headers": {
          "content-type": "application/json"
        }
      },
      "response": {
        "status": null,
        "ok": null,
        "statusText": null,
        "bodyKind": null,
        "bodyLength": null,
        "bodyPreview": "",
        "headers": {}
      },
      "error": null,
      "rrweb": {
        "type": "plugin",
        "plugin": "opensin.network",
        "data": {
          "requestId": "fetch-123",
          "phase": "request",
          "api": "fetch",
          "method": "POST",
          "url": "https://api.example/tasks",
          "tabId": 41,
          "frameUrl": "https://app.example/dashboard"
        }
      },
      "devtoolsRecorder": {
        "type": "network",
        "requestId": "fetch-123",
        "phase": "request",
        "method": "POST",
        "url": "https://api.example/tasks",
        "status": null
      }
    }
  ],
  "summary": {
    "totalEvents": 3,
    "mainWorldNetworkEvents": 2,
    "webRequestEvents": 1
  }
}
```

## Compatibility choice

OpenSIN keeps its own **stable top-level session object** and embeds compatibility mirrors instead of pretending to be a native rrweb export or a native DevTools Recorder file.

That trade-off is deliberate:

- **rrweb compatibility** comes from the per-event `rrweb` plugin envelope.
- **Chrome DevTools Recorder compatibility** comes from the per-event `devtoolsRecorder` mirror.
- **OpenSIN stability** comes from keeping the canonical event fields (`requestId`, `phase`, `request`, `response`, `error`) under our direct control.

This gives downstream replay/inference code one deterministic source of truth while still making adapters to rrweb-style and Recorder-style pipelines straightforward.

## Tooling surface

### `get_network_correlation_events`
Returns the bounded MAIN-world network capture buffer.

### `export_recorded_session`
Builds and returns the canonical session export schema. Optional inputs:

- `sessionId`
- `startedAt`
- `tabId`
- `frameUrl`
- `networkCount`
- `webRequestCount`

## Privacy and bounds

The injector only exports **bounded previews**, not unlimited bodies.

- Request/response text previews are truncated.
- Headers are normalized into JSON-safe plain objects.
- Missing or unreadable bodies are represented explicitly as unavailable/null instead of guessed.
- Existing `chrome.webRequest` logging remains metadata-oriented and is not replaced.

## Validation

Run:

```bash
npm test
```

Current targeted coverage:

- MAIN-world fetch request/response capture
- MAIN-world XHR request/response capture
- stable session export schema generation
- rrweb / DevTools Recorder compatibility mirrors
