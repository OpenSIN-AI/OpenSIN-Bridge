# Stealth Layer v2 — Architecture & Rationale

## What this document is

A design record for the main-world content script
`extension/src/content/stealth-main.js`. It explains why the file
is structured the way it is, which detection surfaces it covers,
and how to extend it safely.

## Why a stealth layer at all

The Bridge runs as a Chrome Extension inside the user's real Chrome
with the user's real profile. That alone defeats 80% of the
fingerprint delta a Playwright/Puppeteer setup leaks. But two
problems remain:

1. `chrome.debugger.attach` is how the bridge drives the page
   (mouse input, DOM queries, network interception). Attaching the
   debugger sets up conditions a sophisticated detector can see:
   the yellow "debugging this browser" banner is visible to the
   user but — more importantly — the attach process itself perturbs
   a handful of primitives that a script running in the page can
   observe.

2. Some extensions and some profiles legitimately leak fingerprints
   a strict anti-bot service will flag. Real humans have `plugins`
   and `hardwareConcurrency`; a truly empty profile does not.

The stealth layer brings those primitives back in line with what a
genuine Chrome on macOS reports.

## Architecture

One file, one IIFE. No ES imports.

```
extension/src/content/stealth-main.js
├── Idempotency guard (window.__opensin_stealth__ = "2.0.0")
├── toString-preservation helper (Proxy over Function.prototype.toString)
├── 17 evasion modules (each is try/catch-wrapped and reports applied/skipped/error)
├── Runner loop (runs every module, collects status)
└── Diagnostic API (__opensin_ping__, __opensin_stealth_status__)
```

## Manifest / runtime contract

Stealth v2 is not a standalone content script anymore. The runtime now
depends on the manifest granting `proxy` and `declarativeNetRequest` at
install time. Those permissions are part of the critical path for the
stealth + debug stack and must **not** be moved back into
`optional_permissions` without updating the docs, tests, and rollout plan.

`webRequest`, `contextMenus`, and `management` remain optional because they
are operator convenience features, not boot prerequisites.

The other hard requirement is load order: `stealth-main.js` must run before
`debug-console.js` in the same MAIN world so the console tracer can inherit
`markNative()` and stay toString-clean.

If you touch any of the above, update `README.md`, `CHANGELOG.md`, and
`docs/debug-tracing.md` in the same change set.

ES module syntax is **not** used because Manifest V3 content scripts
do not support `"type": "module"` yet. Every time the platform does
support it, we can split the 17 modules into separate files; until
then one self-contained file is the correct choice.

## Why no npm dependencies

We intentionally do not depend on `puppeteer-extra-plugin-stealth`
or any external evasion library. Three reasons:

1. **Audit trail** — every line that runs in the user's browser is
   visible in this repo. A supply-chain compromise of an evasion
   library would be invisible in our CI.
2. **Size** — stealth-plugin plus its evasions transitively weighs
   over 500 KB. Ours is ~15 KB minified.
3. **MV3 compat** — stealth-plugin targets Node (for Puppeteer). It
   would need a non-trivial rewrite to run as an MV3 content script.

## How to add a new evasion module

1. Append a new function to the `MODULES` object in `stealth-main.js`.
2. The function must:
   - Return `true` when the evasion was applied, `false` when it
     was skipped (e.g. because the value was already fine), or
     throw — never leak an exception to the caller.
   - Be idempotent: running twice must not double-apply.
   - Use `markNative(fn, originalFn)` on every replacement function
     so its `toString()` reports `[native code]`.
   - Use `defineOnProto(Proto, key, getter)` for getter replacements.
3. Add a synthetic row to
   `test/stealth/stealth-main.test.mjs` that asserts the module
   runs without throwing.
4. Add a manual row to `test/stealth/sannysoft-probe.js` if the
   evasion is observable on a public detector site.
5. Update `docs/BENCHMARKS.md` to mention what the new module
   covers.

## Known limitations

- **Chrome debugger banner** cannot be hidden. It is rendered by
  Chrome itself outside the page context. We accept this tradeoff
  because CDP is the cleanest mouse/keyboard injection surface.
- **Very aggressive detectors** (Kasada, DataDome, some PerimeterX
  configs) use TLS-level fingerprinting (JA3/JA4) and
  timing-attack checks that no content-script-based stealth can
  defeat. For those, the only answer is to run the bridge through
  a residential proxy — see `docs/DEPLOYMENT.md`.
- **Canvas noise** means hash-based fingerprinting will generate a
  new hash per page load. That is desirable against tracking but
  means legitimate uses of canvas-based signatures (some rarely
  used form anti-replay tokens) will also break. We have not seen
  this in practice on the target sites, but it is a documented
  tradeoff.

## Migration from v1

The v1 shim was 48 lines and only touched `navigator.webdriver` and
the message channel. v2 is backward compatible:

- `window.__opensin_stealth__` is still set (now to the version
  string `"2.0.0"` rather than `true`, so callers can branch).
- `window.__opensin_ping__()` still returns `{ alive: true, ts }`
  (now also includes `v: "2.0.0"`).
- The `__OPENSIN_BRIDGE__` message channel direction
  `main->page` still works unchanged.

The original v1 file is preserved at
`extension/src/content/stealth-legacy.js` for reference and quick
rollback via a manifest swap if a production regression is seen.
