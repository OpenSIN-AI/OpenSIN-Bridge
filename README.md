# OpenSIN Bridge

A Chrome Manifest V3 extension that turns the user's real Chrome
profile into a scriptable browser for AI agents. The extension
exposes a JSON-RPC tool surface (92 tools over three transports —
WebSocket, Native Messaging, and `externally_connectable`); the
business logic lives on a Cloudflare Workers API.

The bridge is designed for workflows that need the session state of
a real human (cookies, passwords, Autofill, Fingerprint) — paid
research panels, CRM automation, any platform that blocks
Playwright/Puppeteer on sight. It is **not** a hermetic testing
tool; for that, Playwright remains a better choice.

## Architecture

```
+----------------------------+       JSON-RPC / WebSocket        +----------------------------+
|  Chrome MV3 Extension      | <--------------------------------> |  Cloudflare Workers API    |
|  (runs in user's Chrome)   |             JWT                    |                            |
|                            |                                    |  - Session validation       |
|  - 92 RPC tools            |                                    |  - Rate limiting            |
|  - Accessibility-tree      |                                    |  - Usage tracking           |
|    snapshots               |                                    |  - Stripe subscription gate |
|  - Multi-strategy clicker  |                                    |                            |
|    (CDP -> DOM -> dispatch)|                                    +----------------------------+
|  - Stealth layer v2        |                                                |
|  - Offscreen document for  |                                                v
|    clipboard / audio       |                                    +----------------------------+
|  - Native messaging host   |                                    |  Supabase + Stripe          |
+----------------------------+                                    |  Auth / subs / usage log    |
                                                                  +----------------------------+
```

## Why this over Playwright / Stagehand / Skyvern

Most agent browsers spawn a fresh Chromium with no profile. That is
perfect for deterministic tests and terrible for sites that gate
access on a real-user session. Bridge flips the default:

| Dimension                | Playwright-based tools | OpenSIN Bridge |
|--------------------------|------------------------|----------------|
| Chrome instance          | Spawned Chromium        | User's installed Chrome |
| Profile / cookies / 2FA  | Empty, synthetic        | Real, pre-authenticated |
| `navigator.webdriver`    | `true` (leaks)          | `undefined` (v2 stealth) |
| Chrome debugger banner   | Not applicable          | Yes (CDP attach)        |
| Headful                  | Optional                | Default — user watches  |
| Primary use case         | Testing, scraping       | Session-bound automation |

The stealth layer is deliberately single-purpose: it is not trying
to be a universal anti-detection framework. It neutralizes the
primitives that `chrome.debugger.attach` disturbs and a handful of
well-known headless-chrome fingerprints — see
[`docs/stealth-v2.md`](docs/stealth-v2.md) for the exact surface.

## Agent tool surface

All 92 tools are served from a single namespaced router. The wire
format is a plain JSON-RPC envelope:

```jsonc
{
  "type": "tool_request",
  "id": 42,
  "method": "dom.click",
  "params": { "selector": "button[type=submit]" }
}
```

Namespaces:

- `tabs.*`     — list, create, close, activate, group, move, duplicate
- `nav.*`      — goto, back, forward, reload, waitForLoad
- `dom.*`      — click, type, fill, select, scroll, hover, evaluate,
                 getText, getHtml, query, waitForSelector, snapshot
- `cookies.*`  — get, set, delete, getAll, stores, clearForDomain
- `storage.*`  — local / session / indexedDB read+write, extension
                 storage
- `net.*`      — fetch, captureStart / Stop, setExtraHeaders,
                 setUserAgent, block, throttle
- `session.*`  — export / import cookies + storage for domain reuse
- `system.*`   — health, uptime, notify, downloads, clipboard, version
- `vision.*`   — locate (model-based element locate), read (OCR)
- `behavior.*` — recording start / stop / export for session replay

Flat aliases (`click`, `navigate`, `get_page_content`, `tabs_list`,
...) are mapped to their dotted equivalents in
`extension/src/tools/aliases.js`, so existing agent harnesses keep
working.

## Clicker model

The clicker runs a three-stage fallback for every click:

1. **CDP mouse input** — dispatches real `mousemove`,
   `mousedown`, `mouseup` events through
   `Input.dispatchMouseEvent`. This is indistinguishable from a
   human click from the page's perspective.
2. **DOM click()** — calls `element.click()` if the CDP path is
   blocked (certain `iframe` sandbox configurations).
3. **DOM dispatch** — synthesizes `MouseEvent` and dispatches it
   directly. Final fallback.

Every click is followed by an interaction proof: a DOM-diff hash
and an optional screenshot delta. The tool call does not return
`ok: true` unless the page actually reacted to the click — the
agent gets honest feedback instead of a false positive.

## Snapshot model

Snapshots come from Chrome's Accessibility tree (via CDP's
`Accessibility.getFullAXTree`). Every interactive node gets a
stable in-memory handle (`@e1`, `@e2`, ...) that later tool calls
can reference without reasoning about CSS selectors. A fresh
snapshot clears the map so an old handle cannot target a rerendered
element.

The tree is compacted before returning — structural roles with no
name are dropped, skip roles (`generic`, `group` without name) are
collapsed. Median tree size on a modern web app is around 4 KB
compared to 200 KB+ for a raw DOM dump.

## Stealth layer v2

Runs as a MAIN-world content script at `document_start` on every
frame. 17 evasion modules cover:

- `navigator.webdriver`, `plugins`, `mimeTypes`, `languages`,
  `hardwareConcurrency`, `deviceMemory`, `permissions.query`,
  `userAgent`, `mediaDevices`, `getBattery`, `connection`
- `window.chrome.runtime`, `outerWidth`, `outerHeight`
- `HTMLIFrameElement.contentWindow`
- WebGL `getParameter` (vendor + renderer spoof)
- Canvas `toDataURL` / `getImageData` (micro-noise)
- AudioContext `getChannelData` (micro-noise)
- `Function.prototype.toString` (Proxy-preserved native signature)

Every module is idempotent, try/catch-wrapped, and its status is
introspectable via `window.__opensin_stealth_status__()` for use
by internal test harnesses. See
[`docs/stealth-v2.md`](docs/stealth-v2.md) and
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

## Repository layout

```
OpenSIN-Bridge/
|-- extension/                   Chrome MV3 extension
|   |-- manifest.json            # MV3 manifest (strict CSP; proxy + DNR required for stealth v2)
|   |-- icons/
|   `-- src/
|       |-- background/service-worker.js
|       |-- content/
|       |   |-- bridge-isolated.js      RPC handler (isolated world)
|       |   |-- stealth-main.js         Stealth v2 (main world)
|       |   `-- stealth-legacy.js       v1 shim, kept for rollback
|       |-- core/                       config, logger, errors, rpc,
|       |                               state, lifecycle, utils
|       |-- drivers/                    tabs, cdp, offscreen,
|       |                               behavior-store
|       |-- automation/                 human, clicker, typer,
|       |                               snapshot, vision,
|       |                               vision-locate
|       |-- tools/                      92 RPC tools + aliases
|       |-- transports/                 ws, native, external
|       |-- offscreen/                  clipboard / audio sandbox
|       |-- popup/ | options/           operator UI
|       `-- shared/                     deterministic primitives
|-- server.js                    WebSocket bridge + MCP/HTTP relay
|-- native-host/                 Native messaging host
|-- docs/
|   |-- BENCHMARKS.md            Stealth verification procedure
|   |-- stealth-v2.md            Stealth architecture & rationale
|   |-- ISSUE_SCOPED_EXECUTION.md
|   `-- PR_ISOLATION_CHECKLIST.md
|-- test/
|   |-- stealth/                 Stealth v2 Node unit tests
|   |-- *.test.js | *.test.mjs   Other regression suites
`-- scripts/                     Build, test, deploy
```

## Development

```bash
# Dependencies
pnpm install

# Load the extension in a dev Chrome
pnpm run ext:dev
# -> open chrome://extensions, enable Developer Mode, load-unpacked
#    pointing at ./extension

# Run the stealth unit suite
pnpm run test:stealth

# Run the full Node test suite
pnpm test

# Package for Chrome Web Store
pnpm run ext:package
# -> produces dist/opensin-bridge-extension.zip

# Deploy the server to Cloudflare
pnpm run deploy:server
```

### Verifying stealth against public detectors

Follow the procedure in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).
The short version:

1. Build and install the extension.
2. Open `https://bot.sannysoft.com`.
3. Paste `test/stealth/sannysoft-probe.js` into DevTools and
   confirm every check reports `PASS`.
4. Open `https://abrahamjuliot.github.io/creepjs/` and record the
   trust score in the results table in `docs/BENCHMARKS.md`.

## Issue-scoped cloud execution

Cloud executors must not implement features from a dirty default
checkout. All issue work happens in dedicated worktrees:

- Workflow: [`docs/ISSUE_SCOPED_EXECUTION.md`](docs/ISSUE_SCOPED_EXECUTION.md)
- Review checklist: [`docs/PR_ISOLATION_CHECKLIST.md`](docs/PR_ISOLATION_CHECKLIST.md)
- Worktree helper: `pnpm run issue:worktree -- --issue <n> --branch <branch>`
- Scope gate: `pnpm run verify:issue-scope -- ...`
- Regression tests: `pnpm run test:issue-worktree`

## Behavior timeline capture

For issue set #17 / #21 / #24 the bridge ships a core behavior-
timeline capture layer:

- **Durable storage**: session events are written into an IndexedDB-
  backed event store in the MV3 service worker.
- **Content-side capture**: the MAIN-world injector emits compact
  events for clicks, debounced inputs, form submits, and navigation
  markers.
- **Performance controls**: click throttling, input debouncing,
  short-window navigation dedupe, buffered flushes, bounded
  IndexedDB batch sizes.
- **Bridge markers**: `start_recording`, `snapshot`, and `observe`
  append marker events into the same session timeline when behavior
  recording is enabled.

## License

Proprietary. All rights reserved. The server-side business logic is
trade-secret material and is not published publicly. The extension
source in this repository is auditable by customers under NDA on
request.
