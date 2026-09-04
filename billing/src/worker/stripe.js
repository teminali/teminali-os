/**
 * The Stripe rail — cards, for everyone outside the mobile-money footprint.
 *
 * Talked to over plain `fetch` and form encoding rather than the SDK: the
 * three calls this needs are `POST /v1/checkout/sessions`, a customer lookup
 * and a subscription read, and pulling a large Node-shaped dependency into a
 * Worker to save thirty lines is a bad trade in the money path.
 *
 * **Stripe owns its own renewals.** Unlike Lipia, a Stripe subscription
 * charges itself and tells us what happened; our job is to keep
 * `subscriptions` in step with what Stripe already decided. That is why the
 * renewal sweep in `reconcile.js` ignores Stripe rows entirely — prompting for
 * money Stripe is already collecting would charge twice.
 */

import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import { activePrice, now, userForToken } from "./db.js";
import { grantPeriod, logWebhook } from "./fulfil.js";
import { bearer, fail, json, readJson } from "./http.js";

/**
 * How far apart the signed timestamp and our clock may be.
 *
 * Five minutes is Stripe's own recommendation. It is a replay bound, not a
 * clock-skew allowance: without it, a delivery captured once can be posted
 * back at us forever and it will still verify.
 */
const SIGNATURE_TOLERANCE_S = 5 * 60;

async function stripeRequest(env, path, form) {
  if (!env.STRIPE_SECRET_KEY) {
    throw Object.assign(new Error("Card payments are not set up on this server."), { status: 503, code: "STRIPE_NOT_CONFIGURED" });
  }
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(parsed?.error?.message ?? `Stripe returned ${response.status}`), { status: 502, code: "STRIPE_ERROR" });
  }
  return parsed;
}

/* ── POST /api/checkout/stripe ─────────────────────────────────── */

export async function checkout(request, env) {
  const user = await userForToken(env, bearer(request));
  if (!user) return fail(401, "NOT_SIGNED_IN", "Sign in before starting a payment.");

  const body = await readJson(request);
  const price = await activePrice(env, body?.priceId);
  if (!price || price.rail !== "stripe" || !price.stripe_price_id) {
    return fail(400, "UNKNOWN_PRICE", "That price is not available on card.");
  }

  try {
    const session = await stripeRequest(env, "/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": price.stripe_price_id,
      "line_items[0][quantity]": "1",
      success_url: env.CHECKOUT_SUCCESS_URL,
      cancel_url: env.CHECKOUT_CANCEL_URL,
      // Three copies of the user id, on purpose. `client_reference_id` is what
      // comes back on checkout.session.completed; the subscription metadata is
      // what comes back on every later invoice, long after the session is gone.
      client_reference_id: user.id,
      "metadata[user_id]": user.id,
      "metadata[price_id]": price.id,
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][price_id]": price.id,
      ...(user.email ? { customer_email: user.email } : {}),
    });
    return json({ url: session.url, sessionId: session.id });
  } catch (error) {
    return fail(error.status ?? 502, error.code ?? "STRIPE_ERROR", error.message);
  }
}

/* ── POST /webhooks/stripe ─────────────────────────────────────── */

/**
 * Verify a `Stripe-Signature` header against the raw body.
 *
 * The signed material is `${timestamp}.${body}`, and the header carries the
 * timestamp as `t=` and one or more signatures as `v1=` — more than one during
 * a secret rotation, which is why every candidate is checked rather than the
 * first. Exported because it is the part worth testing directly; a webhook
 * verifier that has never been run against a known-good vector is a verifier
 * you are hoping about.
 */
export async function verifySignature(secret, header, rawBody, at = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = Object.create(null);
  const candidates = [];
  for (const piece of header.split(",")) {
    const [key, value] = piece.split("=", 2);
    if (key === "v1") candidates.push(value);
    else if (key) parts[key.trim()] = value;
  }
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(at - timestamp) > SIGNATURE_TOLERANCE_S) return false;
  if (candidates.length === 0) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return candidates.some((candidate) => timingSafeEqual(candidate ?? "", expected));
}

export async function webhook(request, env) {
  const raw = await request.text();
  const header = request.headers.get("stripe-signature");

  if (!env.STRIPE_WEBHOOK_SECRET) return fail(500, "WEBHOOK_NOT_CONFIGURED", "This deployment cannot verify Stripe callbacks.");

  const signatureOk = await verifySignature(env.STRIPE_WEBHOOK_SECRET, header, raw);
  if (!signatureOk) {
    await logWebhook(env, { rail: "stripe", event: null, signatureOk, body: raw, note: "signature did not verify — payload ignored" });
    return fail(401, "BAD_SIGNATURE", "That callback did not verify.");
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    await logWebhook(env, { rail: "stripe", event: null, signatureOk, body: raw, note: "signed but not JSON" });
    return fail(400, "BAD_PAYLOAD", "That callback was not JSON.");
  }

  const fresh = await logWebhook(env, { rail: "stripe", event: event.type, externalId: event.id ?? null, signatureOk, body: raw, handled: true });
  // Stripe retries for three days. A delivery we have already applied is
  // acknowledged rather than applied again.
  if (!fresh) return json({ ok: true, duplicate: true });

  await apply(env, event);
  return json({ ok: true });
}

/** Turn one Stripe event into a subscription state. Exported for the same reason `settle` is. */
export async function apply(env, event) {
  const object = event?.data?.object ?? {};

  switch (event?.type) {
    // The first payment. `invoice.paid` also fires for it, but the session is
    // the only place `client_reference_id` appears, and it is what ties the
    // Stripe customer to our user for every renewal after this one.
    case "checkout.session.completed": {
      const userId = object.client_reference_id ?? object.metadata?.user_id ?? null;
      const price = await activePrice(env, object.metadata?.price_id);
      if (!userId || !price) return;
      await grantPeriod(env, {
        user_id: userId,
        plan_id: price.plan_id,
        price_id: price.id,
        rail: "stripe",
        interval: price.interval,
        stripe: { customerId: object.customer ?? null, subscriptionId: object.subscription ?? null },
      });
      return;
    }

    // Every renewal after the first.
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const subscriptionId = object.subscription ?? object.parent?.subscription_details?.subscription ?? null;
      const row = subscriptionId ? await subscriptionByStripeId(env, subscriptionId) : null;
      if (!row) return;
      const price = await activePrice(env, row.price_id);
      await grantPeriod(env, {
        user_id: row.user_id,
        plan_id: row.plan_id,
        price_id: row.price_id,
        rail: "stripe",
        interval: price?.interval ?? "month",
        stripe: { customerId: object.customer ?? null, subscriptionId },
      });
      return;
    }

    // A failed renewal is not a cancellation: Stripe retries for a fortnight.
    // `past_due` keeps the dunning window in `db.js` open, so the user keeps
    // working while the card is sorted out.
    case "invoice.payment_failed": {
      const subscriptionId = object.subscription ?? object.parent?.subscription_details?.subscription ?? null;
      if (!subscriptionId) return;
      await env.DB.prepare("UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ? AND status = 'active'")
        .bind(now(), subscriptionId)
        .run();
      return;
    }

    // Stripe's own view of the subscription, including a cancellation the user
    // made in the portal. Mirrored rather than interpreted.
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const row = await subscriptionByStripeId(env, object.id);
      if (!row) return;
      const canceled = event.type === "customer.subscription.deleted" || object.status === "canceled";
      const periodEndMs = Number.isFinite(object.current_period_end) ? object.current_period_end * 1000 : row.current_period_end;
      await env.DB.prepare(
        `UPDATE subscriptions
            SET status = ?, cancel_at_period_end = ?, current_period_end = ?, updated_at = ?
          WHERE id = ?`,
      )
        .bind(
          canceled ? "canceled" : object.status === "past_due" || object.status === "unpaid" ? "past_due" : "active",
          object.cancel_at_period_end ? 1 : 0,
          periodEndMs,
          now(),
          row.id,
        )
        .run();
      return;
    }

    default:
      // Everything else is acknowledged and ignored. A Stripe account emits
      // dozens of event types nobody here needs, and 4xx-ing them would put
      // the endpoint into a permanent retry ladder.
      return;
  }
}

function subscriptionByStripeId(env, stripeSubscriptionId) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?").bind(stripeSubscriptionId).first();
}
