# OpenSIN-Bridge

> **OpenSIN ist keine Software. Es ist eine digitale Belegschaft.**
> Die Bridge ist die sichere Tuer, durch die Nutzer auf die Intelligenz unserer Agenten zugreifen. Der Agent arbeitet (z.B. auf Prolific), die Intelligenz bleibt im Server.

> **Paid SaaS Chrome Extension (5 EUR/month) — Thin-Client Architecture**
>
> The extension is a dumb shell. All intelligence lives on our servers. Competitors who clone the extension get NOTHING.

## Architecture

```
+------------------------+         +------------------------------+
|  Chrome Extension      |  JWT    |  Cloudflare Workers API      |
|  (Thin Client - FREE)  | ------> |  (Secret Sauce - PRIVATE)    |
|                        | <------ |                              |
|  - Login UI            |  Auth   |  - LLM Decision Engine       |
|  - DOM Extractor       |         |  - Study Evaluator           |
|  - Action Executor     |         |  - Anti-Detection Logic      |
|  - WebSocket Bridge    |         |  - Persona Engine            |
|  - License Key Input   |         |  - Stripe Sub Validation     |
|                        |         |  - Rate Limiting             |
+------------------------+         +------------------------------+
       WORTHLESS                          PRICELESS
   (can be cloned                     (code is SECRET,
    — doesn't matter)                  runs on OUR servers)

                              |
                              v
                   +---------------------+
                   |  Supabase           |
                   |  - Auth (users)     |
                   |  - Subscriptions    |
                   |  - Usage Tracking   |
                   |  - License Keys     |
                   +---------------------+
                              |
                              v
                   +---------------------+
                   |  Stripe             |
                   |  - 5 EUR/month      |
                   |  - Webhook Events   |
                   |  - Invoice + Tax    |
                   +---------------------+
```

## Security Model

| Layer | What | Protected? |
|-------|------|-----------|
| Extension Source Code | DOM extraction, UI, WebSocket client | NO (client-side, visible) |
| Server Business Logic | LLM prompts, decision trees, anti-detection | YES (Cloudflare Workers, never exposed) |
| API Keys / Secrets | OpenAI, Supabase, Stripe keys | YES (server-side env vars only) |
| License Validation | Subscription check on every API call | YES (server rejects invalid keys) |
| User Data | Profile answers, study history | YES (encrypted in Supabase) |

## What a Competitor Gets by Cloning

| They Get | They DON'T Get |
|----------|---------------|
| Empty extension shell | Our LLM decision engine |
| DOM extraction code | Our anti-detection algorithms |
| WebSocket client | Our persona engine |
| Login UI | Our Stripe/Supabase backend |
| popup.html | Our server API (requires valid subscription) |

**Result: A cloned extension is 100% useless without our server.**

## Pricing

| Plan | Price | Features |
|------|-------|----------|
| Free Install | 0 EUR | Extension installs, login screen shows |
| OpenSIN Pro | 5 EUR/month | Full access to all Bridge features |
| OpenSIN Team | 15 EUR/month | 5 seats, priority support, custom personas |

## Tech Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| Extension | Chrome MV3, vanilla JS | FREE |
| API Gateway | Cloudflare Workers | FREE (100k req/day) |
| Auth + DB | Supabase | FREE (50k MAU) |
| Payments | Stripe | 2.9% + 0.30 EUR/tx |
| LLM Backend | OpenAI via opencode CLI | Variable |
| Distribution | Chrome Web Store | 5 USD one-time |

## Repository Structure

```
OpenSIN-Bridge/
|-- extension/                   # Chrome MV3 extension
|   |-- manifest.json            # MV3 manifest (strict CSP, scoped perms)
|   |-- icons/                   # 16/32/48/128 png set
|   `-- src/
|       |-- background/
|       |   `-- service-worker.js        # Boot + lifecycle orchestrator
|       |-- content/
|       |   |-- bridge-isolated.js       # Isolated-world RPC handler
|       |   `-- stealth-main.js          # MAIN-world stealth shim
|       |-- core/                        # config, logger, errors, state,
|       |                                # rpc, lifecycle, utils
|       |-- drivers/                     # tabs, cdp, offscreen,
|       |                                # behavior-store
|       |-- automation/                  # human, clicker, typer,
|       |                                # snapshot, vision, vision-locate
|       |-- tools/                       # 92 registered RPC tools
|       |   |-- tabs / navigation / dom
|       |   |-- cookies / storage / network
|       |   |-- session / system / vision / behavior
|       |   `-- aliases.js               # legacy flat -> dotted names
|       |-- transports/                  # ws, native, external
|       |-- offscreen/                   # clipboard/parser sandbox
|       |-- popup/ | options/            # operator UI
|       `-- shared/                      # deterministic primitives
|-- server.js                    # WebSocket bridge + MCP/HTTP relay
|-- native-host/                 # Native messaging host (CSP escape)
|-- docs/                        # Architecture & workflow docs
`-- scripts/                     # Build, test, deploy
```

## Agent Tool Surface

All 92 RPC tools are exposed on a single namespaced router. Agents can call
them over three transports (WebSocket, Native Messaging, or
`externally_connectable` page messaging) using the same JSON-RPC envelope:

```jsonc
{ "type": "tool_request", "id": 42, "method": "dom.click",
  "params": { "selector": "button[type=submit]" } }
```

Canonical namespaces:

- `tabs.*`       — list / create / close / activate / group / move / duplicate
- `nav.*`        — goto / back / forward / reload / waitForLoad
- `dom.*`        — click / type / fill / select / scroll / hover / evaluate /
                   getText / getHtml / query / waitForSelector / snapshot
- `cookies.*`    — get / set / delete / getAll / stores / clearForDomain
- `storage.*`    — local/session/indexedDB read+write, extension storage
- `net.*`        — fetch, captureStart/Stop, setExtraHeaders, setUserAgent,
                   block, throttle
- `session.*`    — export / import cookies + storage for domain reuse
- `system.*`     — health / uptime / notify / downloads / clipboard / version
- `vision.*`     — locate (model-based element locate) / read (OCR)
- `behavior.*`   — recording start/stop/export for session replay

Legacy flat names (`tabs_list`, `click`, `navigate`, `get_page_content`, ...)
are automatically re-routed to their dotted equivalents through
`tools/aliases.js`, so older agent harnesses keep working without changes.

## Development

```bash
# Install dependencies
bun install

# Run extension in dev mode
bun run ext:dev

# Run server locally
bun run server:dev

# Run the fast default validation contract
npm test

# Run the full validation surface
npm run test:all

# Run a single issue regression suite
npm run test:issue -- --issue=27

# Run the pull-request verification contract
npm run verify:pr

# Create an isolated issue worktree
npm run issue:worktree -- --issue 26 --branch feat/worktree-pr-isolation-ops

# Verify that a PR only contains issue-scoped files
npm run verify:issue-scope -- --issue 26 --branch feat/worktree-pr-isolation-ops --base origin/main --allow README.md --allow docs/ --allow scripts/ --allow package.json

# Build for production
bun run build

# Run the deterministic primitive regression suite
bun run test:deterministic

# Deploy server to Cloudflare
bun run deploy:server

# Package extension for Chrome Web Store
npm run ext:package

# Create an isolated issue worktree
npm run issue:worktree -- --issue 26 --branch feat/worktree-pr-isolation-ops

# Verify that a PR only contains issue-scoped files
npm run verify:issue-scope -- --issue 26 --branch feat/worktree-pr-isolation-ops --base origin/main --allow README.md --allow docs/ --allow scripts/ --allow package.json

# Run the workflow regression tests for worktree and PR isolation
npm run test:issue-worktree
```

## Issue-Scoped Cloud Execution

Cloud executors must not implement features from a dirty default checkout. OpenSIN-Bridge now standardizes issue work in dedicated worktrees under `/Users/jeremy/dev/clean-worktrees/` with an explicit PR isolation gate.

- Workflow: [`docs/ISSUE_SCOPED_EXECUTION.md`](docs/ISSUE_SCOPED_EXECUTION.md)
- Review checklist: [`docs/PR_ISOLATION_CHECKLIST.md`](docs/PR_ISOLATION_CHECKLIST.md)
- Worktree helper: `npm run issue:worktree -- --issue <n> --branch <branch>`
- Scope gate: `npm run verify:issue-scope -- ...`
- Regression tests: `npm run test:issue-worktree`

## License

**PROPRIETARY** - All rights reserved. This software is NOT open source.
The server-side code is trade secret material and must NEVER be published publicly.

---

*OpenSIN-AI - Autonomous AI Agent Ecosystem*


## Behavior Timeline Capture

OpenSIN-Bridge now includes a core behavior-timeline capture layer for issue set #17 / #21 / #24.

- **Durable storage:** session events are written into an IndexedDB-backed event store in the MV3 service worker.
- **Content-side capture:** the MAIN-world injector emits compact events for clicks, debounced inputs, form submits, and navigation markers.
- **Performance controls:** click throttling, input debouncing, short-window navigation dedupe, buffered flushes, and bounded IndexedDB batch sizes keep capture lightweight.
- **Bridge markers:** `start_recording`, `snapshot`, and `observe` now append marker events into the same session timeline when behavior recording is enabled.

### Verification

```bash
npm test
npm run build
```
