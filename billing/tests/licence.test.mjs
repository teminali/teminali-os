/**
 * The licence is the only thing standing between a paid lane and a free one,
 * and it is verified on a machine the user controls. So these tests are
 * adversarial by default: most of them are attempts to get a capability
 * without paying for it, and each one must fail closed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_TTL_SECONDS,
  generateLicenceKeypair,
  issueLicence,
  licenceGrants,
  verifyLicence,
} from "../src/licence.js";
import {
  capabilitiesForPlan,
  isKnownPlan,
  profileAllowed,
  voiceTierAllowed,
} from "../../licence/entitlements.js";

const KEY_ID = "k1";
const keys = generateLicenceKeypair();
const publicKeys = { [KEY_ID]: keys.publicKeyPem };

const NOW = 1_800_000_000;

const proLicence = (overrides = {}) =>
  issueLicence({
    subject: "user_1",
    plan: "pro",
    capabilities: capabilitiesForPlan("pro"),
    keyId: KEY_ID,
    privateKeyPem: keys.privateKeyPem,
    issuedAt: NOW,
    ...overrides,
  });

test("a freshly signed Pro licence verifies and grants escalation", () => {
  const result = verifyLicence(proLicence(), publicKeys, { now: NOW + 60 });
  assert.equal(result.state, "valid");
  assert.equal(result.licence.plan, "pro");
  assert.ok(licenceGrants(result, "frontier.escalation"));
});

test("a free licence does not grant escalation, but keeps every local lane", () => {
  const token = issueLicence({
    subject: "user_2",
    plan: "free",
    capabilities: capabilitiesForPlan("free"),
    keyId: KEY_ID,
    privateKeyPem: keys.privateKeyPem,
    issuedAt: NOW,
  });
  const result = verifyLicence(token, publicKeys, { now: NOW + 60 });
  assert.equal(result.state, "valid");
  assert.equal(licenceGrants(result, "frontier.escalation"), false);
  // The point of the whole design: paying nothing still leaves a working
  // product. Both local capabilities run on the user's own hardware and stay
  // free; only escalation, which bills per turn, has a price. Escalation has a
  // free substitute in Flash, which is what makes refusing it fair.
  assert.ok(licenceGrants(result, "frontier.max"));
  assert.ok(licenceGrants(result, "voice.vibevoice"));
});

test("a tampered payload fails the signature rather than granting anything", () => {
  const [payload, signature] = proLicence().split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  decoded.caps = ["frontier.escalation", "frontier.max", "voice.vibevoice"];
  decoded.exp = NOW + 10 * 365 * 24 * 60 * 60;
  const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

  const result = verifyLicence(forged, publicKeys, { now: NOW + 60 });
  assert.equal(result.state, "invalid");
  assert.equal(result.reason, "signature");
  assert.equal(licenceGrants(result, "frontier.escalation"), false);
});

test("a licence signed by another keypair is rejected", () => {
  const attacker = generateLicenceKeypair();
  const token = issueLicence({
    subject: "user_3",
    plan: "pro",
    capabilities: capabilitiesForPlan("pro"),
    keyId: KEY_ID,
    privateKeyPem: attacker.privateKeyPem,
    issuedAt: NOW,
  });
  const result = verifyLicence(token, publicKeys, { now: NOW + 60 });
  assert.equal(result.state, "invalid");
  assert.equal(result.reason, "signature");
});

test("an unknown key id is rejected, and a rotated key still verifies its own tokens", () => {
  const rotated = generateLicenceKeypair();
  const token = issueLicence({
    subject: "user_4",
    plan: "pro",
    capabilities: capabilitiesForPlan("pro"),
    keyId: "k2",
    privateKeyPem: rotated.privateKeyPem,
    issuedAt: NOW,
  });

  assert.equal(verifyLicence(token, publicKeys, { now: NOW + 60 }).reason, "unknown_key");

  // Carrying both keys is what makes a rotation survivable.
  const both = { ...publicKeys, k2: rotated.publicKeyPem };
  assert.equal(verifyLicence(token, both, { now: NOW + 60 }).state, "valid");
});

test("past expiry the licence enters grace, and still grants", () => {
  const token = proLicence();
  const justPastExpiry = NOW + DEFAULT_TTL_SECONDS + 60;
  const result = verifyLicence(token, publicKeys, { now: justPastExpiry });
  assert.equal(result.state, "grace");
  // The offline user on a plane keeps working.
  assert.ok(licenceGrants(result, "frontier.escalation"));
});

test("past grace the licence expires and grants nothing", () => {
  const token = proLicence();
  const pastGrace = NOW + DEFAULT_TTL_SECONDS + DEFAULT_GRACE_SECONDS + 60;
  const result = verifyLicence(token, publicKeys, { now: pastGrace });
  assert.equal(result.state, "expired");
  assert.equal(licenceGrants(result, "frontier.escalation"), false);
});

test("garbage and absence are the same state, and neither throws", () => {
  for (const bad of [undefined, null, "", "not-a-token", "a.b.c", "!!!.???"]) {
    const result = verifyLicence(bad, publicKeys, { now: NOW });
    assert.equal(result.state, "invalid");
    assert.equal(licenceGrants(result, "frontier.escalation"), false);
  }
});

test("a device-bound licence refuses a different machine", () => {
  const token = proLicence({ device: "machine-a" });
  assert.equal(verifyLicence(token, publicKeys, { now: NOW + 60, device: "machine-a" }).state, "valid");
  assert.equal(verifyLicence(token, publicKeys, { now: NOW + 60, device: "machine-b" }).reason, "device");
});

test("the profile gate follows the capability, not the plan name", () => {
  const free = capabilitiesForPlan("free");
  const pro = capabilitiesForPlan("pro");

  // Hosted escalation is what Pro buys today, and the only thing.
  assert.equal(profileAllowed("auto", free), false);
  assert.equal(profileAllowed("claude-sonnet", free), false);
  assert.equal(profileAllowed("claude-opus", free), false);
  assert.ok(profileAllowed("auto", pro));

  // Local lanes stay open on free, which is the whole economic argument.
  assert.ok(profileAllowed("local", free));
  assert.ok(profileAllowed("local-expert", free));

  // The speech sidecar is open to every plan since 2026-09-05: on Windows
  // there is no built-in engine beneath it, so gating it left a free user with
  // no voice at all. The downgrade machinery is kept rather than deleted, so
  // withdrawing the capability still degrades instead of refusing.
  assert.ok(voiceTierAllowed("vibevoice", free));
  assert.ok(voiceTierAllowed("vibevoice", pro));
  assert.equal(voiceTierAllowed("vibevoice", ["frontier.max"]), false);
  assert.ok(voiceTierAllowed("builtin", free));
  assert.ok(voiceTierAllowed("local", free));

  // An unregistered profile is allowed rather than accidentally locked.
  assert.ok(profileAllowed("some-future-local-profile", free));
});

test("an unknown plan degrades to free instead of to nothing", () => {
  assert.equal(isKnownPlan("enterprise"), false);
  assert.deepEqual(capabilitiesForPlan("enterprise"), capabilitiesForPlan("free"));
});
