/**
 * The few queries used from more than one route, and the rules about time that
 * go with them.
 *
 * Everything here is milliseconds, matching `Date.now()` and the schema.
 * Seconds appear in exactly one place — inside a signed licence — and the
 * conversion happens in `licence.js`, not scattered through callers.
 */

import { DEFAULT_PLAN } from "../../../licence/entitlements.js";
import { sha256Hex } from "./crypto.js";

export const now = () => Date.now();

/**
 * How long past `current_period_end` a subscription still entitles.
 *
 * This is the dunning window, and it is not the same thing as the licence's
 * offline `grace`. Grace answers "the user has no network"; this answers "the
 * renewal has not landed yet" — a Lipia charge prompt the user has not opened,
 * or a Stripe retry ladder still running. Three days because a mobile-money
 * renewal genuinely can wait for payday, and cutting off a paying customer
 * over a timing detail costs far more than three days of service.
 */
export const DUNNING_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Resolve a bearer token to its user, and touch the session.
 *
 * Returns null for absent, unknown AND expired. The caller gets one "not
 * signed in", because telling a caller that a token was once valid is
 * information it has no use for and an attacker does.
 */
export async function userForToken(env, token) {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, now())
    .first();
  if (!row) return null;

  await env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").bind(now(), hash).run();
  return row;
}

/** Is this subscription paying out right now? */
export function subscriptionEntitles(subscription, at = now()) {
  if (!subscription) return false;
  if (subscription.status !== "active" && subscription.status !== "past_due" && subscription.status !== "canceled") return false;
  // `canceled` still runs to the end of the period that was paid for; what it
  // does not get is the dunning window, because nobody is going to renew it.
  const window = subscription.status === "canceled" ? 0 : DUNNING_GRACE_MS;
  return subscription.current_period_end + window > at;
}

/** The subscription row for a user, whatever state it is in. */
export async function subscriptionFor(env, userId) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY current_period_end DESC LIMIT 1").bind(userId).first();
}

/**
 * Which plan a user is on, right now.
 *
 * The single question the licence route asks. Falls back to free for every
 * failure — no subscription, a lapsed one, a plan id that no longer exists —
 * because the free plan is a working product, and a billing edge case must
 * never present as a broken app.
 */
export async function planForUser(env, userId, at = now()) {
  const subscription = await subscriptionFor(env, userId);
  if (!subscriptionEntitles(subscription, at)) return { planId: DEFAULT_PLAN, subscription };
  return { planId: subscription.plan_id, subscription };
}

/* ── Rate limits ───────────────────────────────────────────────────
   Counted as rows in D1 rather than in a counter store: both limits are
   per ten minutes at single-digit thresholds, both tables are indexed for
   exactly this query, and adding KV or a Durable Object to the money path
   buys precision nobody needs and a dependency somebody has to reason about
   at 2am.

   It is a floor, not a firewall. Someone rotating IPs gets through, and that
   is fine — the job is to stop one broken client or one bored person from
   burning the OAuth quota or making a stranger's handset buzz all evening. */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_DEVICE_STARTS = 10;
const MAX_ORDERS = 5;

export async function tooManyDeviceStarts(env, ip) {
  // 'unknown' means the header was absent — `wrangler dev` locally, or a
  // misconfigured proxy. Lumping every such caller into one bucket would rate
  // limit local development into uselessness.
  if (ip === "unknown") return false;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM device_auths WHERE created_ip = ? AND created_at > ?")
    .bind(ip, now() - WINDOW_MS)
    .first();
  return (row?.n ?? 0) >= MAX_DEVICE_STARTS;
}

export async function tooManyOrders(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND created_at > ?")
    .bind(userId, now() - WINDOW_MS)
    .first();
  return (row?.n ?? 0) >= MAX_ORDERS;
}

/** One active price, or null. Orders are only ever created against an active price. */
export async function activePrice(env, priceId) {
  if (typeof priceId !== "string" || !priceId) return null;
  return env.DB.prepare("SELECT * FROM prices WHERE id = ? AND status = 'active'").bind(priceId).first();
}
