/**
 * The billing Worker's pure halves.
 *
 * The Worker's route handlers need D1 and a live gateway, and mocking those
 * would test the mock. What is tested here is everything that can be wrong
 * without a network — and every one of these has a failure mode that presents
 * to a paying user as a broken product rather than as an error:
 *
 *   - the WebCrypto signer drifting from the Node verifier the app ships
 *   - a licence outliving the subscription that paid for it
 *   - a renewal date that skips February
 *   - a webhook verifier that accepts what it should not
 *   - a phone number normalised into a push to nobody
 */

import assert from "node:assert/strict";
import test from "node:test";

import { generateLicenceKeypair } from "../src/licence.js";
import { DEFAULT_TTL_SECONDS, verifyLicence } from "../../licence/format.js";
import { capabilitiesForPlan } from "../../licence/entitlements.js";
import { hmacSha256Hex, signLicence, timingSafeEqual } from "../src/worker/crypto.js";
import { ttlSecondsFor } from "../src/worker/licence.js";
import { DUNNING_GRACE_MS, subscriptionEntitles } from "../src/worker/db.js";
import { periodEnd } from "../src/worker/fulfil.js";
import { verifySignature } from "../src/worker/stripe.js";
import { normaliseMsisdn, providerForMsisdn } from "../src/worker/lipia.js";

const keys = generateLicenceKeypair();

/* ── The signer the app has to believe ─────────────────────────────
   The whole entitlement system rests on one assumption: that a licence this
   Worker signs with WebCrypto verifies under the `node:crypto` verifier baked
   into the desktop app. Nothing else in this file matters if that is false. */

test("a WebCrypto-signed licence verifies under the app's Node verifier", async () => {
  const { token } = await signLicence({
    signingKeyPem: keys.privateKeyPem,
    subject: "usr_test",
    plan: "pro",
    capabilities: capabilitiesForPlan("pro"),
    keyId: "test-1",
  });

  const result = verifyLicence(token, { "test-1": keys.publicKeyPem });
  assert.equal(result.state, "valid");
  assert.equal(result.licence.plan, "pro");
  assert.deepEqual(result.licence.capabilities, capabilitiesForPlan("pro").sort());
});

test("a licence signed by a different key does not verify", async () => {
  const other = generateLicenceKeypair();
  const { token } = await signLicence({
    signingKeyPem: other.privateKeyPem,
    subject: "usr_test",
    plan: "pro",
    capabilities: ["frontier.escalation"],
    keyId: "test-1",
  });

  assert.equal(verifyLicence(token, { "test-1": keys.publicKeyPem }).state, "invalid");
});

test("a PEM whose newlines were flattened by a secret store still signs", async () => {
  // Real failure mode: `wrangler secret put` from a shell, or a copy-paste
  // through a web form, turns the newlines into literal backslash-n.
  const flattened = keys.privateKeyPem.replace(/\n/g, "\\n");
  const { token } = await signLicence({
    signingKeyPem: flattened,
    subject: "usr_test",
    plan: "free",
    capabilities: capabilitiesForPlan("free"),
    keyId: "test-1",
  });
  assert.equal(verifyLicence(token, { "test-1": keys.publicKeyPem }).state, "valid");
});

test("signing with no key configured refuses rather than issuing an unsigned licence", async () => {
  await assert.rejects(
    () => signLicence({ signingKeyPem: "", subject: "usr", plan: "free", capabilities: [], keyId: "k" }),
    (error) => error.code === "SIGNING_KEY_MISSING",
  );
});

/* ── A licence never outlives the money ────────────────────────── */

test("a free licence gets the full default life", () => {
  assert.equal(ttlSecondsFor("free", null), DEFAULT_TTL_SECONDS);
});

test("a licence is clamped to the end of the subscription's dunning window", () => {
  const at = Date.now();
  // Two days left. A default seven-day token would keep paying out for five
  // days after the subscription stopped.
  const subscription = { current_period_end: at + 2 * 24 * 60 * 60 * 1000 };
  const ttl = ttlSecondsFor("pro", subscription, at);
  assert.ok(ttl < DEFAULT_TTL_SECONDS);
  assert.equal(ttl, Math.floor((subscription.current_period_end + DUNNING_GRACE_MS - at) / 1000));
});

test("a long subscription still gets only the default life, so a refund reaches the field", () => {
  const at = Date.now();
  const subscription = { current_period_end: at + 365 * 24 * 60 * 60 * 1000 };
  assert.equal(ttlSecondsFor("pro", subscription, at), DEFAULT_TTL_SECONDS);
});

test("a subscription about to lapse still gets a licence, not a zero-length one", () => {
  const at = Date.now();
  const subscription = { current_period_end: at - DUNNING_GRACE_MS + 1000 };
  assert.equal(ttlSecondsFor("pro", subscription, at), 60 * 60);
});

/* ── Who is entitled, and until when ───────────────────────────── */

test("an active subscription entitles through the dunning window", () => {
  const at = Date.now();
  const subscription = { status: "active", current_period_end: at - 1000 };
  assert.equal(subscriptionEntitles(subscription, at), true);
  assert.equal(subscriptionEntitles({ ...subscription, current_period_end: at - DUNNING_GRACE_MS - 1000 }, at), false);
});

test("a cancelled subscription runs to period end and gets no dunning window", () => {
  const at = Date.now();
  assert.equal(subscriptionEntitles({ status: "canceled", current_period_end: at + 1000 }, at), true);
  assert.equal(subscriptionEntitles({ status: "canceled", current_period_end: at - 1000 }, at), false);
});

test("no subscription and an expired one both entitle nothing", () => {
  assert.equal(subscriptionEntitles(null), false);
  assert.equal(subscriptionEntitles({ status: "expired", current_period_end: Date.now() + 99999 }), false);
});

/* ── Renewal dates ─────────────────────────────────────────────── */

test("a monthly period lands on the same day of the next month", () => {
  const start = Date.UTC(2026, 0, 15);
  assert.equal(periodEnd(start, "month"), Date.UTC(2026, 1, 15));
});

test("billing on the 31st does not skip February", () => {
  // setUTCMonth alone lands on 2 or 3 March, silently selling a month of
  // service that was never bought.
  assert.equal(periodEnd(Date.UTC(2026, 0, 31), "month"), Date.UTC(2026, 1, 28));
  assert.equal(periodEnd(Date.UTC(2028, 0, 31), "month"), Date.UTC(2028, 1, 29));
});

test("a yearly period lands on the same date a year later", () => {
  assert.equal(periodEnd(Date.UTC(2026, 5, 1), "year"), Date.UTC(2027, 5, 1));
});

/* ── Webhook verification ──────────────────────────────────────── */

const stripeHeader = async (secret, body, timestamp) => `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;

test("a correctly signed Stripe delivery verifies", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  assert.equal(await verifySignature("whsec_test", await stripeHeader("whsec_test", body, now), body, now), true);
});

test("a Stripe delivery signed with another secret does not verify", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: "evt_1" });
  assert.equal(await verifySignature("whsec_test", await stripeHeader("whsec_other", body, now), body, now), false);
});

test("an old Stripe delivery does not verify, however good the signature", async () => {
  // Without the tolerance, one captured delivery can be replayed forever.
  const then = Math.floor(Date.now() / 1000) - 10 * 60;
  const body = JSON.stringify({ id: "evt_1" });
  assert.equal(await verifySignature("whsec_test", await stripeHeader("whsec_test", body, then), body, Math.floor(Date.now() / 1000)), false);
});

test("a Stripe header carrying several signatures verifies if any is ours", async () => {
  // What a secret rotation actually looks like on the wire.
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: "evt_1" });
  const ours = await hmacSha256Hex("whsec_test", `${now}.${body}`);
  const header = `t=${now},v1=${"0".repeat(64)},v1=${ours}`;
  assert.equal(await verifySignature("whsec_test", header, body, now), true);
});

test("a body altered after signing does not verify", async () => {
  const now = Math.floor(Date.now() / 1000);
  const header = await stripeHeader("whsec_test", JSON.stringify({ amount: 100 }), now);
  assert.equal(await verifySignature("whsec_test", header, JSON.stringify({ amount: 100000 }), now), false);
});

test("timingSafeEqual is total on junk input", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
  assert.equal(timingSafeEqual(null, "abc"), false);
  assert.equal(timingSafeEqual(undefined, undefined), false);
});

/* ── Phone numbers ─────────────────────────────────────────────── */

test("every shape a Tanzanian number is typed in normalises to one", () => {
  for (const raw of ["0769445221", "+255769445221", "255769445221", "0769 445 221", "769445221"]) {
    assert.equal(normaliseMsisdn(raw), "255769445221", raw);
  }
});

test("a number that is not a number is rejected rather than guessed at", () => {
  // A wrong shape does not fail loudly at Lipia — it pushes to nobody, which
  // the buyer reads as a broken app.
  for (const raw of ["", "abc", "12345", "0769445221999", null, undefined]) {
    assert.equal(normaliseMsisdn(raw), null, String(raw));
  }
});

test("the wallet is derived from the prefix, and an unknown prefix is null", () => {
  assert.equal(providerForMsisdn("255769445221"), "vodacom");
  assert.equal(providerForMsisdn("255712345678"), "tigo");
  assert.equal(providerForMsisdn("255789123456"), "airtel");
  assert.equal(providerForMsisdn("255621234567"), "halopesa");
  assert.equal(providerForMsisdn("255991234567"), null);
});
