/* ═══════════════════════════════════════════════════════════════════
   Encryption at rest for a take's sidecar, and an honest account of
   what it buys.

   A recording writes two things. The video, which is the document the
   operator meant to make, and the sidecar — every cursor position at
   30Hz and the timing of every keystroke of the session. The second is
   exhaust, and it is a recording of how somebody works in a file that
   would otherwise be plain JSON in a folder that gets copied, backed up
   and shared. That is the part worth covering.

   ── What this protects against, and what it cannot ─────────────────

   It protects against another account on the machine reading a take's
   input log, and against a backup or a copied folder being readable as
   plain JSON. AES-GCM is AUTHENTICATED, so a changed byte does not
   decrypt to something plausible — it fails, and the caller is told the
   file was tampered with rather than handed a believable lie.

   It does NOT protect against a determined owner of the machine, and
   nothing running on that machine could. The key is derived from a
   secret this app wrote and this app can read; anything Teminali OS
   can decrypt, someone with Teminali OS can decrypt. Saying so is not
   a disclaimer — it is the difference between a design built for what
   it can do and one that pretends to be a vault.

   ── The one thing deliberately not encrypted ───────────────────────

   The video. A take's `screen.mp4` has to be opened by a `<video>`
   element to preview and by ffmpeg — a separate process — to export.
   Encrypting it would mean writing the plaintext back to the same disk
   before every export, or holding gigabytes in memory. Real cost, no
   benefit.

   ── Why the format half is pure ────────────────────────────────────

   `seal`/`open` take the key as an argument and touch no disk, so the
   property everything else rests on — that an edited file FAILS — is
   testable under plain `node --test` with no app and no Electron. The
   file half below owns the key and the filesystem.
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* ── The format ─────────────────────────────────────────────────────

     TEMv1.<purpose>.<iv>.<tag>.<ciphertext>

   All base64url, dot-separated, ASCII. Text rather than binary so that
   somebody who finds one of these can see what it is: "this is an
   encrypted Teminali OS file" is useful, and a wall of bytes that
   might be a corrupt video is not.                                   */

/** First field of every sealed file. Bump if the format ever changes. */
const ENVELOPE_MAGIC = "TEMv1";

/**
 * A 32-byte key for one purpose, derived from the device key.
 *
 * Per-purpose rather than one key for everything: under a single key a
 * ciphertext from one kind of file could be moved into another and
 * would decrypt. This makes that a decrypt failure instead of a
 * confusing success.
 */
function subKey(deviceKey, purpose) {
  return Buffer.from(
    crypto.hkdfSync("sha256", deviceKey, new Uint8Array(0), Buffer.from(purpose, "utf8"), 32),
  );
}

function seal(deviceKey, purpose, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", subKey(deviceKey, purpose), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    ENVELOPE_MAGIC,
    purpose,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/**
 * Open a sealed string.
 *
 * Three distinguishable failures, because they mean different things to
 * whoever has to act on them: `not-sealed` is a plain file (fine, and
 * handled by the caller), `wrong-purpose` is a file used for something
 * it was not written for, and `tampered` is the one that matters.
 *
 * @returns {{ok: true, plaintext: string} | {ok: false, reason: 'not-sealed'|'wrong-purpose'|'tampered', message: string}}
 */
function open(deviceKey, purpose, text) {
  const parts = String(text ?? "").split(".");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_MAGIC) {
    return { ok: false, reason: "not-sealed", message: "Not a sealed Teminali OS file." };
  }
  if (parts[1] !== purpose) {
    return {
      ok: false,
      reason: "wrong-purpose",
      message: `This is a sealed "${parts[1]}" file, opened as "${purpose}".`,
    };
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      subKey(deviceKey, purpose),
      Buffer.from(parts[2], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    const plaintext =
      decipher.update(Buffer.from(parts[4], "base64url"), undefined, "utf8") + decipher.final("utf8");
    return { ok: true, plaintext };
  } catch {
    return {
      ok: false,
      reason: "tampered",
      message: "This sealed file did not decrypt. It was edited, truncated, or written on another machine.",
    };
  }
}

/* ── The key, and the files ─────────────────────────────────────── */

/**
 * A random 32-byte secret, made once per install and never sent
 * anywhere.
 *
 * Not derived from a machine id, deliberately: a key derived from a
 * hostname or a serial number is the same key on every install of the
 * same build, so one person recovering it recovers everybody's.
 * Random-per-install means the worst case is one machine.
 */
let cachedKey = null;

function deviceKey() {
  if (cachedKey) return cachedKey;
  const { app } = require("electron");
  const file = path.join(app.getPath("userData"), "device-key");
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === 32) {
      cachedKey = existing;
      return cachedKey;
    }
  } catch {
    /* not made yet */
  }

  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key, { mode: 0o600 });
    // writeFileSync's mode is ignored when the file already exists.
    fs.chmodSync(file, 0o600);
  } catch {
    /*
      An unwritable userData directory is a broken install, and refusing
      to record would be worse than recording with a key that lives only
      for this session. The consequence is a sidecar that cannot be read
      back after a restart, which is visible where it matters.
    */
  }
  cachedKey = key;
  return cachedKey;
}

/** Write a sealed file, 0600. */
function writeSealed(filePath, purpose, plaintext) {
  fs.writeFileSync(filePath, seal(deviceKey(), purpose, plaintext), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

/**
 * Read a file that may or may not be sealed.
 *
 * A plain file comes back as itself. That is not a hole: nothing here
 * claims a file MUST be sealed, and a take assembled by hand, copied
 * from an older build, or written by a test has to keep working.
 */
function readMaybeSealed(filePath, purpose) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: "not-sealed", message: err.message };
  }
  const result = open(deviceKey(), purpose, text);
  if (result.ok || result.reason !== "not-sealed") return result;
  return { ok: true, plaintext: text };
}

/**
 * Make a directory only this user can enter.
 *
 * 0700 on the directory matters more than 0600 on the files inside it:
 * a mode on a file stops a read, and a mode on the directory stops the
 * listing that finds it. No-op on Windows, where the equivalent is an
 * ACL and the user profile already carries one.
 */
function makePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (os.platform() !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* already right, or not ours */
    }
  }
}

module.exports = {
  ENVELOPE_MAGIC,
  subKey,
  seal,
  open,
  writeSealed,
  readMaybeSealed,
  makePrivateDir,
};
