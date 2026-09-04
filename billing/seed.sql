-- ═══════════════════════════════════════════════════════════════════
-- The catalogue, as rows.
--
-- Plan ids must match keys of PLANS in `licence/entitlements.js` — that is
-- where what a plan UNLOCKS is decided, and a plan id here that does not
-- exist there resolves to free, which looks exactly like a failed purchase.
--
-- THE AMOUNTS BELOW ARE PLACEHOLDERS. They exist so a fresh database is
-- usable end to end; set the real ones before this Worker takes money, and
-- set `stripe_price_id` from the price object created in the Stripe
-- dashboard — a Stripe row with a null price id cannot be checked out.
-- ═══════════════════════════════════════════════════════════════════

INSERT OR REPLACE INTO plans (id, label, blurb, status, sort_order, created_at) VALUES
  ('pro', 'Pro', 'Hosted escalation and the VibeVoice speech tier. Flash, Max and the built-in voices stay free.', 'active', 1, unixepoch() * 1000);

-- Card, worldwide. Minor units: USD is cents.
INSERT OR REPLACE INTO prices (id, plan_id, rail, interval, amount, currency, stripe_price_id, status, created_at) VALUES
  ('price_pro_month_usd', 'pro', 'stripe', 'month', 1000, 'USD', NULL, 'active', unixepoch() * 1000),
  ('price_pro_year_usd',  'pro', 'stripe', 'year', 10000, 'USD', NULL, 'active', unixepoch() * 1000);

-- Mobile money, Tanzania. TZS has no practical subunit, so these are whole
-- shillings — not cents. Renewal is a fresh prompt, not a stored mandate.
INSERT OR REPLACE INTO prices (id, plan_id, rail, interval, amount, currency, stripe_price_id, status, created_at) VALUES
  ('price_pro_month_tzs', 'pro', 'lipia', 'month', 25000, 'TZS', NULL, 'active', unixepoch() * 1000),
  ('price_pro_year_tzs',  'pro', 'lipia', 'year', 250000, 'TZS', NULL, 'active', unixepoch() * 1000);
