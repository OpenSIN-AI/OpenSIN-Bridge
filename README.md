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

# Deploy server to Cloudflare
npm run deploy:server

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
