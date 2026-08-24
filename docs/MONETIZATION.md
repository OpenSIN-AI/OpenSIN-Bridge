# OpenSIN-Bridge Monetization Strategy

> Last updated: 2026-04-09

## 1. Why This Architecture?

### The Chrome Extension Dilemma

| Fact | Source |
|------|--------|
| Chrome extensions are 100% client-side — anyone can read the code | Chrome Dev Docs |
| Google FORBIDS obfuscation in Chrome Web Store | [Chrome Policy: Code Readability](https://developer.chrome.com/docs/webstore/program-policies/code-readability) |
| Manifest V3 FORBIDS remote code loading | Chrome MV3 Migration Guide |
| Google deprecated Chrome Web Store payments in 2020 | Chrome Web Store Docs |
| Self-hosting outside Chrome Web Store works ONLY on Linux or via Enterprise Policies | Chrome Distribution Docs |

### Our Solution: Thin-Client + Server-Side Brain

The extension is deliberately worthless on its own. It's a remote control for our server. The server is where ALL the value lives — and competitors can never see or copy it.

## 2. Pricing Strategy

### Why 5 EUR/month?

| Factor | Reasoning |
|--------|-----------|
| Market research | Most Chrome extension SaaS products charge 5-15 USD/month |
| User psychology | 5 EUR feels like "lunch money" — low friction to convert |
| Margin | 87% margin after costs (0.65 EUR cost per user) |
| Competition | No direct competitor offers autonomous Prolific automation |
| Value delivered | Users earn 50-200 EUR/month passively — 5 EUR is 2.5-10% fee |

### Pricing Tiers

| Tier | Price | Target |
|------|-------|--------|
| **Free Install** | 0 EUR | Everyone (maximizes Chrome Web Store rankings) |
| **OpenSIN Pro** | 5 EUR/month | Individual researchers / passive income seekers |
| **OpenSIN Team** | 15 EUR/month | Agencies, 5 seats, priority support |
| **OpenSIN Enterprise** | Custom | Universities, research labs, API access |

## 3. Payment Implementation

### Stripe Integration

```
User Flow:
1. Install extension (free)
2. Click "Upgrade to Pro" in extension popup
3. Redirect to Stripe Checkout (hosted page)
4. Pay 5 EUR/month
5. Stripe webhook fires -> our server updates Supabase
6. User's JWT now includes { plan: "pro", active: true }
7. Extension works!

Cancellation:
1. User clicks "Manage Subscription" in extension
2. Redirect to Stripe Customer Portal
3. User cancels
4. Stripe webhook fires at period end -> Supabase updates
5. User's next JWT will have { plan: "free", active: false }
6. Extension shows paywall again
```

### Stripe Configuration

- **Product:** OpenSIN Bridge Pro
- **Price:** 5.00 EUR / month (recurring)
- **Trial:** 3 days free (no CC required for trial)
- **Tax:** Stripe Tax handles EU VAT automatically
- **Invoicing:** Automatic via Stripe
- **Webhook events:** `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

### Supabase Schema

```sql
-- Users (managed by Supabase Auth)
-- auth.users table is automatic

-- Subscriptions
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'inactive',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- License Keys
CREATE TABLE license_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',
  activated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true
);

-- Usage Tracking
CREATE TABLE usage_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS Policies
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can read own license"
  ON license_keys FOR SELECT
  USING (auth.uid() = user_id);
```

## 4. Distribution Strategy

### Chrome Web Store (Primary)

- Free to install
- Extension popup shows paywall immediately
- High visibility, automatic updates
- 5 USD one-time developer fee

### Direct Download (Secondary)

- Available from my.opensin.ai after login
- For users who prefer manual install
- Same paywall logic — server-side validation

### NOT doing:

- No Firefox addon (Chrome only for now)
- No Edge addon (maybe later via same MV3 code)
- No Safari extension (different architecture)

## 5. Marketing Channels

| Channel | Strategy |
|---------|----------|
| Chrome Web Store SEO | Keywords: "prolific automation", "survey automation", "passive income" |
| Reddit | r/prolific, r/beermoney, r/passiveincome — authentic posts showing earnings |
| YouTube | Screen recordings of the extension earning money autonomously |
| Blog | blog.opensin.ai articles on passive income with AI |
| Twitter/X | @OpenSIN_AI — daily earning screenshots |
| Product Hunt | Launch when 50+ users are paying |

## 6. Legal Considerations

- **Terms of Service:** Users responsible for compliance with Prolific ToS
- **Privacy Policy:** Required for Chrome Web Store submission
- **GDPR:** Supabase handles EU data residency
- **VAT:** Stripe Tax handles EU VAT calculation + collection
- **Refund Policy:** 30-day money-back guarantee (reduces chargebacks)
