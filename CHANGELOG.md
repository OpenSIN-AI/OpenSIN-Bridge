# Changelog

## Unreleased — Debug tracing

New observability tool group so agents (and the humans debugging them)
can see *what the browser actually did* in response to each bridge
call. Motivated by the HeyPiggy survey-worker post-mortem (issue #61
of the Worker repo) where a failing agent produced `dom.click ok`
three times in a row with no structured signal of why nothing
happened in the viewport.

### Added

- `extension/src/content/debug-console.js` — MAIN-world content script
  at `document_start`, ring-buffer capture of `console.error`,
  `console.warn`, `window.onerror`, `unhandledrejection`. Exposed via
  `window.__OPENSIN_DEBUG_CONSOLE__` as a non-enumerable,
  non-writable, non-configurable surface.
- `extension/src/tools/debug.js` — tool group registering:
  - `debug.startSession` / `debug.endSession`
  - `debug.snapshotState` — one-shot url/title/DOM fingerprint/console
  - `debug.traceAction` — wraps any inner router call with
    before/after capture + diff (URL change, body change, node delta,
    interactive delta, new console entries) + optional screenshot
  - `debug.getTrace` / `debug.clearTrace`
  - `debug.getConsoleErrors`
- `extension/manifest.json` — MAIN-world `content_scripts` entry now
  lists `stealth-main.js` followed by `debug-console.js`. Load order
  matters: the debug hook consults `__OPENSIN_STEALTH__.markNative` for
  native-toString inheritance, so stealth-main must load first.
- `test/stealth/debug-console.test.mjs` — 12 unit tests via
  `node --test`, exercising capacity cap, `.clear()` semantics,
  idempotency, Error serialization, `window-error` +
  `unhandledrejection` event capture, and URL-at-capture-time
  correctness.
- `test/stealth/debug-diff.test.mjs` — 9 unit tests covering
  `computeDiff` across URL / title / body / node-count changes,
  missing-fingerprint tolerance, `summarize` payload stripping, and
  `randomId` uniqueness over 200 samples.
- `docs/debug-tracing.md` — tool reference, architecture
  (why MAIN-world hook instead of CDP `Runtime.consoleAPICalled`),
  storage footprint, worker integration example.

### Changed

- `.github/workflows/ci.yml` — the manifest check no longer greps for
  an exact `"js": ["src/content/stealth-main.js"]` literal; it parses
  the JSON and asserts that the MAIN-world entry contains both
  `stealth-main.js` and `debug-console.js`, in that order, at
  `document_start`. Robust against formatting changes.

### Storage

`chrome.storage.session` is used (not `storage.local`) for trace
records: survives service-worker suspension within a browser session,
cleared on browser restart so traces never leak to disk.

## Unreleased — Stealth v2 overhaul

The main-world stealth layer (`extension/src/content/stealth-main.js`) has been
replaced end-to-end. The previous version was ~48 lines and patched five
surfaces (`navigator.webdriver`, `chrome.runtime`, permissions, plugin count,
chrome.csi/loadTimes). It passed basic `webdriver`-sniff tests but leaked on
WebGL, canvas, audio, battery, WebRTC, iframe re-exposure, `toString`
introspection and `Notification.permission` mismatch — all of which are
standard Fingerprint/Pro checks on anti-bot-heavy sites (Prolific, Swagbucks,
survey panels, ticketing).

### Added

- `stealth-main.js` v2 — 17 evasion modules, ~600 lines, single IIFE for
  MV3 main-world injection. Installs at `document_start` (run_at).
- `stealth-legacy.js` — byte-for-byte copy of the old layer, kept for users
  who pin it via `chrome.scripting.executeScript({ files: [...] })`.
- `test/stealth/stealth-main.test.mjs` — 13 unit tests via `node --test`,
  running the production file inside a jsdom-ish stub. No headless browser
  needed in CI.
- `test/stealth/sannysoft-probe.js` — DevTools-paste one-liner that returns
  the 12 key fingerprint surfaces as JSON, for quick sanity-check against
  https://bot.sannysoft.com and https://abrahamjuliot.github.io/creepjs.
- `docs/stealth-v2.md` — what each module does, why, and how to verify it.
- `docs/BENCHMARKS.md` — manual + automated check matrix, known gaps
  (audio-fingerprint subtle variance, TLS fingerprint out-of-scope for MV3).
- `package.json#scripts.test:stealth` — `node --test test/stealth/*.test.mjs`.

### Changed

- `README.md` rewritten. Marketing superlatives ("WORTHLESS vs PRICELESS",
  "Competitors who clone get NOTHING") removed. Replaced with an honest
  positioning section (**What Bridge does / does not do**, **Trade-offs vs
  Playwright and CDP-in-extension alternatives**) and verifiable claims only.

### Evasion coverage (new in v2)

`webdriver`, `chrome.runtime`, `Permissions.query`, `plugins`, `mimeTypes`,
`languages`, `deviceMemory`, `hardwareConcurrency`, `userAgentData`,
`connection` (NetworkInformation), WebGL vendor/renderer + parameter
randomization, canvas 2D/WebGL readback jitter, AudioContext
`getChannelData/getFloatFrequencyData` jitter, Battery API,
`navigator.getBattery`, iframe `contentWindow` re-patching,
`Notification.permission` consistency, `Function.prototype.toString`
identity, `chrome.csi / loadTimes`, `Intl.DateTimeFormat` timezone
consistency, `screen` dimensions sanity.

### Not in this release (explicit non-goals, see `docs/stealth-v2.md`)

- **TLS JA3/JA4 fingerprint** — driven by Chrome/OS networking stack,
  cannot be patched from an MV3 content script.
- **CDP attach detection** — any site that measures `debugger` attach
  latency via RDP roundtrip will still see Bridge. This is architectural
  (the debugger API is our automation primitive) and documented as a
  known trade-off in `README.md` and `docs/stealth-v2.md`.
- **Playwright API shim** — planned separately; out of scope here.

## 5.0.0 — Extension rewrite

This release replaces the monolithic 4.x extension (single 3,800-line service
worker, duplicate popup files, broken content script) with a modular MV3
architecture built for fully-unattended agent use.

### Highlights

- **92 RPC tools** across `tabs / nav / dom / cookies / storage / net /
  session / system / vision / behavior`, all with a single JSON-RPC envelope.
- **Legacy name compatibility** via `tools/aliases.js` so existing agent
  harnesses (OpenCode CLI, Browser-Use, Claude Computer Use, …) keep working
  without modification.
- **Three transports** share one router: WebSocket (`server.js`), Native
  Messaging (`native-host/`), and `externally_connectable` page messaging.
- **Human-plausible automation primitives** — bezier-jittered pointer paths,
  variable-speed typing, MutationObserver-based settle detection.
- **CDP driver** with shared debugger attach/detach and event fan-out for
  network capture, UA override, request blocking, throttling.
- **Vision fallback chain** (Gemini → Groq) with per-model daily quota so
  element locate / OCR keeps working even when keys are rate-limited.
- **Strict MV3 CSP** — no `unsafe-eval`, no wildcard, no localhost holes in
  production. `host_permissions` are `<all_urls>` (required for
  general-purpose automation) but every other permission is scoped.

### Fixed (regressions shipping in 4.x)

- Extension no longer failed to load: the 4.x service worker redeclared
  `behaviorRecordingEnabled`, `behaviorRecordingScope`, `SENSITIVE_*` with
  conflicting `let`s and threw `SyntaxError` before registering any handler.
- Content script no longer crashed: `injector.js` double-declared
  `BRIDGE_VERSION` and referenced an undefined `element` / `originalQuery`
  identifier in every type/fill/stealth path.
- Tool responses now reach the server: the WS envelope is
  `{type:"tool_response", id, ok, result|error}` — matching what `server.js`
  actually waits for. 4.x sent `{ok,result}` with no `type`, so every
  response was silently discarded.
- CDP network capture works: `CDP.installCdpListeners()` is now installed at
  boot. 4.x never called it, so `net.captureStart` registered listeners that
  never fired.
- Vision tool no longer blocks boot: `tools/vision.js` imported a non-existent
  `locate` symbol from `automation/vision.js`, which caused the service
  worker module graph to fail to load. A dedicated
  `automation/vision-locate.js` now exports `locate()` and `transcribe()`.
- Options UI saves vision keys in the shape the vision client reads
  (`{ provider, gemini, groq, openai }`) — multiple provider keys now
  coexist.
- Notifications render: `system.notify` uses `chrome.runtime.getURL()` with
  the correct `icons/icon128.png` filename.
- Popup icon loads: the `/icons/…` absolute URL was replaced with a relative
  `../../icons/…` path so the Chrome extension popup renders its icon.
- Permissions are now minimal: `webRequest`, `tabCapture`, `contextMenus`,
  `declarativeNetRequest`, `management`, `proxy` moved to
  `optional_permissions` (none of them were actually used in 4.x code paths).
- No hard-coded secrets: the leaked Groq API key that shipped in the 4.x
  service worker has been removed. All vision keys are now user-supplied via
  the options UI.
- New-tab hijack removed: 4.x replaced `chrome_url_overrides.newtab` with
  the extension landing page — that was aggressive and a Web Store review
  hazard. The new-tab experience is untouched.

### Removed

- Duplicate popup (`extension/popup.html` / `popup.js` at the root, in
  addition to `extension/popup/…`).
- Duplicate service worker (`background/service-worker.js` stub alongside
  the 3,800-line `service_worker.js`).
- Unused `browserLanding.html` / `browserLanding.js` static page.
- Unused `opensin-platform-icon.png`, `icon-source.png`.
- Empty/stub modules: `background/native-host.mjs`,
  `background/observation-runtime.mjs`.
- Legacy `shared/deterministic-primitives.js` and `shared/session-export.mjs`
  replaced by `src/shared/*`.

### Migration

The extension still speaks the same WebSocket protocol to `server.js`. Agents
do not need changes. If you previously called legacy flat tool names
(`tabs_list`, `click`, `navigate`, `execute_script`, `get_page_content`, …),
they continue to work through `tools/aliases.js` and forward to the dotted
handlers (`tabs.list`, `dom.click`, `nav.goto`, `dom.evaluate`,
`dom.getText`).
