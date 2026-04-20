# OpenSIN-Bridge Contract v1

> Status: stable
> Schema: `opensin.bridge.contract/v1`
> Source of truth: `extension/src/contract/v1/index.js`
> Worker counterpart: `OpenSIN-AI/A2A-SIN-Worker-heypiggy/bridge_contract.py`

## Why

Worker issue [#69](https://github.com/OpenSIN-AI/A2A-SIN-Worker-heypiggy/issues/69)
demands a versioned contract for browser commands, events, retries, and failure
classes. Previously the bridge surface was the union of `extension/src/tools/*`
plus an organic alias layer in `aliases.js`. That worked for ad-hoc agents but
gave downstream workers no machine-readable promise about:

- which methods are safe to retry,
- which methods mutate browser state,
- what failure shape the worker can branch on.

This document is the human-readable view. The machine-readable view ships in
`extension/src/contract/v1/index.js` and is exposed at runtime via
`bridge.contract`.

## Read it

```js
const contract = await rpc("bridge.contract")
contract.version          // "opensin.bridge.contract/v1"
contract.revision         // 1
contract.methods          // [{ name, idempotent, mutates, raises, retryHint, ... }]
contract.errorCodes       // ["transport_error", "target_gone", ...]
contract.retryHints       // { transport_error: "safe_retry", ... }
contract.internalToContract // { TIMEOUT: "timeout", ... }
```

The contract is also pinned in CI via
`scripts/validate-bridge-contract.mjs` (`pnpm run validate:bridge-contract`).

## Idempotency model

Every method declares an `idempotent` boolean. The rule is:

- `idempotent: true` → calling it twice with the same params produces the
  same observable browser state and is therefore safe to retry on transient
  failure.
- `idempotent: false` → the worker MUST NOT blindly retry. Either it has
  postconditions to verify the action took effect, or it must escalate to
  recovery.

Examples:

| Method            | Idempotent | Mutates | Reasoning                                                |
| ----------------- | ---------- | ------- | -------------------------------------------------------- |
| `tabs.list`       | yes        | no      | Read-only.                                               |
| `tabs.activate`   | yes        | yes     | Same tabId twice converges to the same active tab.       |
| `nav.goto`        | no         | yes     | SPAs may build different state per navigation.           |
| `dom.click`       | no         | yes     | Two submits = double order. Worker must verify.          |
| `dom.snapshot`    | yes        | no      | Read-only.                                               |
| `session.invalidate` | yes     | yes     | Already-invalid session stays invalid; converges.        |
| `session.restore` | no         | yes     | Restoring twice can clobber fresh state. Worker decides. |

## Error taxonomy

Failures map onto a small, stable code set (full list:
`extension/src/contract/v1/index.js`, `ERROR_CODES`). The bridge never invents
new error codes at runtime — every internal `BridgeError` is translated via
`INTERNAL_TO_CONTRACT`.

### Transport / RPC envelope

| Code              | Meaning                                                |
| ----------------- | ------------------------------------------------------ |
| `transport_error` | WS / native host disconnected, request never reached.  |
| `rpc_invalid`     | Malformed RPC envelope or invalid params.              |
| `unknown_method`  | Method not registered in this contract revision.       |
| `rate_limited`    | Bridge-internal rate limit hit. Retry with backoff.    |
| `timeout`         | Tool exceeded its timeout budget.                      |

### Browser surface

| Code                  | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `target_gone`         | Tab/frame closed during call. Recover then retry.        |
| `navigation_aborted`  | Navigation interrupted (programmatic or user).           |
| `navigation_timeout`  | Navigation didn't complete within timeoutMs.             |
| `cdp_failed`          | Chrome DevTools Protocol failure (debugger detached).    |
| `frame_detached`      | The selected frame is gone.                              |

### DOM / interaction

| Code                       | Meaning                                              |
| -------------------------- | ---------------------------------------------------- |
| `element_not_found`        | Selector / ref didn't resolve.                       |
| `element_not_actionable`   | Resolved but covered, disabled, or zero-size.        |
| `postcondition_failed`     | Mutating action did not produce expected change.     |
| `duplicate_action`         | Submit-style guard prevented a second click.         |

### Session

| Code                    | Meaning                                                |
| ----------------------- | ------------------------------------------------------ |
| `session_invalid`       | Manifest invalidated (logged out, cookie purged, ...). |
| `session_stale`         | TTL expired. Worker can extend or reacquire.           |
| `session_locked`        | Another worker holds the session lock.                 |
| `origin_not_permitted`  | Origin not in the bridge's allowed list.               |

### Adversarial environment

| Code                  | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `anti_bot_challenge`  | Cloudflare / DataDome / PerimeterX detected.           |
| `captcha_required`    | reCAPTCHA / hCaptcha / Turnstile interactive challenge.|
| `rate_limit_remote`   | Remote site (not bridge) is throttling.                |

## Retry hints

Every error code carries a hint (`safe_retry`, `recover_then_retry`, `abort`).
The worker's retry loop SHOULD use this to decide between:

- `safe_retry` → exponential backoff in place
- `recover_then_retry` → re-acquire context (session, frame, tab) first
- `abort` → escalate to higher-level policy

Hints are advisory. The worker is the policy authority — the bridge is the
classifier.

## Stability guarantees

Within v1:

- No method is removed.
- No error code is repurposed.
- Adding a method or relaxing idempotency bumps `revision`.

A breaking change forces a new file under `extension/src/contract/v2/index.js`
and a parallel exposure (`bridge.contract` always returns the active major).

## Related tools

- `bridge.contract` — get the full contract object
- `bridge.contract.method` — get one method's metadata
- `bridge.contract.translate` — translate an internal code to a contract code
- `bridge.contract.idempotent` — yes/no shortcut
- `bridge.contract.version` — version + revision only
- `bridge.evidenceBundle` — pair with the contract for failure triage (#70)
- `bridge.traces` — recent dispatches, optionally by `traceId`
