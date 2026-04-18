# OpenSIN-Bridge Architecture

> Last updated: 2026-04-09

## 1. Overview

OpenSIN-Bridge is a paid SaaS product (5 EUR/month) that provides autonomous browser automation through a Chrome Extension + Server-Side Intelligence architecture.

The key insight: **Chrome extensions cannot protect source code** (Google forbids obfuscation, Manifest V3 forbids remote code loading). Therefore, we split the product into:

- **Extension (Thin Client + Deterministic Runtime):** The extension still stays thin, but it now exposes a tiny evidence-based deterministic primitive layer for known UI controls such as Save / Continue / Submit. This code is visible to users — and that is fine because it contains no secrets and only bounded rules.
- **Server (Adaptive Fallback):** Cloudflare Workers still own the adaptive path, persona logic, and study evaluation. The server is now invoked only after the deterministic layer declines to act, which reduces unnecessary inference while preserving the existing fallback behavior.

## 2. Threat Model

### What We Protect Against

| Threat | Mitigation |
|--------|-----------|
| Competitor clones extension | Extension is worthless without server — they get an empty shell |
| User reverse-engineers extension | Nothing valuable to find — just DOM scrapers and fetch() calls |
| Someone builds their own server | They don't know our LLM prompts, decision trees, or anti-detection logic |
| API abuse / freeloading | Every request requires valid JWT + active Stripe subscription |
| Credential theft | All secrets are server-side Cloudflare env vars, never in extension |
| Session hijacking | Short-lived JWTs (15min), refresh tokens in httpOnly cookies |

### What We Accept

| Accepted Risk | Reasoning |
|--------------|-----------|
| Extension code is readable | By design — it's a thin client with no secrets |
| DOM extraction logic is copyable | DOM structure is public anyway, no competitive advantage |
| Someone can see our API endpoints | Endpoints are useless without valid auth + subscription |

## 3. Authentication Flow

```
1. User installs extension (free, from Chrome Web Store)
2. Extension shows login popup
3. User clicks "Sign Up" -> redirects to my.opensin.ai/signup
4. User creates account (Supabase Auth) + pays 5 EUR/mo (Stripe Checkout)
5. Stripe webhook -> Supabase updates subscription status
6. User logs in via extension popup
7. Extension receives JWT (15min TTL) + refresh token
8. Every API call includes: Authorization: Bearer <JWT>
9. Server validates: JWT valid? Subscription active? Rate limit ok?
10. If all checks pass -> server processes request and returns result
11. If any check fails -> 401/402/429 error, extension shows paywall
```

## 4. API Design

### Extension -> Server Communication

All communication happens via HTTPS REST API to Cloudflare Workers.

```
POST /api/v1/decide
  Body: { dom_snapshot, current_url, study_id, context }
  Auth: Bearer JWT
  Response: { action: "click", selector: "#submit-btn", deterministic: true }   // when a known primitive matches
           { action: "click", selector: "#submit-btn", delay: 3.2 }             // when the adaptive fallback is needed

POST /api/v1/evaluate-study
  Body: { study_title, study_description, reward, duration }
  Auth: Bearer JWT
  Response: { accept: true, reasoning: "Good reward/time ratio", risk: "low" }

POST /api/v1/persona
  Body: { question_text, question_type, options, current_url }
  Auth: Bearer JWT
  Response: { answer: "No", confidence: 1, deterministic: true }   // when a known Prolific rule matches
           { answer: "Option B", confidence: 0.92 }                 // fallback path

GET /api/v1/subscription/status
  Auth: Bearer JWT
  Response: { active: true, plan: "pro", expires: "2026-05-09T..." }

POST /api/v1/auth/login
  Body: { email, password }
  Response: { jwt, refresh_token, user_id }

POST /api/v1/auth/refresh
  Body: { refresh_token }
  Response: { jwt, refresh_token }
```

### Runtime Split: Deterministic First, Adaptive Second

These functions exist ONLY on the server and are NEVER callable from the extension:

- `llm_decide(context)` - The adaptive fallback once deterministic primitives decline
- `evaluate_risk(study)` - Anti-detection risk scorer
- `generate_persona(profile)` - Dynamic persona generator
- `humanize_timing(action)` - Human emulation delay calculator
- `check_anti_detection(fingerprint)` - Fingerprint analysis

The extension-side deterministic runtime is intentionally limited to:

- matching explicit Save / Continue / Submit button families
- consulting a tiny shared registry of approved site-specific UI shapes before any adaptive step
- surfacing deterministic metadata inside DOM snapshots, including the matched site-profile when a shape rule fires
- bypassing screenshot-based guessing when a known button can be resolved from the live accessibility tree
- returning `null` immediately for unknown or ambiguous elements so the existing adaptive fallback remains untouched

## 5. Deployment Architecture

```
Chrome Web Store
     |
     v
[Extension] --HTTPS--> [Cloudflare Workers] ---> [Supabase]
                              |                       |
                              |                       +-> Auth (users)
                              |                       +-> Subscriptions
                              |                       +-> Usage logs
                              |                       +-> License keys
                              |
                              +---> [A2A-SIN-Stripe]
                              |       +-> Checkout Sessions
                              |       +-> Webhook Events
                              |       +-> Customer Portal
                              |
                              +---> [OpenAI API]
                                      +-> LLM Decisions
                                      +-> Persona Generation
```

## 6. Revenue Model

| Metric | Target |
|--------|--------|
| Price | 5 EUR/month per user |
| Free tier | None (paywall after login) |
| Trial | 3-day free trial (no CC required) |
| Break-even | ~50 paying users (250 EUR/mo covers infra) |
| Target MRR (6mo) | 500 EUR (100 users) |
| Target MRR (12mo) | 2,500 EUR (500 users) |

### Cost Structure

| Item | Monthly Cost |
|------|-------------|
| Cloudflare Workers | 0 EUR (free tier) |
| Supabase | 0 EUR (free tier up to 50k MAU) |
| Stripe fees | ~2.9% + 0.30 EUR per tx |
| OpenAI API | ~0.50 EUR per user/month |
| Chrome Web Store | 5 USD one-time |
| **Total per user** | **~0.65 EUR** |
| **Margin per user** | **~4.35 EUR (87%)** |

## 7. Runtime Self-Healing Observation Loop

The bridge runtime now verifies `click_ref` interactions inside the extension instead of treating a successful event dispatch as proof that the page changed.

### Verification flow

1. Capture a **before** observation snapshot with accessibility-tree state plus a CDP screenshot.
2. Execute the primary interaction strategy (`cdp_mouse`).
3. Capture an **after** observation snapshot.
4. Score the result with deterministic signals:
   - DOM diff from the accessibility tree
   - visual diff from screenshot length + checksum heuristics
   - URL change
   - title change
5. If all signals remain unchanged, classify the attempt as a **no-op** and automatically retry with fallback strategies (`dom_click`, then `dom_dispatch`).
6. Persist the attempt evidence and expose it through `get_interaction_proof`.

### Boundary split

- **`service_worker.js`** collects snapshots, executes strategies, and stores proof bundles.
- **`observation-runtime.mjs`** stays pure and testable; it only compares evidence and classifies outcomes.
- **`server.js`** advertises the new runtime surfaces so MCP clients can call them directly.

## 8. Human-Entropy Interaction Hardening

- All service-worker click, hover, iframe, CAPTCHA, and vision interaction paths must route through shared human-entropy helpers.
- The shared helpers must emit movement, coordinate jitter, non-zero dwell, and non-deterministic timing instead of instant center clicks.
- Raw `mousePressed` / `mouseReleased` CDP sequences are allowed only inside the shared helper so tests can detect handler-level regressions immediately.

## 9. Security Checklist

- [ ] Extension contains ZERO API keys
- [ ] Extension contains ZERO LLM prompts
- [ ] Extension contains ZERO secrets and only bounded deterministic primitives
- [ ] Unknown or ambiguous decisions still fall back to the server-side adaptive path
- [ ] JWT tokens expire in 15 minutes
- [ ] Refresh tokens are rotated on use
- [ ] Rate limiting: 100 requests/hour per user
- [ ] Stripe webhook signature verification
- [ ] Supabase RLS (Row Level Security) enabled
- [ ] CORS restricted to extension origin only
- [ ] CSP headers on all responses
- [ ] Server code NEVER published to any public repo


## 8. Behavior Timeline Capture Core

The extension now maintains a unified behavior timeline in the MV3 layer.

- The **content injector** captures clicks, debounced inputs, form submits, and navigation markers directly from the page context.
- The **service worker** keeps a session-scoped in-memory buffer and persists bounded batches into **IndexedDB** so session history survives worker restarts.
- Existing bridge surfaces such as `start_recording`, `snapshot`, and `observe` append marker events into the same timeline, which keeps higher-level observation artifacts aligned with low-level user actions.
- Privacy-sensitive input values are redacted in the service worker before they are committed to persistent storage.
