# Rewrite Tracker — HeyPiggy worker + OpenSIN-Bridge

> Last updated: 2026-04-20
> Master: [worker #67](https://github.com/OpenSIN-AI/A2A-SIN-Worker-heypiggy/issues/67)
> Base SHA: `bf1cd8c` on `main` (worker repo)

## Why this file exists

Worker repo `OpenSIN-AI/A2A-SIN-Worker-heypiggy` issue #67 froze the previous
implementation as broken and split the rewrite into nine sub-issues. Several of
them have a **bridge-side counterpart** that has to land in this repo so the
worker can be rewritten against a stable contract instead of the old organic
surface.

This file is the index. Each row links the worker issue to the concrete
bridge artifacts that satisfy its bridge-side requirements.

## Coverage matrix

| Worker issue | Theme                       | Bridge artifacts                                                                                                                                              | Status |
| ------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| #68          | Architecture RFC            | (worker-only) — the bridge contract v1 (`docs/BRIDGE_CONTRACT_V1.md`) is the bridge-side input to the RFC.                                                       | done   |
| #69          | Bridge contract             | `extension/src/contract/v1/index.js`, `extension/src/tools/contract.js`, `docs/BRIDGE_CONTRACT_V1.md`, `scripts/validate-bridge-contract.mjs`, `bridge.contract` RPC | done   |
| #70          | Observability / evidence    | `extension/src/drivers/evidence.js`, `extension/src/drivers/trace.js`, `extension/src/tools/evidence.js`, `bridge.evidenceBundle` and `bridge.traces` RPCs       | done   |
| #71          | Session lifecycle           | `extension/src/drivers/session-lifecycle.js`, `session.manifest`, `session.invalidate`, `session.lastKnownGood`, `session.health` RPCs                            | done   |
| #72          | Runtime state machine       | (worker-only) — bridge exposes the primitives the FSM consumes (snapshot, dom.click, session.health, evidenceBundle, contract).                                 | n/a    |
| #73          | Interaction engine          | (worker-only) — bridge already exposes actionability via `dom.fullSnapshot` + `dom.click` postcondition fields. Contract documents the failure codes.            | n/a    |
| #74          | Stealth strategy            | `extension/src/tools/stealth.js`, `stealth.assess`, `stealth.detectChallenge`. The existing `stealth-main.js` is unchanged; this adds the assessment surface.    | done   |
| #75          | Panel plugins               | (worker-only) — bridge stays panel-agnostic by design (`BOUNDARIES.md`).                                                                                         | n/a    |
| #76          | Validation harness          | `scripts/validate-bridge-contract.mjs`, `test/contract/*.test.mjs`, `test/session/*.test.mjs`, `test/evidence/*.test.mjs`, package script `validate:bridge-contract` | done   |

## How to consume from the worker

```python
# heypiggy/bridge_contract.py
import json
import urllib.request

def fetch_contract(bridge_http_url: str) -> dict:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "bridge.contract", "arguments": {}}}
    req = urllib.request.Request(
        f"{bridge_http_url}/mcp",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        envelope = json.loads(resp.read())
    text = envelope["result"]["content"][0]["text"]
    return json.loads(text)
```

The worker pins the contract revision at boot, validates that every
method/error code it expects is present, and aborts startup if anything is
missing. That is the gate worker issue #69 demands.

## Stop conditions

Per worker issue #76, the rewrite can not enable wider rollout until:

- `pnpm run validate:bridge-contract` passes in CI on this repo
- the worker-side replay harness clears the synthetic flow set
- a live canary run produces a complete `bridge.evidenceBundle` for every
  failure (no unclassified errors)

Until those gates pass the worker stays in the locked-down rewrite branch
established in worker issue #67.
