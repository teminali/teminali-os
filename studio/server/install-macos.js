/**
 * Replacing this application's own bundle on macOS.
 *
 * The rest of the update flow downloads a file and hands it to the operating
 * system to open. On macOS that does not work and cannot be made to work: this
 * build is ad-hoc signed, the download carries no quarantine of its own but the
 * bundle it replaces is judged by Gatekeeper the moment LaunchServices is asked
 * to launch it, and the user is shown "Apple could not verify" with Done and
 * Move to Bin as the only buttons. There is no packaging of a .dmg, .pkg or
 * .command that avoids this — it is the launch path that is refused, not the
 * file format.
 *
 * So macOS is updated by doing the install here instead of asking for it: the
 * published .zip is expanded, the running bundle is moved aside, the fresh one
 * is copied into its place, and the copy is un-quarantined and re-signed ad-hoc
 * so the next launch is judged the same way this one was. LaunchServices is
 * never consulted, so there is never a dialog.
 *
 * Every command here is called by absolute path. `xattr` in particular must be
 * `/usr/bin/xattr`: a python.org Python installs its own `xattr` earlier in
 * PATH and that one has no `-r`, so the plain name silently does nothing on
 * some machines.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DITTO = "/usr/bin/ditto";
const XATTR = "/usr/bin/xattr";
const CODESIGN = "/usr/bin/codesign";
const CP = "/bin/cp";

function run(cmd, args, timeoutMs = 10 * 60_000) {
  return new Promise((settle, fail) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, _out, stderr) => {
      if (err) fail(new Error(String(stderr || "").trim() || err.message));
      else settle();
    });
  });
}

/**
 * Electron patches `fs` so that an asar archive reads as a directory — that is
 * what lets `require` work inside it — and a recursive remove therefore walks
 * into `app.asar` and then tries to `rmdir` a file. Turning the patch off for
 * the duration is the only way to delete an old bundle whole.
 */
function rmTree(target) {
  const patched = process.noAsar;
  process.noAsar = true;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } finally {
    process.noAsar = patched;
  }
}

/**
 * Swaps `bundlePath` for the .app inside `zipPath`.
 *
 * The old bundle is MOVED aside rather than deleted, and moved back if anything
 * before the copy completes fails. A half-replaced `/Applications/Teminali
 * Code.app` is the one outcome worth extra code to avoid: it leaves the user
 * with no working app and no obvious way back.
 *
 * Resolves to `{ ok, message }` rather than throwing, because the caller is an
 * IPC handler whose answer is rendered as it stands.
 */
export async function installMacUpdate({ zipPath, bundlePath, runImpl = run }) {
  if (typeof zipPath !== "string" || !zipPath) return { ok: false, message: "No downloaded update to install." };
  if (typeof bundlePath !== "string" || !bundlePath.endsWith(".app")) {
    return { ok: false, message: "This build is not running from an .app bundle, so it cannot replace itself." };
  }
  if (!fs.existsSync(zipPath)) return { ok: false, message: "The downloaded update is no longer on disk." };

  const target = resolve(bundlePath);
  const work = await mkdtemp(join(tmpdir(), "teminali-swap-"));
  const aside = `${target}.old-${Date.now()}`;
  const cleanup = () => {
    try {
      rmTree(work);
    } catch {
      /* A temporary directory left behind is not worth failing an update over. */
    }
  };

  // `ditto -xk` rather than `unzip`: it is what preserves the bundle's symlinks,
  // extended attributes and executable bits. An app expanded with `unzip` does
  // not launch.
  const staged = join(work, "staged");
  fs.mkdirSync(staged);
  try {
    await runImpl(DITTO, ["-xk", zipPath, staged]);
  } catch (err) {
    cleanup();
    return { ok: false, message: `The download could not be expanded. ${err.message}` };
  }

  const found = fs.readdirSync(staged).find((name) => name.endsWith(".app"));
  if (!found) {
    cleanup();
    return { ok: false, message: "The download held no .app bundle." };
  }
  const fresh = join(staged, found);
  if (!fs.existsSync(join(fresh, "Contents", "MacOS"))) {
    cleanup();
    return { ok: false, message: "The downloaded bundle is not shaped like an app." };
  }

  try {
    fs.renameSync(target, aside);
  } catch (err) {
    cleanup();
    // Crossing a filesystem, or /Applications not being writable by this user.
    return { ok: false, message: `The running app could not be moved aside. ${err.message}` };
  }

  try {
    await runImpl(CP, ["-a", fresh, target]);
    // Best effort, both of them: an update that is in place and running is
    // worth more than one refused because a signature could not be refreshed.
    // Without them the new bundle is merely as awkward as the old one was.
    try {
      await runImpl(XATTR, ["-cr", target]);
    } catch {
      /* best effort */
    }
    try {
      await runImpl(CODESIGN, ["--force", "--deep", "--sign", "-", target]);
    } catch {
      /* best effort */
    }
  } catch (err) {
    try {
      rmTree(target);
    } catch {
      /* Nothing was written there. */
    }
    fs.renameSync(aside, target);
    cleanup();
    return { ok: false, message: `The swap failed and the old version was put back. ${err.message}` };
  }

  // The new bundle is IN PLACE from here on, so nothing below may fail the
  // update. The caller's next move is to relaunch, which is what makes the new
  // bundle the running one — and what gets the Screen Recording, Accessibility
  // and Microphone prompts asked again, since those grants are keyed to a
  // signature that has just changed.
  try {
    rmTree(aside);
  } catch {
    /* The old bundle beside the new one is untidy, not broken. */
  }
  cleanup();
  return { ok: true, message: "Installed." };
}
