# Deployment Guide: OpenSIN-Bridge

This guide explains how to push the SaaS architecture to production (Option 3).

## 1. Supabase Initialization (The Database)
Run the following SQL commands in your Supabase SQL Editor:
```sql
-- Subscriptions
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own subscription" ON subscriptions FOR SELECT USING (auth.uid() = user_id);
```

## 2. Cloudflare Workers (The Secret Sauce API)
The LLM and Persona logic lives in Cloudflare Workers. Do not deploy the `extension/` folder here, only `server/`.

```bash
# 1. Install Wrangler CLI
bun install -g wrangler

# 2. Authenticate
wrangler login

# 3. Add Secrets (Crucial for SaaS functionality)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put OPENAI_API_KEY

# 4. Deploy to Edge (api.opensin.ai)
bun run deploy:server
```

### Environment matrix

Non-sensitive runtime variables:
- `PORT`
- `TOOL_TIMEOUT_MS`
- `EXTENSION_STALE_MS`
- `KEEPALIVE_URL`

Secrets (never commit values to git):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

## 3. Chrome Web Store (The Thin Client)
The extension itself is free to download but useless without a subscription.
```bash
# Zip the extension
bun run ext:package
```
Upload the resulting `opensin-bridge-extension.zip` to the Chrome Developer Dashboard. Set the price to **Free**, as billing is handled entirely by our Stripe/Supabase backend.
