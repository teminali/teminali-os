/*
  The one string that decides whether Touch ID passkeys work.

  Electron 44's `app.configureWebAuthn({ touchID })` stores WebAuthn
  credentials in the macOS keychain, in a named access group, and macOS will
  only hand an app a group its *signature* claims — so the group has to be
  written into `keychain-access-groups` at pack time and repeated verbatim at
  runtime. Get the two out of step and nothing announces it: the app starts,
  the API accepts the options, and the failure arrives later at credential
  store time as a passkey that will not save.

  Two measured facts shape everything below.

  1. **The group must contain the team ID.** It is of the form
     `<TEAM_ID>.<BUNDLE_ID>.webauthn`, and even Apple's implicit default group
     (`$(AppIdentifierPrefix)$(CFBundleIdentifier)`) is that same team prefix
     spelled with a macro. There is no team-ID-free shortcut, and
     `keychainAccessGroup` is a required option — so the string has to be
     composed from a real team ID either way.

  2. **`codesign` does not expand those macros.** Measured, not assumed: an
     entitlements plist containing `$(AppIdentifierPrefix)$(CFBundleIdentifier)`
     signed with `codesign --entitlements` and dumped back with
     `codesign -d --entitlements :-` returns the literal `$(...)` text. The
     substitution is Xcode's, not codesign's. So the plist that ships has to
     carry a literal, and `build/afterPack.cjs` composes it from
     `APPLE_TEAM_ID` — the only place in this repo that value exists
     (`.github/workflows/release.yml`, as a secret).

  Hence the shape: the entitlement is generated at pack time, and at runtime
  `electron/webauthn.cjs` reads the group back out of the app's own signature
  rather than recomposing it. The signature is what macOS enforces, so it is
  the only source that cannot be wrong — and an app signed without the
  entitlement simply does not enable the feature, which is the honest outcome
  rather than a silent one.

  Pure string work, kept apart from `electron/webauthn.cjs` so both the pack
  hook and the tests can require it without an Electron runtime.
*/

/**
 * The suffix that marks a keychain group as this feature's.
 *
 * Both ends agree on it: the pack hook appends it, and the runtime accepts
 * only a group carrying it — so an unrelated keychain group that happens to be
 * in the entitlement is never mistaken for the WebAuthn store.
 */
const WEBAUTHN_SUFFIX = ".webauthn";

/** Apple team identifiers are ten alphanumeric characters. */
const TEAM_ID = /^[A-Z0-9]{10}$/;

/** A bundle identifier, no more permissive than Apple's own rule for one. */
const BUNDLE_ID = /^[A-Za-z0-9.-]+$/;

/**
 * `<TEAM_ID>.<BUNDLE_ID>.webauthn`, or null when either half is missing.
 *
 * Null is the normal answer on a developer's machine: there is no team ID in
 * the repo, the build is ad-hoc signed, and Touch ID could not work there
 * anyway. The caller ships an entitlement without the group and the app runs
 * exactly as it did before.
 */
function composeKeychainAccessGroup(teamId, bundleId) {
  const team = typeof teamId === "string" ? teamId.trim().toUpperCase() : "";
  const bundle = typeof bundleId === "string" ? bundleId.trim() : "";
  if (!TEAM_ID.test(team) || !BUNDLE_ID.test(bundle)) return null;
  return `${team}.${bundle}${WEBAUTHN_SUFFIX}`;
}

/**
 * The `keychain-access-groups` array of an entitlements plist, in order.
 *
 * Reads both the pretty-printed file in `build/` and the single-line XML that
 * `codesign -d --entitlements :-` prints, which is why this is a regex over
 * the text rather than a plist parser: the input is ours in one case and
 * codesign's in the other, and neither is worth a dependency.
 */
function parseKeychainAccessGroups(plistXml) {
  if (typeof plistXml !== "string") return [];
  const array = /<key>\s*keychain-access-groups\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistXml);
  if (!array) return [];
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1].trim());
}

/** The first group that is this feature's, or null. */
function pickWebauthnGroup(groups) {
  if (!Array.isArray(groups)) return null;
  return groups.find((group) => typeof group === "string" && group.endsWith(WEBAUTHN_SUFFIX)) ?? null;
}

/**
 * The same plist with `keychain-access-groups` added.
 *
 * Idempotent, and deliberately additive: a plist that already declares the key
 * is returned untouched, because the checked-in file is the authority on what
 * else the app asks for and this hook is only allowed to append the one thing
 * it knows.
 */
function withKeychainAccessGroup(plistXml, group) {
  if (typeof plistXml !== "string") throw new TypeError("entitlements must be a string");
  if (typeof group !== "string" || !group) throw new TypeError("group must be a non-empty string");
  if (parseKeychainAccessGroups(plistXml).length > 0) return plistXml;
  const close = plistXml.lastIndexOf("</dict>");
  if (close < 0) throw new Error("entitlements plist has no <dict> to extend");
  const block =
    "    <!-- Written by build/afterPack.cjs from APPLE_TEAM_ID. Touch ID WebAuthn\n" +
    "         credentials are stored in this keychain group, and macOS grants an app\n" +
    "         only the groups its signature claims. See electron/webauthnGroup.cjs. -->\n" +
    "    <key>keychain-access-groups</key>\n" +
    "    <array>\n" +
    `      <string>${group}</string>\n` +
    "    </array>\n";
  return plistXml.slice(0, close) + block + plistXml.slice(close);
}

module.exports = {
  WEBAUTHN_SUFFIX,
  composeKeychainAccessGroup,
  parseKeychainAccessGroups,
  pickWebauthnGroup,
  withKeychainAccessGroup,
};
