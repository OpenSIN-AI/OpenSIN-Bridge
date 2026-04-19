# Stealth & Automation Benchmarks

This document records how the OpenSIN Bridge performs against
publicly available detection benchmarks. Run these before every
release that touches the stealth layer or any automation primitive.

## 1. sannysoft.com — the canonical headless-chrome probe

**How to run**

1. Build and load the extension (`pnpm run ext:package`, then load
   `dist/opensin-bridge-extension.zip` via `chrome://extensions`).
2. Open `https://bot.sannysoft.com` in a tab.
3. Every row on the table must show a green check.
4. Paste `test/stealth/sannysoft-probe.js` into DevTools and
   confirm `PASS` for every entry.

**What each row tests**

| Row                  | Stealth module covering it |
|----------------------|----------------------------|
| WebDriver            | `webdriver`                |
| Chrome (New)         | `chromeRuntime`            |
| Permissions          | `permissions`              |
| Plugins Length       | `plugins`                  |
| MimeTypes Length     | `plugins` / `mimeTypes`    |
| Languages            | `languages`                |
| HeadlessChrome in UA | `userAgent`                |
| Broken Image         | (not automation specific)  |
| Outer Dimensions     | `outerDimensions`          |
| Navigator Languages  | `languages`                |
| Navigator Plugins    | `plugins`                  |
| WebGL Vendor         | `webgl`                    |

## 2. abrahamjuliot.github.io/creepjs/ — deep fingerprint analysis

**How to run**

1. Extension loaded, open `https://abrahamjuliot.github.io/creepjs/`.
2. Wait for the full analysis to complete (~30 s).
3. Record the `trust score`. Target: **>= 70%** (same range a vanilla
   Chrome without any automation scores).
4. Confirm the `lies detected` count is **<= 3** and never includes
   `navigator.webdriver`, `navigator.plugins`, `webgl`, or
   `chrome.runtime`.

The `canvas` and `audio` modules intentionally introduce micro-noise,
so CreepJS may flag them as `rotated fingerprint` — that is **expected**
and desirable. The fingerprint changing across sessions means our
hash cannot be correlated across visits.

## 3. pixelscan.net — consumer-grade bot detection

1. Open `https://pixelscan.net/`.
2. Expected verdict: **"You look like a genuine user"** or equivalent.
3. Verify `Masked / Hidden` is NOT reported for any field.

## 4. iphey.com — fingerprint delta score

1. Open `https://iphey.com/`.
2. Confirm the `Trustworthy` score is at least green.
3. `Headless Browser` must report `Not detected`.

## 5. Internal regression — Node unit tests

```bash
pnpm test:stealth
```

Runs `test/stealth/stealth-main.test.mjs` which instantiates the
stealth IIFE inside a `vm` context with a fake browser environment
and asserts:

- The idempotency flag is set to the current version string.
- Every module reports `applied` / `skipped` / `partial` (never an
  uncaught error).
- Hooked functions `toString()` with `[native code]` preserved.
- Loading the script twice does not mutate state a second time.

## 6. End-to-end smoke against heypiggy.com

This is the production use case. The worker repo
(`A2A-SIN-Worker-heypiggy`) drives the extension through a full
login → dashboard → survey flow. The bridge is considered stable
when the worker can open a survey and complete at least one
question page without the site flagging the session.

### Result log

| Date       | Sannysoft | CreepJS trust | heypiggy flow | Stealth version |
|------------|-----------|---------------|---------------|-----------------|
| 2026-04-19 | 12/12 PASS | pending       | pending       | 2.0.0 (initial) |

Append rows as new results come in — keep the latest row at the top
and never rewrite historical entries.
