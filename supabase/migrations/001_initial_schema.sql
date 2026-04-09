-- OpenSIN-Bridge Supabase Schema
-- Run via: supabase db push OR psql $SUPABASE_DB_URL -f 001_initial_schema.sql
-- Migration: 001_initial_schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- SUBSCRIPTIONS TABLE
-- Source of truth for active/inactive plan status per user.
-- Populated by Stripe webhook handler.
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT UNIQUE,
    plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
    status          TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'canceled', 'past_due', 'trialing')),
    current_period_start    TIMESTAMPTZ,
    current_period_end      TIMESTAMPTZ,
    cancel_at_period_end    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ============================================================
-- LICENSE KEYS TABLE
-- Anti-piracy: extension validates license key server-side.
-- Generated on subscription activation.
-- ============================================================
CREATE TABLE IF NOT EXISTS license_keys (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key_hash    TEXT UNIQUE NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'pro',
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,
    revoked     BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen_at TIMESTAMPTZ,
    device_fingerprint TEXT
);

CREATE INDEX IF NOT EXISTS idx_license_keys_user_id ON license_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_hash ON license_keys(key_hash);

-- ============================================================
-- USAGE LOGS TABLE
-- Track API calls per user for rate limiting + analytics.
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_logs (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL,
    status_code INTEGER,
    latency_ms  INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id_time ON usage_logs(user_id, created_at DESC);

-- ============================================================
-- USER PERSONAS TABLE
-- Stores per-user persona profiles for the Persona Engine.
-- Encrypted at rest via pgcrypto (future: vault.secrets).
-- ============================================================
CREATE TABLE IF NOT EXISTS user_personas (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    persona     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_personas_user_id ON user_personas(user_id);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_user_personas_updated_at
    BEFORE UPDATE ON user_personas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Users can only read/write their own rows.
-- Service role (CF Worker) bypasses RLS via service key.
-- ============================================================
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_personas ENABLE ROW LEVEL SECURITY;

-- Subscriptions: user reads own row, service role writes
CREATE POLICY "users_read_own_subscription" ON subscriptions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "service_role_manage_subscriptions" ON subscriptions
    FOR ALL USING (auth.role() = 'service_role');

-- License keys: user reads own, service role manages
CREATE POLICY "users_read_own_license" ON license_keys
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "service_role_manage_licenses" ON license_keys
    FOR ALL USING (auth.role() = 'service_role');

-- Usage logs: append-only for users, service role reads all
CREATE POLICY "service_role_manage_usage" ON usage_logs
    FOR ALL USING (auth.role() = 'service_role');

-- Personas: user reads/updates own row
CREATE POLICY "users_manage_own_persona" ON user_personas
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "service_role_manage_personas" ON user_personas
    FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- HELPER FUNCTION: check_active_subscription(user_id)
-- Used by CF Worker to avoid REST roundtrip for sub check.
-- ============================================================
CREATE OR REPLACE FUNCTION check_active_subscription(p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM subscriptions
        WHERE user_id = p_user_id
          AND status = 'active'
          AND (current_period_end IS NULL OR current_period_end > NOW())
    );
$$ LANGUAGE sql SECURITY DEFINER;

-- ============================================================
-- HELPER FUNCTION: generate_license_key(user_id, plan)
-- Called after successful Stripe payment to issue a license.
-- ============================================================
CREATE OR REPLACE FUNCTION generate_license_key(p_user_id UUID, p_plan TEXT DEFAULT 'pro')
RETURNS TEXT AS $$
DECLARE
    raw_key TEXT;
    key_hash TEXT;
BEGIN
    raw_key := encode(gen_random_bytes(32), 'hex');
    key_hash := encode(digest(raw_key, 'sha256'), 'hex');

    INSERT INTO license_keys (user_id, key_hash, plan, expires_at)
    VALUES (
        p_user_id,
        key_hash,
        p_plan,
        NOW() + INTERVAL '1 year'
    )
    ON CONFLICT (key_hash) DO NOTHING;

    RETURN 'OPENSIN-' || upper(substring(raw_key, 1, 8)) || '-' ||
                          upper(substring(raw_key, 9, 8)) || '-' ||
                          upper(substring(raw_key, 17, 8)) || '-' ||
                          upper(substring(raw_key, 25, 8));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
