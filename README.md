# OpenSIN-Bridge\n\n> **OpenSIN ist keine Software. Es ist eine digitale Belegschaft.**\n> Die Bridge ist die sichere Tuer, durch die Nutzer auf die Intelligenz unserer Agenten zugreifen. Der Agent arbeitet (z.B. auf Prolific), die Intelligenz bleibt im Server.\n

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
+-- extension/           # Chrome Extension (Thin Client - publishable)
|   +-- manifest.json
|   +-- background/      # Service Worker
|   +-- content/         # Content Scripts (DOM extraction)
|   +-- popup/           # Login + License UI
|   +-- icons/
+-- server/              # Cloudflare Workers (SECRET SAUCE)
|   +-- src/
|   |   +-- routes/      # API endpoints
|   |   +-- middleware/   # Auth, rate limiting, license check
|   |   +-- services/    # LLM engine, persona, anti-detection
|   +-- wrangler/        # Cloudflare config
+-- docs/                # Architecture documentation
+-- scripts/             # Build, deploy, publish scripts
+-- .github/workflows/   # CI/CD (n8n dispatch)
```

## Development

```bash
# Install dependencies
npm install

# Run extension in dev mode
npm run ext:dev

# Run server locally
npm run server:dev

# Build for production
npm run build

# Run the deterministic primitive regression suite
npm run test:deterministic

# Deploy server to Cloudflare
npm run deploy:server

# Package extension for Chrome Web Store
npm run ext:package
```

## DOM Discovery Coverage

The content/injection layer now performs recursive discovery across the reachable DOM surface instead of only scanning the light DOM.

- `__SIN_BRIDGE__.$()` / `$$()` and the compatibility helpers `_sinDeepQuery()` / `_sinDeepQueryAll()` traverse nested **open shadow roots** recursively.
- `snapshot()` includes links, inputs, and buttons found inside nested open shadow roots and inside **same-origin** `iframe` / `frame` documents.
- Snapshot payloads include `location` metadata plus `limitations` entries for skipped cross-origin frames so operators can see when discovery was intentionally incomplete.

### Explicit limitations

- **Closed shadow roots** are excluded by design because page JavaScript cannot introspect them. OpenSIN documents that limitation instead of pretending those elements are visible.
- **Cross-origin iframes** cannot be traversed from the top-page content script because the browser blocks access to their `contentDocument`. Those frames are reported in snapshot limitations and require a separate injection context if support is needed later.
- The current traversal logic is read/query focused. It preserves the existing content-script contract while extending selector-based read/mutate helpers to the same reachable DOM surface.

### Verification

Run `npm test` to execute the default OpenSIN regression contract. That command now runs every `test/*.test.js` file so newly added issue-scoped regressions are not silently skipped.

## Validation Contract

- `npm test`: default local and PR validation command. Use this before review because it exercises the full checked-in Node test suite.
- `npm run test:all`: explicit alias for the same full-suite contract. Use this in docs, CI notes, or PR checklists when you want to signal "run everything" without ambiguity.
- `node --test test/<surface>.test.js`: focused verification for the surface you are actively changing. Use this while iterating on a specific issue, then finish with `npm test` before claiming the branch is ready.

Examples:

```bash
npm test
npm run test:all
node --test test/native-host.test.js
node --test test/bridge.test.js
```

## Native Messaging Host

The authenticated-session / CSP-restricted fallback is documented in [`docs/NATIVE_MESSAGING_HOST.md`](docs/NATIVE_MESSAGING_HOST.md).

Key surfaces:

- `native_host_status`
- `native_host_ping`
- `native_host_start_workflow`
- `native_host_authenticated_fetch`
- `native_host_end_workflow`

## License

**PROPRIETARY** - All rights reserved. This software is NOT open source.
The server-side code is trade secret material and must NEVER be published publicly.

---

*OpenSIN-AI - Autonomous AI Agent Ecosystem*

---

## 🚨 MISSION CRITICAL MANDATE: NO AUTORUN. NO BLIND CLICKS.

Please see the absolute, top-priority rulebook in [`AGENTS.md`](./AGENTS.md). 
**ANY automation, script, or agent utilizing this bridge MUST implement the 10-step Vision Gate Loop.**
Escalating click chains without interim vision checks are strictly **banned**. EVERY SINGLE STAGE must be visually verified.
