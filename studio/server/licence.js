/**
 * The licence, on the user's machine.
 *
 * This is the client half of the entitlement system. It holds a signed licence
 * on disk, verifies it locally against a baked-in public key, and refreshes it
 * from the billing service whenever there is a network. It never decides
 * anything: the service decides, signs, and this file reads the decision.
 *
 * The distinction matters because this process runs on hardware the user
 * controls. Nothing here is a security boundary against that user — they can
 * edit this file. What the signature buys is that they cannot *forge* a
 * decision: they can bypass their own copy of the app, but they cannot produce
 * a licence that a clean install, an audit, or the service itself will accept.
 * That is the honest limit of client-side gating, and it is the right trade
 * for a product whose paid lanes cost real money per turn while its free lanes
 * cost nothing.
 *
 * ## Failing towards the working product
 *
 * Every failure path here resolves to the FREE plan, never to an error:
 *
 *   - no licence file           → free
 *   - unreadable or corrupt     → free
 *   - forged or wrong key       → free
 *   - expired past grace        → free
 *   - billing service unreachable → whatever is cached, until grace runs out
 *
 * A billing outage must not stop someone writing code. The free lanes are
 * local Flash and Max and the built-in voice, all of which work with no
 * network and no account, so "the payment system is down" degrades to "the
 * expensive lanes are unavailable" rather than to a dead editor.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { verifyLicence, licenceGrants, DEFAULT_TTL_SECONDS } from "../../licence/format.js";
import { DEFAULT_PLAN, capabilitiesForPlan, profileAllowed, voiceTierAllowed } from "../../licence/entitlements.js";

export { profileAllowed, voiceTierAllowed };

/**
 * The public keys this build will honour, by key id.
 *
 * Committed rather than fetched. A key fetched at runtime is a key an attacker
 * can substitute by pointing the app at their own server, which would defeat
 * the entire signature scheme — the whole value of Ed25519 here is that the
 * trust anchor ships with the binary.
 *
 * `TEMINALI_LICENCE_PUBLIC_KEYS` overrides it as JSON (`{"kid": "-----BEGIN…"}`)
 * for staging and tests only. It is deliberately an override of the whole map
 * rather than an addition to it, so a test build cannot be tricked into
 * honouring production licences or vice versa.
 */
const BAKED_PUBLIC_KEYS = Object.freeze({
  // Replaced at release time by the public half of the billing service's
  // signing key. Empty here means an unconfigured development build honours no
  // licence at all and therefore runs as free — which is the correct default
  // for a checkout that has never talked to a billing service.
});

export function publicKeys(environment = process.env) {
  const override = environment.TEMINALI_LICENCE_PUBLIC_KEYS;
  if (!override) return BAKED_PUBLIC_KEYS;
  try {
    const parsed = JSON.parse(override);
    return parsed && typeof parsed === "object" ? parsed : BAKED_PUBLIC_KEYS;
  } catch {
    // A malformed override is a configuration mistake, not an attack. Falling
    // back to the baked keys keeps a mistyped staging variable from silently
    // granting or revoking Pro.
    return BAKED_PUBLIC_KEYS;
  }
}

/**
 * The entitlement the free plan carries.
 *
 * Built from the shared registry rather than written out here, so that adding
 * a capability to free is one edit in `licence/entitlements.js`.
 */
function freeEntitlement(reason) {
  return Object.freeze({
    plan: DEFAULT_PLAN,
    capabilities: capabilitiesForPlan(DEFAULT_PLAN),
    state: "none",
    reason,
    subject: null,
    expiresAt: null,
    refreshAfter: null,
    signedIn: false,
  });
}

/**
 * The licence file, as a whole.
 *
 * It holds two credentials with one lifecycle: the signed `token` that says
 * what this machine may do, and the `sessionToken` that lets it ask the
 * billing service for a fresh one. Keeping them in a single file is what makes
 * sign-out a single `rm` — a session that outlived its licence would silently
 * re-mint Pro for someone who thought they had signed out.
 */
async function readStore(storePath) {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readToken(storePath) {
  const store = await readStore(storePath);
  return typeof store.token === "string" ? store.token : null;
}

/** The billing session token, if this machine has signed in. */
export async function readSessionToken(storePath) {
  const store = await readStore(storePath);
  return typeof store.sessionToken === "string" ? store.sessionToken : null;
}

async function writeStore(storePath, patch) {
  const current = await readStore(storePath);
  await mkdir(dirname(storePath), { recursive: true });
  const next = { ...current, ...patch, storedAt: Date.now() };
  await writeFile(storePath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Record the billing session this machine signed in with. */
export async function storeSession(storePath, sessionToken) {
  await writeStore(storePath, { sessionToken });
}

/**
 * Store the licence.
 *
 * Written 0600 for the same reason `providerStorePath` is: it is a bearer
 * credential for a paid account. It is not a secret in the cryptographic sense
 * — it grants only what it says and cannot be altered — but a licence lifted
 * off a shared machine is a subscription used by someone who did not buy it.
 */
export async function storeLicence(storePath, token) {
  await writeStore(storePath, { token });
}

/** Forget the licence. Sign-out, and the only way back to free without waiting for expiry. */
export async function clearLicence(storePath) {
  await rm(storePath, { force: true });
}

/**
 * Sign out: revoke the session at the service, then forget it here.
 *
 * Both halves, in that order, and the second one unconditionally. Deleting the
 * store alone would leave a live bearer token on the server that this machine
 * can no longer revoke — the only copy of it was the file just deleted — so a
 * user who signs out because the laptop is being handed on has revoked
 * nothing. Calling the service first is what makes "sign out" true remotely.
 *
 * The network failing is not a reason to stay signed in. Someone offline who
 * presses sign out must be signed out locally regardless, so the revocation is
 * best-effort and its failure is reported, never raised: the session then dies
 * on its own TTL, which is the same outcome as before this function existed.
 */
export async function signOut(storePath, { baseUrl, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let revoked = false;
  let reason = null;
  const bearer = await readSessionToken(storePath);
  if (!bearer) reason = "not_signed_in";
  else if (!baseUrl) reason = "no_billing_service";
  else {
    try {
      await billingCall(fetchImpl, new URL("/api/signout", baseUrl), null, timeoutMs, { method: "POST", bearer });
      revoked = true;
    } catch (error) {
      reason = error?.code || "REVOKE_FAILED";
    }
  }
  await clearLicence(storePath);
  return { revoked, reason };
}

/**
 * What is this machine entitled to, right now?
 *
 * The one question the gateway asks. Always answers — there is no error path
 * that leaves the caller without an entitlement to enforce.
 *
 * `refreshAfter` is when the app should try to renew: deliberately well before
 * `expiresAt`, so that a user who is online daily never reaches grace at all
 * and a user who is offline for a week still has the full grace window
 * ahead of them when they land.
 */
export async function readEntitlement(storePath, { environment = process.env, now = Math.floor(Date.now() / 1000) } = {}) {
  const token = await readToken(storePath);
  if (!token) return freeEntitlement("no_licence");

  const result = verifyLicence(token, publicKeys(environment), { now });
  if (result.state === "invalid" || result.state === "expired") {
    return { ...freeEntitlement(result.reason), signedIn: result.state === "expired" };
  }

  const { licence } = result;
  return Object.freeze({
    plan: licence.plan ?? DEFAULT_PLAN,
    capabilities: licence.capabilities,
    state: result.state,
    reason: result.reason,
    subject: licence.subject,
    expiresAt: licence.expiresAt,
    // Refresh at a third of the token's life remaining, floored at an hour so a
    // short-TTL test build does not spin.
    refreshAfter: licence.expiresAt - Math.max(3600, Math.floor(DEFAULT_TTL_SECONDS / 3)),
    signedIn: true,
  });
}

/** Does the current entitlement grant `capability`? */
export function grants(entitlement, capability) {
  return Array.isArray(entitlement?.capabilities) && entitlement.capabilities.includes(capability);
}

/**
 * Ask the billing service for a fresh licence.
 *
 * Returns the new entitlement on success and the cached one on failure —
 * network trouble is not a downgrade. Only an explicit, verified answer from
 * the service changes what this machine believes.
 */
export async function refreshLicence(storePath, { baseUrl, sessionToken, environment = process.env, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const bearer = sessionToken ?? (await readSessionToken(storePath));
  if (!baseUrl || !bearer) return readEntitlement(storePath, { environment });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("/api/licence", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return readEntitlement(storePath, { environment });

    const body = await response.json();
    if (typeof body?.licence !== "string") return readEntitlement(storePath, { environment });

    // Verify before storing. A service that has been replaced — by a proxy, a
    // hosts-file entry, or a compromise — must not be able to write a token
    // this app would later read back and trust.
    const verified = verifyLicence(body.licence, publicKeys(environment), {});
    if (verified.state === "invalid") return readEntitlement(storePath, { environment });

    await storeLicence(storePath, body.licence);
    return readEntitlement(storePath, { environment });
  } catch {
    return readEntitlement(storePath, { environment });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which identity provider a sign-in uses when the caller names none.
 *
 * Sent explicitly rather than left to the service's own default so that the
 * app and the billing service cannot quietly disagree about which account a
 * user is signing into — the same person's GitHub and Google identities are
 * two different accounts, and a service-side default that changed would strand
 * every existing subscription behind the wrong one.
 */
export const DEFAULT_PROVIDER = "github";

/**
 * Begin a device-code sign-in.
 *
 * A desktop app cannot complete a browser redirect flow: there is no URL the
 * authority can send the user back to that only this process can receive, and
 * a loopback listener is a port anything else on the machine can race for. So
 * the app asks the service for a short code, the user types it into a page on
 * whatever device is convenient, and the app polls until it is claimed. The
 * secret never passes through the clipboard, the terminal, or a URL bar.
 */
export async function startSignIn({ baseUrl, fetchImpl = fetch, timeoutMs = 10_000, deviceName = null, provider = DEFAULT_PROVIDER } = {}) {
  if (!baseUrl) {
    throw Object.assign(new Error("No billing service is configured."), { status: 503, code: "BILLING_NOT_CONFIGURED" });
  }
  const body = await billingCall(fetchImpl, new URL("/api/device/start", baseUrl), { deviceName, provider }, timeoutMs);
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUrl: body.verificationUrl,
    expiresIn: body.expiresIn,
    interval: body.interval ?? 5,
  };
}

/**
 * Ask whether the code has been claimed yet.
 *
 * Returns `{ status: "pending" }` until someone approves it, then stores the
 * session and the first licence together and answers with the entitlement.
 * Storing both in one step is deliberate: a session written without a licence
 * would leave the app signed in and still free until the next refresh, which
 * reads as a failed purchase.
 */
export async function pollSignIn(storePath, { baseUrl, deviceCode, environment = process.env, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!baseUrl || !deviceCode) {
    throw Object.assign(new Error("No sign-in is in progress."), { status: 400, code: "SIGN_IN_NOT_STARTED" });
  }
  const body = await billingCall(fetchImpl, new URL("/api/device/poll", baseUrl), { deviceCode }, timeoutMs);
  if (body.status !== "granted") return { status: body.status ?? "pending" };

  // Same rule as refreshLicence: verify before storing. A service standing in
  // for the real one must not be able to write a token this app later trusts.
  if (typeof body.licence === "string") {
    const verified = verifyLicence(body.licence, publicKeys(environment), {});
    if (verified.state === "invalid") {
      throw Object.assign(new Error("The billing service returned a licence this build cannot verify."), {
        status: 502,
        code: "LICENCE_UNVERIFIABLE",
      });
    }
  }
  await writeStore(storePath, {
    sessionToken: typeof body.sessionToken === "string" ? body.sessionToken : undefined,
    token: typeof body.licence === "string" ? body.licence : undefined,
  });
  return { status: "granted", entitlement: await readEntitlement(storePath, { environment }) };
}

/**
 * What is for sale, straight from the billing service.
 *
 * Deliberately unauthenticated and deliberately not cached here: a price list
 * is public, and somebody deciding whether to sign in at all needs to see the
 * price BEFORE they have an account. Caching it in the gateway would mean a
 * price change took a restart to reach the people being charged it.
 *
 * The capability blurbs on each plan come from `licence/entitlements.js` on
 * the service side, so the upgrade screen and the gates cannot disagree about
 * what Pro actually unlocks.
 */
export async function listPlans({ baseUrl, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!baseUrl) {
    throw Object.assign(new Error("No billing service is configured."), { status: 503, code: "BILLING_NOT_CONFIGURED" });
  }
  const body = await billingCall(fetchImpl, new URL("/api/plans", baseUrl), null, timeoutMs, { method: "GET" });
  return { plans: Array.isArray(body.plans) ? body.plans : [] };
}

/**
 * Begin a payment on one of the two rails.
 *
 * The two rails answer differently, and the difference is not smoothed over
 * here because it is real: Stripe hands back a hosted checkout `url` for the
 * browser to finish, while Lipia pushes a prompt to a handset and hands back
 * an `order` to watch. Pretending both were the same shape would force the UI
 * to guess which one it got.
 *
 * A checkout needs the session, not the licence: the licence says what this
 * machine may do, the session says whose account is being charged. An
 * unsigned-in caller is told to sign in rather than sent to a payment page
 * that would reject them at the far end.
 */
export async function startCheckout(storePath, { baseUrl, rail, priceId, msisdn = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!baseUrl) {
    throw Object.assign(new Error("No billing service is configured."), { status: 503, code: "BILLING_NOT_CONFIGURED" });
  }
  if (rail !== "stripe" && rail !== "lipia") {
    throw Object.assign(new Error("Unknown payment rail."), { status: 400, code: "UNKNOWN_RAIL" });
  }
  if (!priceId) {
    throw Object.assign(new Error("No price was named."), { status: 400, code: "UNKNOWN_PRICE" });
  }
  const bearer = await readSessionToken(storePath);
  if (!bearer) {
    throw Object.assign(new Error("Sign in before starting a payment."), { status: 401, code: "NOT_SIGNED_IN" });
  }
  // 20s rather than the usual 10: a Lipia checkout waits on a mobile-money
  // gateway that is reaching a handset, which is slower than an HTTP hop.
  return billingCall(
    fetchImpl,
    new URL(`/api/checkout/${rail}`, baseUrl),
    { priceId, ...(msisdn ? { msisdn } : {}) },
    timeoutMs,
    { bearer },
  );
}

/**
 * How one order is going.
 *
 * Only mobile money needs this — a card checkout finishes in the browser and
 * the webhook lands before the user is back — but the route is rail-agnostic
 * because the buyer staring at a spinner does not care which rail they chose.
 * The service reconciles on read, so this is a real answer and not a cached one.
 */
export async function readOrder(storePath, { baseUrl, orderId, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!baseUrl) {
    throw Object.assign(new Error("No billing service is configured."), { status: 503, code: "BILLING_NOT_CONFIGURED" });
  }
  if (!orderId) {
    throw Object.assign(new Error("No order was named."), { status: 400, code: "UNKNOWN_ORDER" });
  }
  const bearer = await readSessionToken(storePath);
  if (!bearer) {
    throw Object.assign(new Error("Sign in to see this order."), { status: 401, code: "NOT_SIGNED_IN" });
  }
  return billingCall(fetchImpl, new URL(`/api/orders/${encodeURIComponent(orderId)}`, baseUrl), null, timeoutMs, {
    method: "GET",
    bearer,
  });
}

/**
 * One call to the billing service, with a timeout and an error worth reading.
 *
 * POST with a JSON body is the common case, so it is the default. `method` and
 * `bearer` exist for the catalogue (public, and a GET because a price list is
 * not a command) and for checkout (a POST that must carry the session, because
 * an order belongs to an account). A GET sends no body at all rather than an
 * empty object — some proxies treat a GET with a body as malformed.
 */
async function billingCall(fetchImpl, url, payload, timeoutMs, { method = "POST", bearer = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sendsBody = method !== "GET" && method !== "HEAD";
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...(sendsBody ? { "content-type": "application/json" } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(sendsBody ? { body: JSON.stringify(payload ?? {}) } : {}),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // A 404 is the one status this service and a misconfigured `baseUrl`
      // both produce, and they mean opposite things. `UNKNOWN_ORDER` and
      // `UNKNOWN_DEVICE_CODE` are definite answers from a service that is up;
      // a 404 from a host that is not the billing service means nothing about
      // the order and must not reach the user as though it did. The error
      // envelope tells them apart — only the service sends one — so a 404
      // becomes "unavailable" only when nobody answered in our own shape.
      const answered = Boolean(body?.error?.code);
      throw Object.assign(new Error(body?.error?.message || `The billing service answered ${response.status}.`), {
        status: response.status === 404 && !answered ? 503 : response.status,
        code: body?.error?.code || "BILLING_CALL_FAILED",
      });
    }
    return body ?? {};
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("The billing service did not answer in time."), { status: 504, code: "BILLING_TIMEOUT" });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The refusal a gate hands back when a capability is missing.
 *
 * Centralised so every gate refuses in the same words and with the same shape.
 * The message names the plan that would lift the block, because "not
 * entitled" without a remedy is the most annoying error a paid product can
 * produce.
 */
export function refusal(capability, entitlement) {
  return {
    code: "PLAN_UPGRADE_REQUIRED",
    capability,
    plan: entitlement?.plan ?? DEFAULT_PLAN,
    // `grace` is worth surfacing: the user IS entitled, the licence is merely
    // stale, and telling them to upgrade would be wrong.
    stale: entitlement?.state === "grace",
    message:
      entitlement?.state === "grace"
        ? "This licence needs to be refreshed. Connect to the internet to renew it."
        : UPGRADE_MESSAGE[capability] ?? "Teminali Code Pro is required for this feature.",
  };
}

/**
 * What to say when a capability is missing, per capability.
 *
 * Written here rather than at each gate so the wording stays consistent, and
 * per capability rather than once because "upgrade for the escalation lanes"
 * is a confusing thing to read after pressing a microphone button. Each line
 * also names what the free plan still has, which is the difference between an
 * upsell and a dead end.
 */
const UPGRADE_MESSAGE = Object.freeze({
  "frontier.escalation":
    "Teminali Code Pro is required for the hosted escalation lanes. Flash and Max stay available on the free plan.",
  "voice.vibevoice":
    "Teminali Code Pro is required for the VibeVoice speech tier. The built-in voices stay available on the free plan.",
  "frontier.max": "Teminali Code Pro is required for the Frontier Max profile. Flash stays available on the free plan.",
});

export { licenceGrants };
