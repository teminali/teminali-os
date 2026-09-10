/*
  The keychain access group, which is the whole of whether Touch ID works.

  `app.configureWebAuthn({ touchID })` stores credentials in a named keychain
  group, and macOS grants an app only the groups its signature claims. A group
  that does not match the entitlement fails at credential-store time — not at
  startup, and with nothing on the console — so the two ends are pinned here
  instead of being discovered on a signed build a week later.

  Both ends are the same functions: `build/afterPack.cjs` composes the group
  and writes it into the entitlements it is about to sign, and
  `electron/webauthn.cjs` reads it back out of the signature with the same
  parser. The round trip below is that path, minus codesign.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  composeKeychainAccessGroup,
  parseKeychainAccessGroups,
  pickWebauthnGroup,
  withKeychainAccessGroup,
} from "../electron/webauthnGroup.cjs";
import { relyingPartyOf, webauthnAccounts } from "../electron/browserView.cjs";

const TEAM = "ABCDE12345";
const APP_ID = "os.teminali.app";

test("the group is the team ID, the bundle ID and the suffix, in that order", () => {
  assert.equal(composeKeychainAccessGroup(TEAM, APP_ID), "ABCDE12345.os.teminali.app.webauthn");
  // A team ID arrives from the environment, so it is trimmed and cased rather
  // than trusted to be typed correctly into a CI secret.
  assert.equal(composeKeychainAccessGroup(" abcde12345 ", APP_ID), "ABCDE12345.os.teminali.app.webauthn");
});

test("no team ID means no group, which is how an unsigned build stays silent", () => {
  // The normal case on a developer's machine: APPLE_TEAM_ID is absent, the
  // entitlement is written without the key, and the runtime finds nothing to
  // configure. Not an error — Touch ID could not work on an ad-hoc build.
  assert.equal(composeKeychainAccessGroup(undefined, APP_ID), null);
  assert.equal(composeKeychainAccessGroup("", APP_ID), null);
  // Ten alphanumerics, no more and no less: a truncated secret must not
  // produce a plausible-looking group that macOS will refuse at run time.
  assert.equal(composeKeychainAccessGroup("ABCDE1234", APP_ID), null);
  assert.equal(composeKeychainAccessGroup("ABCDE12345X", APP_ID), null);
  assert.equal(composeKeychainAccessGroup("ABCDE-2345", APP_ID), null);
  assert.equal(composeKeychainAccessGroup(TEAM, ""), null);
  assert.equal(composeKeychainAccessGroup(TEAM, "os teminali app"), null);
});

test("the group survives the trip through the entitlements plist", () => {
  const source = readFileSync(new URL("../build/entitlements.mac.plist", import.meta.url), "utf8");
  const group = composeKeychainAccessGroup(TEAM, APP_ID);
  const written = withKeychainAccessGroup(source, group);

  assert.deepEqual(parseKeychainAccessGroups(written), [group]);
  assert.equal(pickWebauthnGroup(parseKeychainAccessGroups(written)), group);
  // Everything the checked-in file already asked for is still asked for: this
  // hook appends, and the camera and Apple Events entitlements are the ones
  // whose loss has cost this app a release before.
  assert.ok(written.includes("com.apple.security.device.camera"));
  assert.ok(written.includes("com.apple.security.automation.apple-events"));
  assert.ok(written.trimEnd().endsWith("</plist>"));
});

test("writing the group twice writes it once", () => {
  // afterPack runs once per architecture and the generated file is reused, so
  // a second pass must not stack a second array onto the same plist.
  const source = readFileSync(new URL("../build/entitlements.mac.plist", import.meta.url), "utf8");
  const once = withKeychainAccessGroup(source, "ABCDE12345.os.teminali.app.webauthn");
  assert.equal(withKeychainAccessGroup(once, "OTHER12345.os.teminali.app.webauthn"), once);
});

test("codesign's own single-line dump parses", () => {
  // Not a hypothetical shape: this is what `codesign -d --entitlements :-`
  // prints, and it is what electron/webauthn.cjs reads at startup.
  const dumped =
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    "<key>com.apple.security.cs.allow-jit</key><true/>" +
    "<key>keychain-access-groups</key><array>" +
    "<string>ABCDE12345.os.teminali.app</string>" +
    "<string>ABCDE12345.os.teminali.app.webauthn</string>" +
    "</array></dict></plist>";
  assert.deepEqual(parseKeychainAccessGroups(dumped), [
    "ABCDE12345.os.teminali.app",
    "ABCDE12345.os.teminali.app.webauthn",
  ]);
  // The suffix is what tells the two apart. An app's ordinary keychain group
  // is not the WebAuthn store and must never be handed over as one.
  assert.equal(pickWebauthnGroup(parseKeychainAccessGroups(dumped)), "ABCDE12345.os.teminali.app.webauthn");
});

test("a signature with no keychain group answers nothing at all", () => {
  // The state every build before this one shipped in, and the state a build
  // made without APPLE_TEAM_ID still ships in: Touch ID stays off rather than
  // being enabled against a group macOS will not grant.
  assert.deepEqual(parseKeychainAccessGroups("<plist><dict></dict></plist>"), []);
  assert.equal(pickWebauthnGroup([]), null);
  assert.equal(pickWebauthnGroup(["ABCDE12345.os.teminali.app"]), null);
  assert.equal(pickWebauthnGroup(undefined), null);
});

test("the account chooser shows only what it can act on", () => {
  const chosen = webauthnAccounts({
    accounts: [
      { credentialId: "one", name: "ada@example.com", displayName: "Ada Lovelace" },
      { credentialId: "", name: "no id" },
      { name: "no id either" },
      { credentialId: "two", name: "   " },
    ],
  });
  // A credential with no id cannot be answered with, so offering it would be
  // offering a button that cancels the request.
  assert.deepEqual(chosen.map((account) => account.credentialId), ["one", "two"]);
  assert.equal(chosen[0].displayName, "Ada Lovelace");
  // Blank text is dropped rather than drawn as an empty row.
  assert.equal(chosen[1].name, undefined);
});

test("the site's text is clamped before it reaches the chooser", () => {
  // Every string here was written by the page that created the credential.
  const [account] = webauthnAccounts({
    accounts: [{ credentialId: "one", name: "x".repeat(500), displayName: "y".repeat(500) }],
  });
  assert.equal(account.name.length, 120);
  assert.equal(account.displayName.length, 120);
  assert.equal(relyingPartyOf({ relyingPartyId: "z".repeat(400) }).length, 253);
  assert.equal(relyingPartyOf({}), "");
  assert.deepEqual(webauthnAccounts({}), []);
  assert.deepEqual(webauthnAccounts(undefined), []);
});
