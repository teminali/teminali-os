/**
 * The Lipia rail — mobile money, through pay.mhasibudigital.com.
 *
 * Teminali Code is a tenant of Lipia the same way Kerf and DukaBot are. Lipia
 * wraps Selcom, holds the merchant credentials and the static-IP proxy
 * Selcom's whitelisting requires, and hands back one clean REST surface — so
 * this file knows about Lipia and nothing about Selcom, HMAC order signing, or
 * IP allowlists.
 *
 * **Lipia has no recurring primitive.** There is no subscription object to
 * create and no card on file to charge. A renewal is a fresh prompt on the
 * user's handset, scheduled by our own cron — which is why `subscriptions`
 * carries `msisdn` and `renew_after`, and why those columns are null on the
 * Stripe rail. Anything here that looks like a subscription is bookkeeping we
 * are doing ourselves.
 */

import { hmacSha256Hex, newId, timingSafeEqual } from "./crypto.js";
import { activePrice, now, tooManyOrders, userForToken } from "./db.js";
import { logWebhook, markOrderFailed, markOrderPaid } from "./fulfil.js";
import { bearer, fail, json, readJson } from "./http.js";

/** How long before an unanswered prompt is chased up rather than waited on. */
const RECONCILE_AFTER_MS = 90 * 1000;

async function lipiaRequest(env, method, path, body) {
  const response = await fetch(`${env.LIPIA_API_URL}${path}`, {
    method,
    headers: {
      // Lipia's own scheme: the pair, colon-joined, inside one Bearer.
      authorization: `Bearer ${env.LIPIA_PUBLIC_KEY}:${env.LIPIA_SECRET}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(parsed?.error ?? `Lipia returned ${response.status}`), { status: response.status });
  }
  return parsed;
}

export const charge = (env, params) => lipiaRequest(env, "POST", "/api/v1/charge", params);
export const getTransaction = (env, id) => lipiaRequest(env, "GET", `/api/v1/transactions/${id}`);

/* ── msisdn ────────────────────────────────────────────────────────
   Lipia's own examples are E.164 without the plus: `255769445221`. People type
   all four of `0769…`, `+255769…`, `255769…` and `0769 445 221`, and a number
   in the wrong shape does not fail loudly — it produces a push to nobody,
   which reads to the buyer as "the app is broken" and to us as an order that
   never completes. */

export function normaliseMsisdn(raw, countryCode = "255") {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;

  let msisdn;
  if (digits.startsWith(countryCode) && digits.length === countryCode.length + 9) {
    msisdn = digits;
  } else if (digits.startsWith("0") && digits.length === 10) {
    msisdn = countryCode + digits.slice(1);
  } else if (digits.length === 9) {
    msisdn = countryCode + digits;
  } else {
    return null;
  }
  return msisdn.length === countryCode.length + 9 ? msisdn : null;
}

/**
 * Which wallet a Tanzanian number belongs to.
 *
 * Returns null rather than guessing when the prefix is unknown — the caller
 * then ASKS. A wrong provider sends the push to the wrong network and the
 * buyer sees nothing at all, which is worse than one extra tap, and prefix
 * tables go stale as ranges are reassigned.
 */
export function providerForMsisdn(msisdn) {
  const local = msisdn.startsWith("255") ? msisdn.slice(3) : msisdn;
  const prefix = local.slice(0, 2);
  if (["74", "75", "76"].includes(prefix)) return "vodacom";
  if (["65", "67", "71", "77"].includes(prefix)) return "tigo";
  if (["68", "69", "78"].includes(prefix)) return "airtel";
  if (["61", "62"].includes(prefix)) return "halopesa";
  return null;
}

/**
 * Create an order and push a charge prompt.
 *
 * Shared by the checkout route and by the renewal sweep, because a renewal is
 * the same act as a purchase here — there is nothing else it could be.
 */
export async function startCharge(env, { user, price, msisdn, kind = "initial", subscriptionId = null }) {
  const provider = providerForMsisdn(msisdn);
  if (!provider) {
    throw Object.assign(new Error("That number is not on a network we recognise. Check it and try again."), {
      status: 400,
      code: "UNKNOWN_MOBILE_PROVIDER",
    });
  }

  const orderId = newId("ord");
  const at = now();
  await env.DB.prepare(
    `INSERT INTO orders
       (id, user_id, subscription_id, price_id, plan_id, rail, kind, amount, currency, msisdn, provider,
        status, created_at, updated_at, reconcile_after)
     VALUES (?, ?, ?, ?, ?, 'lipia', ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
  )
    .bind(orderId, user.id, subscriptionId, price.id, price.plan_id, kind, price.amount, price.currency, msisdn, provider, at, at, at + RECONCILE_AFTER_MS)
    .run();

  try {
    const answer = await charge(env, {
      amount: price.amount,
      currency: price.currency,
      method: "mobile_wallet",
      provider,
      customer_msisdn: msisdn,
      customer_email: user.email ?? undefined,
      customer_name: user.name ?? undefined,
      description: `Teminali Code ${price.plan_id} — ${price.interval}`,
      external_id: orderId,
      // `order_id` is what comes back on the webhook. `external_id` is echoed
      // too, but metadata is the field Lipia's dispatcher guarantees.
      metadata: { order_id: orderId, user_id: user.id, plan_id: price.plan_id, kind },
      // The order id is already unique per attempt, so this makes a retried
      // request from our own side a no-op rather than a second prompt.
      idempotency_key: orderId,
    });

    const transaction = answer?.data ?? null;
    await env.DB.prepare("UPDATE orders SET status = 'charging', lipia_transaction_id = ?, lipia_status = ?, updated_at = ? WHERE id = ?")
      .bind(transaction?.id ?? null, transaction?.status ?? null, now(), orderId)
      .run();

    return { orderId, status: "charging", paymentUrl: transaction?.payment_url ?? null };
  } catch (error) {
    await env.DB.prepare("UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .bind(String(error.message).slice(0, 500), now(), orderId)
      .run();
    throw Object.assign(new Error(error.message), { status: 502, code: "CHARGE_FAILED" });
  }
}

/* ── POST /api/checkout/lipia ──────────────────────────────────── */

export async function checkout(request, env) {
  const user = await userForToken(env, bearer(request));
  if (!user) return fail(401, "NOT_SIGNED_IN", "Sign in before starting a payment.");

  const body = await readJson(request);
  const price = await activePrice(env, body?.priceId);
  if (!price || price.rail !== "lipia") return fail(400, "UNKNOWN_PRICE", "That price is not available on mobile money.");

  const msisdn = normaliseMsisdn(body?.msisdn ?? user.msisdn);
  if (!msisdn) return fail(400, "BAD_MSISDN", "That does not look like a Tanzanian mobile number.");

  // Each order is a real prompt on a real handset. Somebody spamming this
  // makes a stranger's phone buzz repeatedly, which is a worse outcome than a
  // full table.
  if (await tooManyOrders(env, user.id)) {
    return fail(429, "TOO_MANY_ORDERS", "Too many payment attempts. Wait a few minutes and try again.");
  }

  try {
    const started = await startCharge(env, { user, price, msisdn });
    return json(started);
  } catch (error) {
    return fail(error.status ?? 502, error.code ?? "CHARGE_FAILED", error.message);
  }
}

/* ── POST /webhooks/lipia ──────────────────────────────────────────
   Order of operations is not negotiable:

     1. read the RAW body as text
     2. verify the HMAC over those exact bytes, in constant time
     3. log the delivery — verified or not
     4. only then parse it

   Parsing before verifying is already trusting the payload, and the log is
   written even for a failed signature because "somebody is posting forged
   callbacks at us" is something you want to be able to see. */

export async function webhook(request, env) {
  const raw = await request.text();
  const signature = request.headers.get("x-lipia-signature");
  const event = request.headers.get("x-lipia-event");

  if (!env.LIPIA_WEBHOOK_SECRET) return fail(500, "WEBHOOK_NOT_CONFIGURED", "This deployment cannot verify Lipia callbacks.");

  const expected = await hmacSha256Hex(env.LIPIA_WEBHOOK_SECRET, raw);
  const signatureOk = timingSafeEqual(signature ?? "", expected);

  if (!signatureOk) {
    await logWebhook(env, { rail: "lipia", event, signatureOk, body: raw, note: "signature did not verify — payload ignored" });
    return fail(401, "BAD_SIGNATURE", "That callback did not verify.");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    await logWebhook(env, { rail: "lipia", event, signatureOk, body: raw, note: "signed but not JSON" });
    return fail(400, "BAD_PAYLOAD", "That callback was not JSON.");
  }

  const data = payload?.data ?? {};
  const orderId = data.metadata?.order_id ?? data.external_id ?? null;

  // Lipia is multi-tenant and this endpoint may receive events for products
  // that are not Teminali Code. An unknown order is acknowledged with 200,
  // never retried at us, and recorded — a 4xx here would put Lipia into a
  // twelve-hour retry ladder over something we will never handle.
  if (!orderId) {
    await logWebhook(env, { rail: "lipia", event, externalId: data.id ?? null, signatureOk, body: raw, handled: true, note: "no order_id — not ours" });
    return json({ ok: true });
  }

  const fresh = await logWebhook(env, { rail: "lipia", event, externalId: data.id ?? null, signatureOk, orderId, body: raw, handled: true, note: "" });
  if (!fresh) return json({ ok: true, duplicate: true });

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) return json({ ok: true });

  await settle(env, order, data);
  return json({ ok: true });
}

/**
 * Apply a Lipia transaction state to an order.
 *
 * Shared with the reconcile sweep, which is what makes a webhook and a sweep
 * arriving at the same time settle once rather than twice.
 */
export async function settle(env, order, transaction) {
  const status = String(transaction?.status ?? "").toLowerCase();
  if (status === "success") {
    await markOrderPaid(env, order, { transactionId: transaction.id ?? null, lipiaStatus: status, receipt: transaction.receipt ?? null });
    return "paid";
  }
  if (status === "failed" || status === "refunded") {
    await markOrderFailed(env, order, transaction.failure_reason ?? `Lipia reported ${status}.`);
    return status === "refunded" ? "refunded" : "failed";
  }
  await env.DB.prepare("UPDATE orders SET lipia_status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('paid', 'failed')")
    .bind(status || null, now(), order.id)
    .run();
  return "pending";
}
