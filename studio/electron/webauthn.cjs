/*
  Touch ID passkeys, from the signature outwards.

  The browser panel could not do passkeys at all: `WebContentsView` has
  Chromium's renderer but not Chrome's browser layer, and WebAuthn lives in the
  browser layer, so `isUserVerifyingPlatformAuthenticatorAvailable()` answered
  false and every request hung (see the probe in `browserView.cjs`). Electron 44
  supplies the missing half — `app.configureWebAuthn({ touchID })` implements a
  platform authenticator backed by this Mac's Secure Enclave, with the
  credentials kept in a named keychain access group.

  The group is the whole difficulty, and `webauthnGroup.cjs` records why. What
  matters here is the consequence: this module does not *compose* the group, it
  *reads* it out of the running app's own code signature. macOS grants an app
  only the keychain groups its signature claims, so the signature is the single
  authority — and an app that shipped without the entitlement leaves the
  feature off instead of enabling an API that would fail later, quietly, when a
  credential is first stored.

  ## What this does not buy

  Touch ID only. Not iCloud Keychain, not Windows Hello, not hybrid/QR phone
  passkeys, not USB security keys. The credentials are device-bound and do not
  sync. Windows and Linux still have no platform authenticator here at all,
  which is why the probe and its notice stay exactly where they are.
*/
const { execFile } = require("node:child_process");
const path = require("node:path");

const { parseKeychainAccessGroups, pickWebauthnGroup } = require("./webauthnGroup.cjs");

/**
 * How the Touch ID sheet explains itself.
 *
 * macOS renders it as `"Teminali OS" is trying to <reason>`, and `$1` is
 * replaced with the relying party — so this reads "…is trying to sign you in
 * to github.com". A lowercase fragment on purpose; it is the tail of someone
 * else's sentence.
 */
const PROMPT_REASON = "sign you in to $1";

/** Long enough for a cold `codesign`, short enough not to hold up a window. */
const READ_TIMEOUT_MS = 5_000;

/** The `.app` this process is running from, or null when it is not in one. */
function bundlePath(app) {
  const exe = app.getPath("exe");
  // …/Teminali OS.app/Contents/MacOS/Teminali OS → …/Teminali OS.app
  const bundle = path.resolve(exe, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/**
 * The entitlements sealed into a bundle's signature, as XML.
 *
 * `codesign -d --entitlements :-` is the same read `build/afterPack.cjs`
 * already uses to prove the entitlements reached the signature; this is the
 * runtime end of that check.
 */
function signedEntitlements(bundle) {
  return new Promise((resolve, reject) => {
    execFile(
      "codesign",
      ["-d", "--entitlements", ":-", bundle],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

/** The WebAuthn keychain group this build was actually signed with, or null. */
async function signedWebauthnGroup(app) {
  const bundle = bundlePath(app);
  if (!bundle) return null;
  const xml = await signedEntitlements(bundle);
  return pickWebauthnGroup(parseKeychainAccessGroups(xml));
}

/**
 * Turn on the Touch ID platform authenticator, if this build may have it.
 *
 * Answers the group it configured, or null — and never throws: a passkey that
 * cannot be enabled is the state the app has always been in, and it is not a
 * reason for a window not to open.
 *
 * Deliberately not called on a development run. An unpackaged app is Electron's
 * own bundle, signed with Electron's identity, carrying no group of ours — and
 * an ad-hoc signature gets a fresh code identity on every build, so credentials
 * stored under one would be unreadable by the next. Only a properly signed
 * build can hold a keychain group across installs, which is also why this is
 * not verifiable from `npm start`.
 */
async function configureTouchIdWebAuthn({ app, log = () => {} }) {
  if (process.platform !== "darwin") return null;
  if (!app.isPackaged) return null;
  if (typeof app.configureWebAuthn !== "function") {
    log("WebAuthn: this Electron has no configureWebAuthn; passkeys stay unavailable");
    return null;
  }

  let group = null;
  try {
    group = await signedWebauthnGroup(app);
  } catch (error) {
    log("WebAuthn: the app's signature could not be read:", error?.message || error);
    return null;
  }

  if (!group) {
    // Expected on every unsigned build: APPLE_TEAM_ID was absent at pack time,
    // so afterPack wrote no group and there is nothing macOS would honour.
    log("WebAuthn: no keychain access group in this build's signature; Touch ID stays off");
    return null;
  }

  try {
    app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: PROMPT_REASON } });
    log(`WebAuthn: Touch ID platform authenticator enabled (${group})`);
    return group;
  } catch (error) {
    log("WebAuthn: Touch ID could not be enabled:", error?.message || error);
    return null;
  }
}

module.exports = { PROMPT_REASON, bundlePath, configureTouchIdWebAuthn, signedWebauthnGroup };
