# Debug Tracing

> `tools/debug.*` + `content/debug-console.js` — per-step visibility into
> what the agent is actually doing inside the browser.

## Motivation

Before this module shipped, a failing agent (for example the HeyPiggy
survey worker in issue #61 of the Worker repo) produced a log like:

```
dom.click  ok
dom.click  ok
dom.click  ok   <-- but what actually changed? did the page navigate?
                    did a modal intercept? did the page throw in console?
```

There was no structured signal of *what the browser did* in response to
each tool call, so every investigation started with a live reproduction
over Zoom. `tools/debug.*` closes that gap by capturing, for each call:

- URL, title, lightweight DOM fingerprint before and after
- Diff (URL changed? body changed? N new interactive elements?)
- Full `console.error` / `console.warn` / `window.onerror` /
  `unhandledrejection` entries that landed during the inner call
- Optional before/after screenshots (base64 JPEG)

All records are stored in `chrome.storage.session`, so they survive the
MV3 service worker being suspended but are cleared when the browser
restarts.

## Tools

### `debug.startSession({ label })`

Opens a named trace session and returns `{ sessionId }`. Typical use:
one session per agent run.

### `debug.traceAction({ sessionId, operation, tabId, screenshot, metadata })`

Wraps an arbitrary inner router call. The inner call is expressed as
`operation = { name, args }`:

```js
await bridge.call("debug.traceAction", {
  sessionId,
  operation: { name: "dom.click", args: { selector: "div.survey-item" } },
  screenshot: false,        // set true only for key steps — it's slow
  metadata: { step: "pick-highest-paying-survey" },
})
```

Returns the full record:

```jsonc
{
  "step": "3f2a...",
  "timestamp": 1713480000000,
  "durationMs": 412,
  "operation": { "name": "dom.click", "args": {...} },
  "result": { "clicked": true, ... },
  "error": null,
  "before": { "fingerprint": {...}, "console": {...} },
  "after":  { "fingerprint": {...}, "console": {...} },
  "diff":  {
    "urlChanged": true,
    "urlBefore":  "https://heypiggy.com/?page=dashboard",
    "urlAfter":   "https://heypiggy.com/survey/abc123",
    "bodyChanged": true,
    "nodesDelta": 82,
    "interactiveDelta": 17
  },
  "newConsoleEntries": [],
  "screenshot": null
}
```

### `debug.snapshotState({ tabId, screenshot })`

Fire-and-forget snapshot without executing anything. Useful before a
heuristic branches, e.g. "what does the dashboard look like right now".

### `debug.getTrace({ sessionId, limit, sinceStep })`

Retrieve the session's records. `sinceStep` is cursor-paginated for
long sessions. Omit `sessionId` to list all open sessions with
record counts.

### `debug.clearTrace({ sessionId })`

Drop records to reclaim `storage.session` quota. Omit `sessionId` to
clear everything.

### `debug.getConsoleErrors({ tabId, limit })`

One-shot tail of captured console errors, independent of any session.

## Console capture — how it works

`extension/src/content/debug-console.js` runs in the **MAIN** world at
`document_start`, alongside `stealth-main.js`. It monkey-patches
`console.error`, `console.warn`, the `"error"` event and the
`"unhandledrejection"` event, writes every capture into a ring buffer
(capacity 200), and exposes the buffer as a non-enumerable,
non-writable, non-configurable property `window.__OPENSIN_DEBUG_CONSOLE__`.

The `debug.*` tools read the buffer back via
`chrome.scripting.executeScript({ world: "MAIN", ... })` so the ring
buffer and the SW never share memory — they talk only through
`chrome.scripting`'s structured-clone protocol.

### Why not CDP `Runtime.consoleAPICalled`?

CDP's console subscription would require keeping the `chrome.debugger`
attached to every tab for the whole session, which makes the yellow
"OpenSIN Bridge is debugging this browser" warning bar sticky and gives
sites a strong timing-attack signal (see the
[stealth-v2 trade-offs](stealth-v2.md#non-goals)). Injecting a
100-line MAIN-world patch is cheaper and narrower.

## Storage footprint

Without screenshots, a record is ~1–3 KB. `chrome.storage.session` has
a 10 MB quota per extension, so ~3000 records per session fit
comfortably. The `MAX_RECORDS_PER_SESSION = 500` cap in
`tools/debug.js` keeps you well under that even with noisy console
output.

With screenshots enabled, a record jumps to ~50–200 KB. Use
screenshots selectively — on RETRY, on errors, on the last step
before a known-bad state.

## Worker integration (recommended pattern)

```python
session_id = (await bridge.call("debug.startSession", {"label": run_id}))["sessionId"]

async def traced(name, args, step_meta=None, shoot=False):
    rec = await bridge.call("debug.traceAction", {
        "sessionId": session_id,
        "operation": {"name": name, "args": args},
        "metadata": step_meta,
        "screenshot": shoot,
    })
    if rec.get("error") or (rec["diff"].get("urlChanged") is False and shoot is False):
        audit("debug_step", **rec)
    return rec

# use `traced` wherever you call bridge.call
await traced("dom.click", {"selector": "div.survey-item"}, step_meta={"stage": "dashboard-click"})
```

When a RETRY-spiral detects repeated failure, the worker can call
`debug.getTrace({ sessionId })` and ship the whole trace to the audit
log for human review, with exact context for every decision the agent
made.

## Known limitations

- **Console capture only fires for scripts running after the content
  script loaded.** Scripts executed by `inline-script` attributes
  **before** `document_start` are technically un-interceptable without
  CDP. This is extremely rare in modern sites but documented for
  completeness.
- **`chrome.storage.session` is session-scoped**: if the user closes
  and reopens Chrome, traces are gone. This is deliberate — we never
  want to persist page content to disk.
- **Screenshots use `chrome.tabs.captureVisibleTab`**, which captures
  only the viewport, not the full page. For full-page captures use
  `dom.fullscreenshot` and pass the resulting dataUrl into the record
  via `metadata`.
