/**
 * Everything that has to be unguessable, constant-time, or signed.
 *
 * Three separate jobs using three different primitives, each for a reason:
 *
 *   - **Session tokens** are random and stored as a SHA-256 hash. A database
 *     dump must not be a pile of live logins.
 *   - **Webhook signatures** are HMAC-SHA256 over the RAW body, compared in
 *     constant time. The body is verified before it is parsed; `JSON.parse` of
 *     an unverified payload is already trusting it.
 *   - **Licences** are Ed25519, because `licence/format.js` says so and the
 *     desktop app verifies with `node:crypto`. There is no algorithm field on
 *     the wire and therefore nothing to confuse — see that file's header.
 *
 * This module runs in a Worker, so everything is WebCrypto. The Node signer in
 * `billing/src/licence.js` is the other implementation of the same format;
 * `billing/tests/worker-signer.test.mjs` signs with this one and verifies with
 * the app's verifier, which is the only way to know the two have not drifted.
 */

import { buildLicencePayload } from "../../../licence/format.js";

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A short prefixed id. Prefixed so a stray id in a log says what it is. */
export function newId(prefix) {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(input) {
  return hex(await crypto.subtle.digest("SHA-256", typeof input === "string" ? encoder.encode(input) : input));
}

export async function hmacSha256Hex(secret, body) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

/**
 * Constant time for equal-length inputs.
 *
 * `a === b` on a signature leaks how many leading bytes were right, one
 * request at a time. It is a small leak and it is also completely free not to
 * have.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── Licence signing ───────────────────────────────────────────────── */

/**
 * A PKCS8 PEM as the bytes WebCrypto wants.
 *
 * Stored as PEM rather than JWK because PEM is what the Node keypair
 * generator emits and what a person pastes into `wrangler secret put`. A
 * secret store mangles newlines often enough that `\n` written literally is
 * accepted here too — that is a real failure mode, not a hypothetical, and the
 * alternative is a deployment that signs nothing with an unhelpful error.
 */
function pkcs8Bytes(pem) {
  const body = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Import the signing key.
 *
 * `Ed25519` is the standard algorithm name and what workerd accepts today.
 * `NODE-ED25519` was the name Cloudflare shipped first and still answers to on
 * older compatibility dates, so it is tried second rather than assumed absent:
 * the failure mode of guessing wrong is a Worker that cannot sign at all,
 * which presents to every user as "upgrade did nothing".
 */
async function importSigningKey(pem) {
  const bytes = pkcs8Bytes(pem);
  try {
    return await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]);
  } catch {
    return crypto.subtle.importKey("pkcs8", bytes, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["sign"]);
  }
}

async function signBytes(key, data) {
  try {
    return await crypto.subtle.sign("Ed25519", key, data);
  } catch {
    return crypto.subtle.sign({ name: "NODE-ED25519" }, key, data);
  }
}

/**
 * Sign a licence.
 *
 * The claims come from `buildLicencePayload`, shared with the Node signer and
 * with the app's verifier, so a field added in one place cannot mean something
 * different in another. Only the encoding and the signature happen here — and
 * the payload is encoded exactly once, because the signature covers the bytes
 * that travel rather than a re-serialisation of them.
 */
export async function signLicence({ signingKeyPem, ...claims }) {
  if (typeof signingKeyPem !== "string" || signingKeyPem.length === 0) {
    throw Object.assign(new Error("No licence signing key is configured."), { code: "SIGNING_KEY_MISSING" });
  }
  const payload = buildLicencePayload(claims);
  const encodedPayload = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await importSigningKey(signingKeyPem);
  const signature = await signBytes(key, encoder.encode(encodedPayload));
  return { token: `${encodedPayload}.${base64url(new Uint8Array(signature))}`, payload };
}
