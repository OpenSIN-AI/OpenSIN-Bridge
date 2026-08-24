# Changelog

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
