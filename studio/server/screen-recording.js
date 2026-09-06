/**
 * Getting this application into the Screen Recording list.
 *
 * macOS does not let an application add itself. There is no API, no
 * entitlement and no prompt we can raise on demand: the row appears when a
 * person puts it there, and that is the whole of it. The honest options are
 * therefore to open the pane and to hand the operator the thing they have to
 * drag into it.
 *
 * Dragging is not a worse version of clicking a switch — for this application
 * it is the better one. Every ad-hoc build carries a fresh code identity, so a
 * reinstall leaves a row in the list that macOS no longer matches to the app
 * now running: the switch reads as on and the screen stays black. Dropping the
 * current bundle onto that list replaces the stale row, which flipping the
 * switch does not do. That is the failure this exists to end.
 *
 * The Finder reveal is deliberately last. System Settings takes focus as it
 * opens, so a window revealed before it is simply covered; revealed after, the
 * draggable item is the thing in front and the drop target is behind it.
 */

/** The Screen Recording page of System Settings › Privacy & Security. */
export const SCREEN_RECORDING_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * The `.app` three levels above the executable.
 *
 * `Teminali OS.app/Contents/MacOS/Teminali OS` is the shape, so the bundle
 * is the third parent. Returns null rather than guessing when the path is not
 * that shape — an unpackaged run is a bare binary somewhere in node_modules,
 * and revealing whatever happens to sit three levels above it would point the
 * operator at a directory that means nothing.
 */
export function appBundlePath(execPath, resolvePath) {
  if (typeof execPath !== "string" || !execPath) return null;
  const bundle = resolvePath(execPath, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/**
 * Open the Screen Recording list and reveal the bundle to drag into it.
 *
 * Resolves to `{ ok, bundlePath, isDevelopmentBundle, reason }` rather than
 * throwing: every caller renders the answer, and "I could not open that" is a
 * sentence, not a stack trace.
 *
 * `isDevelopmentBundle` is true when the bundle being revealed is the Electron
 * shell rather than a built Teminali OS. Revealing it is still correct — in
 * development that bundle is what macOS is being asked to trust — but the
 * operator is dragging something called Electron, and an interface that does
 * not say so looks broken.
 */
export async function revealForScreenRecording({
  execPath,
  packaged,
  platform,
  resolvePath,
  openPane,
  revealInFinder,
  wait = (ms) => new Promise((settle) => setTimeout(settle, ms)),
  settleMs = 600,
}) {
  if (platform !== "darwin") {
    return { ok: false, reason: "Screen Recording is a macOS permission." };
  }

  const bundlePath = appBundlePath(execPath, resolvePath);
  if (!bundlePath) {
    // Opening the pane is still worth doing: it is where the operator has to
    // end up, and it is better than a dead button.
    await openPane(SCREEN_RECORDING_PANE);
    return {
      ok: false,
      reason: "This build is not running from an .app bundle, so there is nothing to drag.",
    };
  }

  await openPane(SCREEN_RECORDING_PANE);
  await wait(settleMs);
  await revealInFinder(bundlePath);

  return { ok: true, bundlePath, isDevelopmentBundle: !packaged };
}
