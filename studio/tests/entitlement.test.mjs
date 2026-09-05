import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetVoiceStatus, voiceStatus } from "../server/voice.js";
import {
  clearLicence,
  grants,
  listPlans,
  pollSignIn,
  readEntitlement,
  readOrder,
  readSessionToken,
  refusal,
  signOut,
  startCheckout,
  startSignIn,
  storeSession,
} from "../server/licence.js";
import { capabilitiesForPlan } from "../../licence/entitlements.js";

/**
 * The entitlement, from the app's side.
 *
 * `licence/format.js` is tested adversarially in billing/tests — forged
 * payloads, foreign keys, grace boundaries. These tests are about the other
 * half: what the desktop half actually DOES with a verdict, and in particular
 * that the speech tier degrades where the escalation gate refuses. That
 * asymmetry is the whole product decision, so it is the thing worth pinning.
 */

const voiceConfig = {
  // Port 1 is unroutable and refuses immediately, so an unexpected probe fails
  // fast and loudly rather than hanging the suite.
  voiceUrl: new URL("http://127.0.0.1:1/"),
  voiceTimeoutMs: 250,
};

/** Run `fn` with a fetch that records every call and answers nothing useful. */
async function withFetchSpy(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("connection refused");
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("an unentitled caller never probes the VibeVoice sidecar", async () => {
  forgetVoiceStatus();
  await withFetchSpy(async (calls) => {
    const status = await voiceStatus(voiceConfig, { allowVibeVoice: false, force: true });
    assert.deepEqual(calls, [], "the sidecar was probed for a plan that cannot use it");
    // Named, so the UI can offer an upgrade instead of an install.
    assert.equal(status.gated, "voice.vibevoice");
    assert.notEqual(status.engine, "vibevoice");
  });
});

test("an entitled caller does probe, and a missing sidecar is not a gate", async () => {
  forgetVoiceStatus();
  await withFetchSpy(async (calls) => {
    const status = await voiceStatus(voiceConfig, { allowVibeVoice: true, force: true });
    assert.equal(calls.length, 1);
    // No sidecar running is an install problem, not an entitlement one, and
    // saying "upgrade" here would send a paying user to a checkout page.
    assert.equal(status.gated, null);
  });
});

test("the status cache does not serve one plan's answer to the other", async () => {
  forgetVoiceStatus();
  await withFetchSpy(async (calls) => {
    await voiceStatus(voiceConfig, { allowVibeVoice: false });
    assert.deepEqual(calls, []);
    // Same TTL window, opposite entitlement: this must not be a cache hit, or
    // an upgrade appears not to have taken effect until the cache ages out.
    await voiceStatus(voiceConfig, { allowVibeVoice: true });
    assert.equal(calls.length, 1);
  });
});

// Both local capabilities are granted to free for the same reason: they run on
// hardware the user already owns, and gating them would mean the offline half
// of the product is the half that stops working. `voice.vibevoice` joined them
// on 2026-09-05 — see licence/entitlements.js. Only hosted escalation, which
// bills per turn, is still Pro.
test("free carries both local lanes; only the metered capability is Pro", () => {
  const free = capabilitiesForPlan("free");
  assert.ok(free.includes("frontier.max"));
  assert.ok(free.includes("voice.vibevoice"));
  assert.equal(free.includes("frontier.escalation"), false);
});

test("a refusal names the capability that was missing, not a generic plan pitch", () => {
  const free = { plan: "free", capabilities: capabilitiesForPlan("free"), state: "none" };
  const voice = refusal("voice.vibevoice", free);
  const escalation = refusal("frontier.escalation", free);

  assert.equal(voice.code, "PLAN_UPGRADE_REQUIRED");
  assert.notEqual(voice.message, escalation.message);
  // Each message has to say what still works, or it is a dead end.
  assert.match(voice.message, /built-in voices/i);
  assert.match(escalation.message, /Flash and Max/i);
  assert.equal(voice.stale, false);
});

test("a stale licence asks for a refresh rather than for money", () => {
  const inGrace = { plan: "pro", capabilities: [], state: "grace" };
  const denial = refusal("frontier.escalation", inGrace);
  assert.equal(denial.stale, true);
  // The user IS entitled; telling them to upgrade would be wrong.
  assert.match(denial.message, /refreshed/i);
});

test("the session and the licence share one file and one lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");

  assert.equal(await readSessionToken(store), null);
  await storeSession(store, "sess_abc");
  assert.equal(await readSessionToken(store), "sess_abc");

  // Bearer credential for a paid account: owner-only, like the provider keys.
  const mode = (await stat(store)).mode & 0o777;
  assert.equal(mode, 0o600);

  // Sign-out takes the session with the licence. A session that outlived it
  // would quietly re-mint Pro for someone who thought they had signed out.
  await clearLicence(store);
  assert.equal(await readSessionToken(store), null);
  assert.equal((await readEntitlement(store)).plan, "free");
});

test("sign-in refuses to store a licence this build cannot verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");

  const fetchImpl = async () =>
    new Response(JSON.stringify({ status: "granted", sessionToken: "sess_x", licence: "not.alicence" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    () => pollSignIn(store, { baseUrl: "https://billing.example", deviceCode: "dev_1", fetchImpl }),
    (error) => error.code === "LICENCE_UNVERIFIABLE",
  );
  // Nothing was written: a service standing in for the real one must not be
  // able to leave a token behind that a later read would trust.
  await assert.rejects(() => readFile(store, "utf8"));
});

test("sign-in without a billing service is a configuration answer, not a crash", async () => {
  await assert.rejects(
    () => startSignIn({ baseUrl: null }),
    (error) => error.code === "BILLING_NOT_CONFIGURED" && error.status === 503,
  );
});

test("a pending device code is an ordinary answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const fetchImpl = async () =>
    new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: { "content-type": "application/json" } });

  const result = await pollSignIn(join(dir, "licence.json"), {
    baseUrl: "https://billing.example",
    deviceCode: "dev_1",
    fetchImpl,
  });
  assert.equal(result.status, "pending");
});

test("grants reads the capability list and nothing else", () => {
  assert.ok(grants({ capabilities: ["voice.vibevoice"] }, "voice.vibevoice"));
  assert.equal(grants({ capabilities: [] }, "voice.vibevoice"), false);
  // A plan name is never the authority, even when it says "pro".
  assert.equal(grants({ plan: "pro", capabilities: [] }, "voice.vibevoice"), false);
  assert.equal(grants(null, "voice.vibevoice"), false);
});


/* ── The upgrade path ───────────────────────────────────────────────────────
   Three thin proxies between "I want Pro" and a licence that says so. What is
   worth pinning is not that they forward — it is WHO they forward as, and what
   they refuse to do before touching the network at all. A checkout that
   reaches the service without a session burns a round trip to be told what
   this process already knew, and a rail typo that reaches the service is a
   404 the user reads as "payment is broken". */

/** Answer `body` to any request, recording exactly what was sent. */
function recordingFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("the price list is public, and is fetched as a GET with no body", async () => {
  const { calls, fetchImpl } = recordingFetch({ plans: [{ id: "pro", label: "Pro", prices: [] }] });

  const result = await listPlans({ baseUrl: "https://billing.example", fetchImpl });

  assert.equal(result.plans.length, 1);
  assert.equal(calls[0].method, "GET");
  // Not merely absent from the assertion — absent from the request. A GET with
  // a body is rejected outright by some proxies.
  assert.equal(calls[0].body, null);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].url, "https://billing.example/api/plans");
});

test("a price list from a service that answers nonsense is empty, not undefined", async () => {
  const { fetchImpl } = recordingFetch({ plans: "soon" });
  assert.deepEqual((await listPlans({ baseUrl: "https://billing.example", fetchImpl })).plans, []);
});

test("checkout refuses an unknown rail before it reaches the network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  await storeSession(join(dir, "licence.json"), "sess_1");
  const { calls, fetchImpl } = recordingFetch({});

  await assert.rejects(
    () => startCheckout(join(dir, "licence.json"), { baseUrl: "https://billing.example", rail: "paypal", priceId: "p1", fetchImpl }),
    (error) => error.code === "UNKNOWN_RAIL" && error.status === 400,
  );
  assert.deepEqual(calls, [], "a bad rail was forwarded to the billing service");
});

test("checkout without a session is a sign-in prompt, not a payment page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const { calls, fetchImpl } = recordingFetch({});

  await assert.rejects(
    () => startCheckout(join(dir, "licence.json"), { baseUrl: "https://billing.example", rail: "stripe", priceId: "p1", fetchImpl }),
    (error) => error.code === "NOT_SIGNED_IN" && error.status === 401,
  );
  assert.deepEqual(calls, [], "a signed-out checkout was forwarded anyway");
});

test("checkout carries the session as a bearer, and the price in the body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  await storeSession(join(dir, "licence.json"), "sess_secret");
  const { calls, fetchImpl } = recordingFetch({ url: "https://checkout.stripe.com/c/pay/cs_test" });

  const started = await startCheckout(join(dir, "licence.json"), {
    baseUrl: "https://billing.example",
    rail: "stripe",
    priceId: "price_pro_month",
    fetchImpl,
  });

  assert.equal(started.url, "https://checkout.stripe.com/c/pay/cs_test");
  assert.equal(calls[0].url, "https://billing.example/api/checkout/stripe");
  assert.equal(calls[0].headers.authorization, "Bearer sess_secret");
  assert.deepEqual(JSON.parse(calls[0].body), { priceId: "price_pro_month" });
});

test("a mobile-money checkout sends the number, and only when there is one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  await storeSession(join(dir, "licence.json"), "sess_1");
  const { calls, fetchImpl } = recordingFetch({ order: { id: "ord_1", status: "charging" } });

  await startCheckout(join(dir, "licence.json"), {
    baseUrl: "https://billing.example",
    rail: "lipia",
    priceId: "price_pro_month_tzs",
    msisdn: "0712345678",
    fetchImpl,
  });
  assert.deepEqual(JSON.parse(calls[0].body), { priceId: "price_pro_month_tzs", msisdn: "0712345678" });

  // Omitted rather than sent empty: the service falls back to the number on
  // the account, and a blank one would override a good number with nothing.
  await startCheckout(join(dir, "licence.json"), {
    baseUrl: "https://billing.example",
    rail: "lipia",
    priceId: "price_pro_month_tzs",
    fetchImpl,
  });
  assert.deepEqual(JSON.parse(calls[1].body), { priceId: "price_pro_month_tzs" });
});

test("an order read is scoped to the caller, and refuses without a session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  const { calls, fetchImpl } = recordingFetch({ order: { id: "ord_1", status: "paid" } });

  await assert.rejects(
    () => readOrder(store, { baseUrl: "https://billing.example", orderId: "ord_1", fetchImpl }),
    (error) => error.code === "NOT_SIGNED_IN",
  );

  await storeSession(store, "sess_1");
  const answer = await readOrder(store, { baseUrl: "https://billing.example", orderId: "ord_1", fetchImpl });
  assert.equal(answer.order.status, "paid");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.authorization, "Bearer sess_1");
});

test("an order id is escaped into the path rather than concatenated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  await storeSession(store, "sess_1");
  const { calls, fetchImpl } = recordingFetch({ order: {} });

  // A hostile id must not be able to walk out of /api/orders/.
  await readOrder(store, { baseUrl: "https://billing.example", orderId: "../me", fetchImpl });
  assert.equal(calls[0].url, "https://billing.example/api/orders/..%2Fme");
});

test("the upgrade panel decides from capabilities, never from a plan name", async () => {
  const source = await readFile(new URL("../src/components/workspace/panels/EntitlementSection.tsx", import.meta.url), "utf8");

  // Comments are stripped first. The docblock explains the rule by quoting the
  // wrong version of it, and a test that cannot tell prose from code would
  // punish the file for documenting itself.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The one test that stops this component becoming the twentieth file to
  // edit when a plan is added. `upgradable` must be derived from the plans the
  // service offered against the capabilities this licence holds.
  assert.match(code, /plans\.some\(\(plan\) => plan\.capabilities\.some\(\(capability\) => !held\.has\(capability\)\)\)/);
  assert.doesNotMatch(code, /\bplan\b[^\n]*[!=]==\s*["'](?:pro|free)["']/);

  // And the feature list is rendered from the catalogue the gateway sent, not
  // from anything typed here.
  assert.match(code, /Object\.entries\(entitlement\.catalog\)/);
  for (const label of ["Hosted escalation", "VibeVoice", "Frontier Max"]) {
    assert.ok(!code.includes(label), `the upgrade panel hard-codes the capability label "${label}"`);
  }
});

/* ── A 404 from the billing service, and a 404 from something else ──────────
   The same status, opposite meanings. `UNKNOWN_ORDER` and `UNKNOWN_DEVICE_CODE`
   are answers from a service that is up; a 404 from a `baseUrl` pointing at the
   wrong host says nothing about the order. Reported as one status they became
   one bug: the sign-in poll saw 503, read it as "try again", and kept polling a
   code the service had already forgotten until the code's own deadline. */

test("a 404 carrying the service's own error envelope stays a 404", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  await storeSession(store, "sess_1");
  const { fetchImpl } = recordingFetch({ error: { code: "UNKNOWN_ORDER", message: "No such order." } }, 404);

  await assert.rejects(
    () => readOrder(store, { baseUrl: "https://billing.example", orderId: "ord_nope", fetchImpl }),
    (error) => error.status === 404 && error.code === "UNKNOWN_ORDER",
  );
});

test("a 404 from something that is not the billing service becomes unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  await storeSession(store, "sess_1");
  // What a wrong host answers: no envelope, so nothing to trust about the order.
  const { fetchImpl } = recordingFetch({ message: "Not Found" }, 404);

  await assert.rejects(
    () => readOrder(store, { baseUrl: "https://not-billing.example", orderId: "ord_1", fetchImpl }),
    (error) => error.status === 503 && error.code === "BILLING_CALL_FAILED",
  );
});

test("an unknown device code reaches the poller as a definite refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  const { fetchImpl } = recordingFetch({ error: { code: "UNKNOWN_DEVICE_CODE", message: "This sign-in code is not one we issued." } }, 404);

  await assert.rejects(
    () => pollSignIn(store, { baseUrl: "https://billing.example", deviceCode: "never-issued", fetchImpl }),
    (error) => error.status === 404 && error.code === "UNKNOWN_DEVICE_CODE",
  );
});

test("the sign-in poll stops on an unknown code instead of polling to the deadline", async () => {
  const source = await readFile(new URL("../src/components/workspace/panels/EntitlementSection.tsx", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The catch must recognise the code and clear the sign-in. Without this the
  // loop treats a dead code as a flaky network and keeps asking.
  assert.match(code, /error\.code === "UNKNOWN_DEVICE_CODE"/);
  assert.match(code, /EntitlementError/);
});

/* ── Sign-out is two halves ─────────────────────────────────────────────────
   Deleting the local store used to be the whole of it, which left a live bearer
   token on the server that this machine could no longer revoke: the only copy
   of it was the file just deleted. */

test("signing out revokes the session at the service before forgetting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  await storeSession(store, "sess_live");
  const { calls, fetchImpl } = recordingFetch({ ok: true });

  const result = await signOut(store, { baseUrl: "https://billing.example", fetchImpl });

  assert.equal(result.revoked, true);
  assert.equal(calls[0].url, "https://billing.example/api/signout");
  assert.equal(calls[0].method, "POST");
  // As the session being revoked, not as some other caller.
  assert.equal(calls[0].headers.authorization, "Bearer sess_live");
  assert.equal(await readSessionToken(store), null);
});

test("signing out forgets the session even when the service cannot be reached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teminali-licence-"));
  const store = join(dir, "licence.json");
  await storeSession(store, "sess_live");
  const fetchImpl = async () => {
    throw new Error("offline");
  };

  // Not raised: someone on a plane who presses sign out is signed out.
  const result = await signOut(store, { baseUrl: "https://billing.example", fetchImpl });

  assert.equal(result.revoked, false);
  assert.equal(await readSessionToken(store), null);
});
