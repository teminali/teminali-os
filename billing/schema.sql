-- ═══════════════════════════════════════════════════════════════════
-- Teminali Code billing — D1 schema.
--
-- This is the first database in teminaliCode, and it is deliberately not
-- in teminaliCode. The app is `node:http`, manual routing and JSON on
-- disk; that stays true. What lives here is the one thing the app cannot
-- be trusted to hold: the record of who is actually paying. The desktop
-- process runs on hardware the user controls, so a `plan: "pro"` written
-- anywhere on their machine is a ten-second edit. The authority is here;
-- the app only ever verifies a signature.
--
-- Money is INTEGER minor units in the row's own currency. TZS has no
-- practical subunit, so a TZS row is whole shillings and a USD row is
-- cents. Never a float — 0.1 + 0.2 in a ledger is how you get a
-- reconciliation that never closes.
--
-- Timestamps are INTEGER milliseconds since epoch, matching Date.now(),
-- EXCEPT inside a signed licence, where seconds are the format. The
-- conversion happens once, in the signer.
-- ═══════════════════════════════════════════════════════════════════

-- ── Accounts ───────────────────────────────────────────────────────
-- Identity comes from an OAuth device flow (GitHub or Google), so the
-- only credential stored is the provider's stable subject id. There is
-- no password column on purpose: a password we never take is a password
-- we can never leak.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,             -- 'github' | 'google'
  provider_sub  TEXT NOT NULL,             -- stable id at that provider
  email         TEXT,
  name          TEXT,
  avatar_url    TEXT,
  -- Collected at the first mobile-money checkout, not at sign-up: the
  -- phone IS the payment instrument, and asking for it before there is
  -- anything to buy is the friction that loses the account.
  msisdn        TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (provider, provider_sub)
);

-- ── Sessions ───────────────────────────────────────────────────────
-- Opaque bearer tokens, stored as SHA-256 so a database read does not
-- hand over live sessions. The desktop app keeps the plaintext in its
-- 0600 licence store and sends it to refresh a licence.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  -- What the user called this machine, if the app offered to ask. Shown
  -- on a future "your devices" screen; a session you cannot recognise is
  -- a session you cannot decide to revoke.
  device_name  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ── Device-flow authorisations ─────────────────────────────────────
-- The app never sees the provider's device_code and the provider's
-- client secret never leaves this Worker. The app polls US; we poll the
-- provider. That is what keeps an OAuth client secret out of an app that
-- ships as an unpacked asar on every user's disk.
CREATE TABLE IF NOT EXISTS device_auths (
  id                   TEXT PRIMARY KEY,   -- the code WE hand to the app
  provider             TEXT NOT NULL,
  provider_device_code TEXT NOT NULL,
  user_code            TEXT NOT NULL,
  verification_url     TEXT NOT NULL,
  interval_s           INTEGER NOT NULL,
  device_name          TEXT,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  -- 'pending' | 'complete' | 'denied' | 'expired'
  status               TEXT NOT NULL DEFAULT 'pending',
  user_id              TEXT REFERENCES users(id),
  last_polled_at       INTEGER NOT NULL DEFAULT 0,
  -- Counted for rate limiting. Each start costs a round trip to GitHub
  -- or Google against OUR OAuth quota, so it is the cheapest endpoint to
  -- abuse and the most expensive one to have abused.
  created_ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_auths_ip ON device_auths(created_ip, created_at);

-- ── Plans ──────────────────────────────────────────────────────────
-- Deliberately thin. What a plan UNLOCKS is not here — it lives in
-- `licence/entitlements.js`, which the app and this Worker both import,
-- because a capability list in two places is a capability list that
-- disagrees with itself. This table exists so a plan can be listed,
-- priced and retired without a deploy; `id` must match a key of PLANS.
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,            -- 'pro' — matches PLANS in licence/entitlements.js
  label       TEXT NOT NULL,
  blurb       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | retired
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- ── Prices ─────────────────────────────────────────────────────────
-- One row per (plan, rail, interval, currency). Price lives here and not
-- in the app because a price changes without the product changing, and a
-- price shipped inside a build is a price you cannot correct.
--
-- Two rails, deliberately not unified: Stripe holds its own price object
-- and drives renewals itself, while Lipia has no recurring primitive at
-- all — a renewal there is a fresh charge prompt this Worker schedules.
-- `stripe_price_id` is therefore NULL on every Lipia row, and that
-- asymmetry is the honest shape of the two payment systems.
CREATE TABLE IF NOT EXISTS prices (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans(id),
  rail            TEXT NOT NULL,           -- 'stripe' | 'lipia'
  interval        TEXT NOT NULL,           -- 'month' | 'year'
  amount          INTEGER NOT NULL,        -- minor units of `currency`
  currency        TEXT NOT NULL,
  stripe_price_id TEXT,                    -- NULL on the Lipia rail
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prices_plan ON prices(plan_id, status);

-- ── Subscriptions ──────────────────────────────────────────────────
-- The row a licence is minted from. `current_period_end` is the single
-- authority on how long Pro lasts, and the signer clamps a licence's
-- expiry to it — otherwise a seven-day token issued the day before a
-- subscription ends would keep paying out for a week after it did.
--
-- One row per user per plan. A user who cancels and returns reuses the
-- row rather than accumulating history; the ledger of what was actually
-- paid is `orders`, which is append-only and never rewritten.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id),
  plan_id              TEXT NOT NULL REFERENCES plans(id),
  price_id             TEXT REFERENCES prices(id),
  rail                 TEXT NOT NULL,      -- 'stripe' | 'lipia' | 'grant'
  -- 'active'   — paid through current_period_end
  -- 'past_due' — period ended, renewal being attempted (see DUNNING_GRACE_MS)
  -- 'canceled' — the user asked to stop; runs to period end, then expires
  -- 'expired'  — no longer entitled
  status               TEXT NOT NULL DEFAULT 'active',
  current_period_start INTEGER NOT NULL,
  current_period_end   INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  -- Stripe drives its own renewals and tells us via webhook; these are
  -- the join back to it, and the reason a Stripe subscription is never
  -- renewed by our cron.
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  -- Lipia renewals: which handset to prompt, and when the cron should.
  -- Set to NULL on the Stripe rail so the renewal sweep cannot pick up a
  -- subscription Stripe is already handling and charge it twice.
  msisdn               TEXT,
  renew_after          INTEGER,
  renew_attempts       INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (user_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_renew ON subscriptions(status, renew_after);
CREATE INDEX IF NOT EXISTS idx_subs_stripe ON subscriptions(stripe_subscription_id);

-- ── Orders ─────────────────────────────────────────────────────────
-- One row per attempt to take money, on either rail. Append-only: a
-- failed order is marked failed, never deleted, because "did we charge
-- this person?" must be answerable months later from this table alone.
CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id),
  subscription_id      TEXT REFERENCES subscriptions(id),
  price_id             TEXT REFERENCES prices(id),
  plan_id              TEXT NOT NULL,
  rail                 TEXT NOT NULL,      -- 'stripe' | 'lipia'
  -- 'initial' for the first purchase, 'renewal' for a scheduled charge.
  -- Worth a column rather than an inference: a failed renewal and a
  -- failed first purchase need different messages to different people.
  kind                 TEXT NOT NULL DEFAULT 'initial',
  amount               INTEGER NOT NULL,
  currency             TEXT NOT NULL,
  msisdn               TEXT,
  provider             TEXT,               -- vodacom | tigo | airtel | halopesa
  -- 'created' | 'charging' | 'paid' | 'failed' | 'expired'
  status               TEXT NOT NULL DEFAULT 'created',
  failure_reason       TEXT,
  lipia_transaction_id TEXT,
  lipia_status         TEXT,
  stripe_session_id    TEXT,
  stripe_invoice_id    TEXT,
  receipt              TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  -- A pending order older than this is reconciled against the gateway
  -- rather than waited on. A webhook that never arrives must not mean a
  -- buyer who paid never gets what they paid for.
  reconcile_after      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(status, reconcile_after);
CREATE INDEX IF NOT EXISTS idx_orders_lipia ON orders(lipia_transaction_id);

-- ── Webhook log ────────────────────────────────────────────────────
-- Every callback either gateway sends, verified or not. A payment
-- dispute is won or lost on whether you kept the delivery you were sent,
-- and "somebody is posting forged callbacks at us" is a thing you want
-- to be able to see rather than infer.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  rail         TEXT NOT NULL,              -- 'stripe' | 'lipia'
  received_at  INTEGER NOT NULL,
  event        TEXT,
  -- The gateway's own event id, where it has one. UNIQUE so a retried
  -- delivery is recognised as the same delivery rather than replayed.
  external_id  TEXT,
  signature_ok INTEGER NOT NULL,
  order_id     TEXT,
  body         TEXT NOT NULL,
  handled      INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_order ON webhook_events(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_external ON webhook_events(rail, external_id)
  WHERE external_id IS NOT NULL;
