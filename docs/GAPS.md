# Gaps and honest limitations

Status as of the rewrite alignment PR. This document is the counterpart to
`A2A-SIN-Worker-heypiggy/docs/GAPS.md`. Anything listed here is **not**
solved by the contract-v1 layer and must not be assumed production-grade.

## 1. Target resolution in the interaction path

- `dom.click` / `dom.type` accept a selector or a target object. Selectors
  are matched with a plain `querySelector` fallback. Shadow DOM, iframes
  and cross-origin frames are **not** transparently resolved.
- No built-in retry for "element exists but is covered by an overlay".
  Callers must compose `stealth.detectChallenge` + dismiss logic themselves.
- Accessibility snapshots returned by `dom.snapshot` do not yet include
  ancestor chain or stable path hashes. Resolvers relying only on
  `name` or `ariaLabel` will collide on pages with repeated text.

**Planned fix:** extend `dom.snapshot` to return `{ role, name, path, bbox,
visible, interactable, ancestors: [...] }` per node, and add
`dom.resolve` that scores candidates.

## 2. Stealth surface is a heuristic, not a defence

- `stealth.assess` checks locale / timezone / viewport / `navigator.webdriver`.
  Modern anti-bot stacks (Cloudflare Turnstile, DataDome, PerimeterX,
  Kasada, Akamai Bot Manager) fingerprint dozens of additional signals:
  canvas, WebGL, AudioContext, font metrics, TLS JA3/JA4, HTTP/2 SETTINGS.
  None of those are covered here.
- `stealth.detectChallenge` is a DOM signature matcher. It **cannot**
  distinguish a silently-triggered silent challenge from a clean page.
- There is no mouse or keyboard humanisation primitive in the bridge.
  `dom.click` fires a single synthetic event at the target centre.

**Planned fix:** add `input.humanMove`, `input.humanClick`, `input.humanType`
primitives in a new `tools/input.js` driven by CDP
`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, with jitter and
motion traces.

## 3. Session lifecycle gaps

- `session.manifest` tracks TTL in wall-clock seconds. There is no
  refresh-token aware flow; reauth is handled outside the bridge.
- `session.lastKnownGood` snapshot contains cookies only. IndexedDB
  and ServiceWorker registrations are not captured.
- Cross-profile isolation depends on Chrome's cookie stores and is not
  enforced inside the bridge. Two origins sharing a cookie jar leak
  into each other's manifests.

## 4. Observability gaps

- Evidence bundles embed screenshots as base64 inline. For long
  sessions this blows up disk usage. No rotation or compression.
- Trace IDs are generated inside the bridge and are not propagated
  back into the page via `X-Trace-Id` or similar, so network-level
  evidence cannot be joined with DOM evidence.
- `bridge.traces` stores the ring buffer in memory; extension reloads
  wipe history.

## 5. Contract completeness

- Contract v1 covers **40** methods. Real worker call sites still use
  some legacy names that are only implemented via `tools/aliases.js`
  and **not** exposed through `bridge.contract`. A worker calling
  `ensure_contract()` will accept v1 but can still invoke a
  non-catalogued legacy method at runtime.
- `dom.evaluate` accepts arbitrary JS. It is listed as non-mutating
  but cannot be enforced. Callers must treat it as effectively mutating.

## 6. Test coverage

- 60 Node tests cover contract metadata, session lifecycle, evidence
  bundle shape and stealth assessment math. There is **zero** end-to-end
  coverage against a real Chrome instance, a real website, or a
  real Cloudflare-protected target.
- No fuzzer against malformed RPC envelopes, yet the bridge is the
  trust boundary between worker and browser.

## 7. What this PR does **not** fix

- Anti-bot evasion quality.
- Worker orchestration logic (lives in the worker repo).
- Real target-resolver robustness.
- Production readiness of the opt-in new stack on the worker side.

## Rollout contract

Until the gaps above are closed, consumers must assume the new surface
is **best-effort additive tooling**, not a replacement for
site-specific hardening. The flat legacy names (`click`, `type`,
`nav_to`, ...) keep working and remain the supported path for
heypiggy's in-production flows.
