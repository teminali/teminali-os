/**
 * The moment money becomes an entitlement.
 *
 * Both rails and the reconcile sweep settle through `markOrderPaid`, and that
 * is the point: a webhook arriving at the same time as a sweep, or a delivery
 * retried five times, must grant exactly one period. Idempotence here is by
 * construction — an order already marked `paid` returns immediately, and the
 * order row is the lock — rather than by luck.
 *
 * Nothing in this file talks to a payment gateway. It is handed the fact that
 * a specific order was paid, and its job is to turn that into a subscription
 * that `planForUser` will read.
 */

import { newId } from "./crypto.js";
import { now } from "./db.js";

/**
 * When a period that starts now should end.
 *
 * Calendar arithmetic, not 30 days: someone billed on the 15th expects the
 * 15th. The clamp matters — `setUTCMonth` on the 31st of January lands in
 * March, which would silently skip a month of service every February. Backing
 * up to the last day of the target month is what every billing system that has
 * been in production for a year ends up doing.
 */
export function periodEnd(startMs, interval) {
  const date = new Date(startMs);
  const day = date.getUTCDate();
  if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  if (date.getUTCDate() !== day) date.setUTCDate(0);
  return date.getTime();
}

/**
 * How long before the period ends a Lipia renewal is prompted.
 *
 * Two days, because a mobile-money prompt is a person picking up a handset and
 * typing a PIN. Prompting at the last minute means every user who is asleep,
 * out of airtime or on a bus lapses; two days leaves room for the cron to try
 * again without the subscription ever going past due.
 */
export const RENEW_LEAD_MS = 2 * 24 * 60 * 60 * 1000;

/** Give up prompting after this many failed renewal attempts in one period. */
export const MAX_RENEW_ATTEMPTS = 4;

/**
 * Grant or extend the subscription an order paid for.
 *
 * Extends from `current_period_end` rather than from now when the subscription
 * is still live, so an early renewal adds a month rather than throwing away
 * the days already paid for. A lapsed subscription restarts from now — those
 * days are gone and pretending otherwise would sell air.
 */
export async function grantPeriod(env, { user_id, plan_id, price_id, rail, interval, msisdn = null, stripe = null }, at = now()) {
  const existing = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ?").bind(user_id, plan_id).first();

  const start = existing && existing.current_period_end > at ? existing.current_period_end : at;
  const end = periodEnd(start, interval);

  // Stripe renews on its own schedule and tells us by webhook. Leaving
  // `renew_after` set on a Stripe row would let our sweep prompt for money
  // Stripe is already collecting, so it is explicitly null.
  const renewAfter = rail === "lipia" ? end - RENEW_LEAD_MS : null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE subscriptions
          SET plan_id = ?, price_id = ?, rail = ?, status = 'active',
              current_period_start = ?, current_period_end = ?, cancel_at_period_end = 0,
              stripe_customer_id = COALESCE(?, stripe_customer_id),
              stripe_subscription_id = COALESCE(?, stripe_subscription_id),
              msisdn = COALESCE(?, msisdn), renew_after = ?, renew_attempts = 0, updated_at = ?
        WHERE id = ?`,
    )
      .bind(plan_id, price_id, rail, start, end, stripe?.customerId ?? null, stripe?.subscriptionId ?? null, msisdn, renewAfter, at, existing.id)
      .run();
    return { id: existing.id, current_period_start: start, current_period_end: end };
  }

  const id = newId("sub");
  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, user_id, plan_id, price_id, rail, status, current_period_start, current_period_end,
        cancel_at_period_end, stripe_customer_id, stripe_subscription_id, msisdn, renew_after,
        renew_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, user_id, plan_id, price_id, rail, start, end, stripe?.customerId ?? null, stripe?.subscriptionId ?? null, msisdn, renewAfter, at, at)
    .run();
  return { id, current_period_start: start, current_period_end: end };
}

/**
 * Settle a paid order.
 *
 * Returns `{ granted: false }` when the order was already paid, which is the
 * normal case for a retried webhook and not an error worth reporting anywhere.
 */
export async function markOrderPaid(env, order, { receipt = null, transactionId = null, lipiaStatus = null, stripe = null } = {}, at = now()) {
  if (order.status === "paid") return { granted: false, reason: "already_paid" };

  const price = order.price_id ? await env.DB.prepare("SELECT * FROM prices WHERE id = ?").bind(order.price_id).first() : null;
  const interval = price?.interval ?? "month";

  const subscription = await grantPeriod(
    env,
    {
      user_id: order.user_id,
      plan_id: order.plan_id,
      price_id: order.price_id,
      rail: order.rail,
      interval,
      msisdn: order.msisdn,
      stripe,
    },
    at,
  );

  await env.DB.prepare(
    `UPDATE orders
        SET status = 'paid', subscription_id = ?, receipt = COALESCE(?, receipt),
            lipia_transaction_id = COALESCE(?, lipia_transaction_id),
            lipia_status = COALESCE(?, lipia_status),
            stripe_invoice_id = COALESCE(?, stripe_invoice_id),
            failure_reason = NULL, updated_at = ?
      WHERE id = ? AND status != 'paid'`,
  )
    .bind(subscription.id, receipt, transactionId, lipiaStatus, stripe?.invoiceId ?? null, at, order.id)
    .run();

  // Recorded because the phone number on the order is how a renewal is
  // prompted months later, and a user who changes handsets updates it here.
  if (order.msisdn) {
    await env.DB.prepare("UPDATE users SET msisdn = ? WHERE id = ?").bind(order.msisdn, order.user_id).run();
  }

  return { granted: true, subscription };
}

/** Settle a failed order. Never touches the subscription: a failed renewal leaves the period alone. */
export async function markOrderFailed(env, order, reason, at = now()) {
  await env.DB.prepare(
    `UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status NOT IN ('paid', 'failed')`,
  )
    .bind(reason?.slice(0, 500) ?? "The payment did not complete.", at, order.id)
    .run();
}

/**
 * Record a webhook delivery, verified or not.
 *
 * Returns false when this exact delivery has been seen before — the unique
 * index on `(rail, external_id)` is what makes a replayed callback a no-op
 * instead of a second grant. A gateway that sends no event id gets no
 * deduplication here and relies on the order status instead, which is why
 * `markOrderPaid` is idempotent on its own.
 */
export async function logWebhook(env, { rail, event, externalId = null, signatureOk, orderId = null, body, handled = false, note = "" }) {
  try {
    await env.DB.prepare(
      `INSERT INTO webhook_events (id, rail, received_at, event, external_id, signature_ok, order_id, body, handled, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(newId("whk"), rail, now(), event ?? null, externalId, signatureOk ? 1 : 0, orderId, body.slice(0, 8000), handled ? 1 : 0, note)
      .run();
    return true;
  } catch (error) {
    // The unique index firing is the expected path for a retry, not a fault.
    if (String(error?.message ?? "").includes("UNIQUE")) return false;
    throw error;
  }
}
