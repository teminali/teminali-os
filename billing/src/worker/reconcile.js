/**
 * The sweep for money nobody is watching.
 *
 * `GET /api/orders/:id` reconciles for the buyer who is standing there with
 * their phone in their hand. This is for the one who approved the payment and
 * closed the laptop, or whose app crashed, or who lost signal between the PIN
 * and the confirmation — and for them a webhook that failed its last retry
 * means money taken and nothing granted.
 *
 * Three jobs on one two-minute tick, in the order they matter:
 *
 *   1. settle open Lipia orders against Lipia
 *   2. prompt Lipia renewals that are due
 *   3. expire subscriptions that ran out and were not renewed
 *
 * All three settle through the same functions the webhooks use, which is why a
 * sweep racing a callback grants once rather than twice.
 */

import { now, subscriptionEntitles } from "./db.js";
import { MAX_RENEW_ATTEMPTS } from "./fulfil.js";
import * as lipia from "./lipia.js";

/**
 * After this long an open order is given up on.
 *
 * The handset prompt expires long before this. The generous window is not
 * about the handset — it is so a Lipia outage lasting hours does not turn into
 * a pile of orders wrongly marked expired, because "expired" is a state a
 * buyer reads as "you were not charged".
 */
const GIVE_UP_AFTER_MS = 6 * 60 * 60 * 1000;

/** Kept small: a sweep that takes longer than its interval overlaps itself. */
const BATCH = 25;

export async function sweep(env) {
  const result = { orders: 0, paid: 0, failed: 0, expired: 0, unreachable: 0, renewed: 0, lapsed: 0 };

  await reconcileOpenOrders(env, result);
  await promptDueRenewals(env, result);
  await expireLapsed(env, result);

  return result;
}

async function reconcileOpenOrders(env, result) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders
      WHERE rail = 'lipia' AND status IN ('created', 'charging') AND reconcile_after < ?
      ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(now(), BATCH)
    .all();

  for (const order of results ?? []) {
    result.orders += 1;

    if (now() - order.created_at > GIVE_UP_AFTER_MS) {
      await env.DB.prepare(
        `UPDATE orders SET status = 'expired', updated_at = ?,
                failure_reason = 'No confirmation arrived. If you were charged, contact support with this order id.'
          WHERE id = ? AND status != 'paid'`,
      )
        .bind(now(), order.id)
        .run();
      result.expired += 1;
      continue;
    }

    if (!order.lipia_transaction_id) {
      // Charged but no transaction id means the charge call itself never came
      // back. There is nothing to ask Lipia about, so it is left to age out.
      result.unreachable += 1;
      continue;
    }

    try {
      const answer = await lipia.getTransaction(env, order.lipia_transaction_id);
      const state = await lipia.settle(env, order, answer?.data ?? {});
      if (state === "paid") result.paid += 1;
      else if (state === "failed" || state === "refunded") result.failed += 1;
    } catch {
      // Lipia unreachable. Push the next attempt out rather than hammering a
      // service that is already having a bad time.
      result.unreachable += 1;
      await env.DB.prepare("UPDATE orders SET reconcile_after = ?, updated_at = ? WHERE id = ?")
        .bind(now() + 5 * 60 * 1000, now(), order.id)
        .run();
    }
  }
}

/**
 * Prompt the renewals that are due.
 *
 * Only the Lipia rail. Stripe renews itself and tells us by webhook, so a
 * Stripe row appearing here would be a second charge for a period already
 * paid — which is why `grantPeriod` writes `renew_after` as null for it and
 * this query requires the column to be set.
 */
async function promptDueRenewals(env, result) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscriptions
      WHERE rail = 'lipia' AND status IN ('active', 'past_due')
        AND cancel_at_period_end = 0
        AND renew_after IS NOT NULL AND renew_after < ?
        AND renew_attempts < ?
      ORDER BY renew_after ASC LIMIT ?`,
  )
    .bind(now(), MAX_RENEW_ATTEMPTS, BATCH)
    .all();

  for (const subscription of results ?? []) {
    const price = subscription.price_id
      ? await env.DB.prepare("SELECT * FROM prices WHERE id = ?").bind(subscription.price_id).first()
      : null;
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(subscription.user_id).first();

    // A price that was retired since the subscription started must not silently
    // become a different price. The renewal stops and the user is asked to
    // choose again — losing a subscription is better than charging a number
    // nobody agreed to.
    if (!price || price.status !== "active" || !user || !subscription.msisdn) {
      await env.DB.prepare("UPDATE subscriptions SET renew_after = NULL, updated_at = ? WHERE id = ?").bind(now(), subscription.id).run();
      continue;
    }

    // Counted before the attempt, not after: a charge call that throws must
    // still cost an attempt, or a permanently failing subscription prompts a
    // handset every two minutes forever.
    await env.DB.prepare(
      `UPDATE subscriptions
          SET renew_attempts = renew_attempts + 1, renew_after = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(now() + 6 * 60 * 60 * 1000, now(), subscription.id)
      .run();

    try {
      await lipia.startCharge(env, { user, price, msisdn: subscription.msisdn, kind: "renewal", subscriptionId: subscription.id });
      result.renewed += 1;
    } catch (error) {
      console.error("renewal charge failed", subscription.id, error?.message);
    }
  }
}

/**
 * Retire subscriptions that ran out.
 *
 * `planForUser` already refuses to count these, so this is bookkeeping rather
 * than enforcement — but a `status` that stays 'active' on a subscription that
 * expired months ago makes every support question and every revenue query
 * wrong, and eventually someone trusts it.
 */
async function expireLapsed(env, result) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscriptions WHERE status IN ('active', 'past_due', 'canceled') AND current_period_end < ? LIMIT ?`,
  )
    .bind(now(), BATCH)
    .all();

  for (const subscription of results ?? []) {
    if (subscriptionEntitles(subscription)) continue;
    await env.DB.prepare("UPDATE subscriptions SET status = 'expired', renew_after = NULL, updated_at = ? WHERE id = ?")
      .bind(now(), subscription.id)
      .run();
    result.lapsed += 1;
  }
}
