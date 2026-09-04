/**
 * Signing licences. Server-side only.
 *
 * The verifying half — the wire format, `verifyLicence`, `licenceGrants` and
 * the TTL/grace constants — lives in `licence/format.js`, which is shared with
 * the desktop app so the two halves cannot drift. This file holds what must
 * NEVER reach a user's disk: the keypair generator and the issuer.
 *
 * Keeping them apart is not ceremony. `licence/` is packaged into the app via
 * electron-builder `extraResources`; if `issueLicence` lived there, every
 * install would ship the code path that mints entitlements, one leaked private
 * key away from a licence generator. It is deployed, not distributed.
 */

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

import { DEFAULT_GRACE_SECONDS, DEFAULT_TTL_SECONDS, LICENCE_VERSION, buildLicencePayload, encodeSegment } from "../../licence/format.js";

export { DEFAULT_GRACE_SECONDS, DEFAULT_TTL_SECONDS, LICENCE_VERSION, licenceGrants, verifyLicence } from "../../licence/format.js";

/**
 * Generate a signing keypair.
 *
 * PEM on both halves because that is what gets pasted into a secret store and,
 * for the public half, committed to the app. The private half never leaves the
 * billing service.
 */
export function generateLicenceKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * Sign a licence.
 *
 * `capabilities` is the whole authority: the app asks "may I do X", and the
 * answer is whether X is in this list. Plans are named in the payload for
 * display and support, but nothing is ever gated on the plan NAME — renaming a
 * plan must not silently change what it unlocks.
 *
 * The claims come from `buildLicencePayload`, shared with the Worker's
 * WebCrypto signer. This function is the Node one: it is what the tests, the
 * keypair tooling and any local script use.
 */
export function issueLicence({ privateKeyPem, ...claims }) {
  const payload = buildLicencePayload(claims);
  const encodedPayload = encodeSegment(JSON.stringify(payload));
  const signature = sign(null, Buffer.from(encodedPayload), createPrivateKey(privateKeyPem));
  return `${encodedPayload}.${encodeSegment(signature)}`;
}
