/**
 * The licence token format, and the half of it that runs on the user's machine.
 *
 * This directory is shared deliberately. `billing/` signs licences and the
 * desktop app verifies them, and if each held its own idea of the wire format
 * they would drift — the drift would present as valid subscriptions being
 * refused in the field, which is the single worst bug this system can have.
 * So the format lives here once, and both halves import it.
 *
 * **Only verification lives here. Signing does not.** `licence/` is packaged
 * into the desktop app (studio/electron-builder.yml `extraResources`, the same
 * mechanism that ships `gateway/`), so anything in this file reaches every
 * user's disk. Verification is safe to ship — it needs only the public key.
 * `issueLicence` and the keypair generator live in `billing/src/licence.js`,
 * which is deployed to a server and never packaged.
 *
 * ## Why signed tokens rather than a licence check
 *
 * Pro gates the hosted escalation lanes, which cost real money per turn, so
 * the entitlement has to be authoritative. But the app it gates is a desktop
 * application expected to work on a plane, and its Flash and Max lanes run
 * entirely locally. An entitlement requiring a round trip would take the
 * offline half of the product down with it.
 *
 * So the authority signs and the app verifies: Ed25519 over a compact payload,
 * private key on the service, public key in every copy of the app.
 *
 * Three choices are worth stating, each the answer to a failure the obvious
 * design has:
 *
 *   - **`exp` is short and `grace` is long.** A signed token cannot be
 *     recalled — once issued it is valid until it expires, and a refund or a
 *     failed renewal cannot reach backwards to unsign it. So the token expires
 *     quickly and the app refreshes whenever it has a network. `grace` is how
 *     long past `exp` the app keeps honouring it while offline, and it is the
 *     only thing between a cancelled card and a user losing Pro mid-flight.
 *     Short `exp` bounds the theft; long `grace` protects the honest offline
 *     user. Separate numbers because they answer to separate risks.
 *
 *   - **The signature covers the exact bytes that were signed**, not a
 *     re-serialisation of the parsed payload. `JSON.stringify` does not promise
 *     stable key order across versions or engines, and a verifier that
 *     re-encodes eventually rejects a valid licence on a machine whose Node
 *     orders keys differently. The encoded segment travels and is verified
 *     verbatim.
 *
 *   - **`kid` names the key.** Rotating a signing key without a key id kills
 *     every licence in the field at once. With it, the app carries the retired
 *     public key beside the current one until the old tokens age out.
 *
 * The wire format is a JWS-shaped `<payload>.<signature>`, both base64url, but
 * deliberately NOT a JWT: there is no algorithm field to confuse, and so no
 * `"alg": "none"` to be tricked by. The algorithm is Ed25519 because this file
 * says so, and a token claiming otherwise is invalid by construction.
 */

import { createPublicKey, verify } from "node:crypto";

/** Bump only for a breaking change to the payload shape. */
export const LICENCE_VERSION = 1;

/**
 * How long a freshly issued licence stays valid.
 *
 * Seven days is the compromise: long enough that an ordinary user with
 * intermittent connectivity never notices a refresh, short enough that a
 * cancellation reaches the field within a week even if the user never comes
 * back online long enough to be told.
 */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long past expiry an offline app keeps honouring a licence.
 *
 * Fourteen days past a seven-day token means three weeks of genuine offline
 * use before Pro lapses. Past this the app does not error — it downgrades to
 * the free lanes, which still work, because a billing edge case must never
 * present as a broken product.
 */
export const DEFAULT_GRACE_SECONDS = 14 * 24 * 60 * 60;

/**
 * The claims of a licence, before anything signs them.
 *
 * Building the payload is format knowledge, so it lives here beside the
 * verifier rather than in whichever signer happens to run — there are two of
 * them (Node, for tests and tooling; WebCrypto, in the billing Worker) and a
 * field added to one and not the other is a licence that verifies everywhere
 * and means something different in each place.
 *
 * Shipping this in the packaged app costs nothing: an unsigned payload is not
 * a licence, and every field it names is one the verifier already reads back.
 */
export function buildLicencePayload({
  subject,
  plan,
  capabilities,
  keyId,
  issuedAt = Math.floor(Date.now() / 1000),
  ttlSeconds = DEFAULT_TTL_SECONDS,
  graceSeconds = DEFAULT_GRACE_SECONDS,
  device = null,
}) {
  if (typeof subject !== "string" || subject.length === 0) {
    throw new TypeError("A licence needs a subject.");
  }
  if (!Array.isArray(capabilities)) {
    throw new TypeError("A licence needs a capability list, even an empty one.");
  }
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new TypeError("A licence needs a key id, or it cannot survive key rotation.");
  }
  return {
    v: LICENCE_VERSION,
    sub: subject,
    plan: typeof plan === "string" ? plan : null,
    // Sorted so two licences granting the same thing are byte-identical, which
    // makes "did this change?" answerable by comparison rather than by parsing.
    caps: [...capabilities].sort(),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    grace: graceSeconds,
    kid: keyId,
    // Binding a licence to a device is optional and off by default. It stops
    // one subscription being pasted across a lab, but it also breaks the user
    // who reinstalls, so it is a policy decision rather than a default.
    device: typeof device === "string" && device.length > 0 ? device : null,
  };
}

export const encodeSegment = (buffer) => Buffer.from(buffer).toString("base64url");

export const decodeSegment = (segment) => Buffer.from(segment, "base64url");

/**
 * Verify a licence and say precisely what state it is in.
 *
 * This never throws on an invalid token. A licence arriving corrupt, forged or
 * expired is an ordinary state on the client — the caller has to render
 * something either way — and an exception would only push that decision up a
 * level. The `state` field is the answer:
 *
 *   `valid`   — signed, unexpired, honour it
 *   `grace`   — signed, past `exp`, still inside `grace`: honour it, but the
 *               UI should say the licence needs a refresh
 *   `expired` — signed, past `exp + grace`: downgrade to free
 *   `invalid` — did not verify at all: treat exactly as no licence
 *
 * `publicKeys` is a map of key id to PEM so a rotation can be carried without
 * invalidating tokens signed by the outgoing key.
 */
export function verifyLicence(token, publicKeys, { now = Math.floor(Date.now() / 1000), device = null } = {}) {
  const rejected = (reason) => ({ state: "invalid", reason, licence: null });

  if (typeof token !== "string" || token.length === 0) return rejected("missing");

  const parts = token.split(".");
  if (parts.length !== 2) return rejected("malformed");
  const [encodedPayload, encodedSignature] = parts;

  let payload;
  try {
    payload = JSON.parse(decodeSegment(encodedPayload).toString("utf8"));
  } catch {
    return rejected("malformed");
  }
  if (!payload || typeof payload !== "object") return rejected("malformed");
  if (payload.v !== LICENCE_VERSION) return rejected("version");

  const pem = publicKeys?.[payload.kid];
  if (!pem) return rejected("unknown_key");

  let verified = false;
  try {
    // Verified against the segment as it arrived. See the note at the top of
    // this file about why this is not re-serialised from `payload`.
    verified = verify(null, Buffer.from(encodedPayload), createPublicKey(pem), decodeSegment(encodedSignature));
  } catch {
    return rejected("malformed");
  }
  if (!verified) return rejected("signature");

  if (payload.device && device && payload.device !== device) return rejected("device");

  const licence = {
    subject: payload.sub,
    plan: payload.plan,
    capabilities: Array.isArray(payload.caps) ? payload.caps : [],
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    graceSeconds: Number.isFinite(payload.grace) ? payload.grace : 0,
    keyId: payload.kid,
    device: payload.device,
  };

  if (now <= licence.expiresAt) return { state: "valid", reason: null, licence };
  if (now <= licence.expiresAt + licence.graceSeconds) return { state: "grace", reason: "stale", licence };
  return { state: "expired", reason: "expired", licence };
}

/**
 * Does this verification result grant `capability`?
 *
 * The single question the rest of the system asks. Grace grants, expiry does
 * not, and an unreadable token is indistinguishable from having no licence —
 * which is the safe direction, because the free lanes still work.
 */
export function licenceGrants(result, capability) {
  if (!result || (result.state !== "valid" && result.state !== "grace")) return false;
  return result.licence.capabilities.includes(capability);
}
