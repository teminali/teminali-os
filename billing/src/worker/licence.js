/**
 * Minting licences. This is what the whole service exists to do.
 *
 * Everything else here — accounts, Stripe, Lipia, the cron — is machinery for
 * answering one question honestly: what is this user entitled to, right now?
 * The answer is signed and handed over, and the desktop app verifies it
 * offline against a public key baked into the build.
 *
 * Two rules hold this together, and both are enforced in this file:
 *
 *   1. **The capability list comes from `licence/entitlements.js`**, never
 *      from the database and never written out here. That file is the single
 *      authority on what a plan unlocks, and the app imports the same copy.
 *      A capability list in two places is a capability list that disagrees
 *      with itself, and the disagreement surfaces as a paying customer being
 *      refused something they bought.
 *
 *   2. **A licence never outlives the subscription that justifies it.** The
 *      default seven-day token issued the day before a period ends would keep
 *      paying out for six days after the money stopped. So the TTL is clamped
 *      to what the subscription actually has left.
 */

import { DEFAULT_PLAN, capabilitiesForPlan, isKnownPlan } from "../../../licence/entitlements.js";
import { DEFAULT_TTL_SECONDS } from "../../../licence/format.js";
import { signLicence } from "./crypto.js";
import { DUNNING_GRACE_MS, now, planForUser, userForToken } from "./db.js";
import { bearer, fail, json } from "./http.js";

/**
 * The shortest licence worth issuing.
 *
 * The app refreshes an hour before expiry (`refreshAfter` in
 * `studio/server/licence.js`), so anything under an hour is a token that is
 * stale before it is stored. A subscription with less than an hour left gets
 * one anyway — it expires almost immediately, which is the correct outcome,
 * and the app will ask again.
 */
const MIN_TTL_SECONDS = 60 * 60;

/**
 * How long a licence for this subscription should last.
 *
 * Free is the simple case: nothing costly is granted, so it gets the full TTL
 * and the app stops asking. A paid plan is clamped to the end of the dunning
 * window, which is the last moment `planForUser` would still answer "pro".
 */
export function ttlSecondsFor(planId, subscription, at = now()) {
  if (planId === DEFAULT_PLAN || !subscription) return DEFAULT_TTL_SECONDS;
  const remainingSeconds = Math.floor((subscription.current_period_end + DUNNING_GRACE_MS - at) / 1000);
  return Math.max(MIN_TTL_SECONDS, Math.min(DEFAULT_TTL_SECONDS, remainingSeconds));
}

/** The signing key and its id, or a refusal that says which one is missing. */
function signingConfig(env) {
  const signingKeyPem = env.LICENCE_SIGNING_KEY;
  const keyId = env.LICENCE_KEY_ID;
  if (!signingKeyPem || !keyId) {
    throw Object.assign(new Error("This deployment has no licence signing key configured."), {
      status: 503,
      code: "SIGNING_NOT_CONFIGURED",
    });
  }
  return { signingKeyPem, keyId };
}

/**
 * Issue a licence for a user, from whatever they are entitled to right now.
 *
 * Used by three callers — the licence route, the end of a device sign-in, and
 * nothing else. Keeping it one function is why a licence handed over at
 * sign-in cannot differ from one handed over at refresh.
 */
export async function issueLicenceFor(env, user, { device = null, at = now() } = {}) {
  const { signingKeyPem, keyId } = signingConfig(env);
  const { planId, subscription } = await planForUser(env, user.id, at);

  // A plan id in the database that this build does not know about resolves to
  // free rather than to an error. It means the plans table names something a
  // deploy has not shipped yet, and the safe reading of that is "not entitled",
  // not "the service is broken".
  const plan = isKnownPlan(planId) ? planId : DEFAULT_PLAN;

  const { token, payload } = await signLicence({
    signingKeyPem,
    subject: user.id,
    plan,
    capabilities: capabilitiesForPlan(plan),
    keyId,
    issuedAt: Math.floor(at / 1000),
    ttlSeconds: ttlSecondsFor(plan, subscription, at),
    device,
  });

  return { licence: token, plan, expiresAt: payload.exp, subscription };
}

/* ── POST /api/licence ─────────────────────────────────────────────
   Bearer session token in, signed licence out. `refreshLicence` in the
   desktop app calls exactly this and reads `body.licence`; it verifies the
   signature before writing anything to disk, so a service standing in for
   this one cannot plant a token the app would later trust. */

export async function postLicence(request, env) {
  const user = await userForToken(env, bearer(request));
  if (!user) return fail(401, "NOT_SIGNED_IN", "Sign in again to refresh this licence.");

  try {
    const { licence, plan, expiresAt } = await issueLicenceFor(env, user);
    return json({ licence, plan, expiresAt });
  } catch (error) {
    if (error?.code === "SIGNING_NOT_CONFIGURED") return fail(503, error.code, error.message);
    throw error;
  }
}
