import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { SCREEN_RECORDING_PANE, appBundlePath, revealForScreenRecording } from "../server/screen-recording.js";

const PACKAGED_EXE = "/Applications/Teminali Code.app/Contents/MacOS/Teminali Code";

/** Records what the reveal reached for, and in which order. */
function spy({ platform = "darwin", packaged = true, execPath = PACKAGED_EXE } = {}) {
  const calls = [];
  return {
    calls,
    args: {
      execPath,
      packaged,
      platform,
      resolvePath: resolve,
      openPane: (url) => {
        calls.push(["pane", url]);
        return Promise.resolve();
      },
      revealInFinder: (target) => {
        calls.push(["reveal", target]);
        return Promise.resolve();
      },
      wait: (ms) => {
        calls.push(["wait", ms]);
        return Promise.resolve();
      },
    },
  };
}

/* ── Finding the bundle to drag ───────────────────────────────────────────── */

test("the bundle is the .app three levels above the executable", () => {
  assert.equal(appBundlePath(PACKAGED_EXE, resolve), "/Applications/Teminali Code.app");
});

test("a path that is not inside an .app yields nothing to drag", () => {
  // An unpackaged run is a bare binary in node_modules. Three levels above it
  // is a directory that would mean nothing to the operator, so it is refused
  // rather than revealed.
  assert.equal(appBundlePath("/repo/node_modules/.bin/electron", resolve), null);
  assert.equal(appBundlePath("", resolve), null);
  assert.equal(appBundlePath(undefined, resolve), null);
});

/* ── Opening the list, and handing over the thing to drop in it ───────────── */

test("the pane is opened and the bundle revealed", async () => {
  const { calls, args } = spy();
  const result = await revealForScreenRecording(args);

  assert.equal(result.ok, true);
  assert.equal(result.bundlePath, "/Applications/Teminali Code.app");
  assert.deepEqual(
    calls.filter(([kind]) => kind !== "wait"),
    [
      ["pane", SCREEN_RECORDING_PANE],
      ["reveal", "/Applications/Teminali Code.app"],
    ],
  );
});

test("Finder is revealed after the pane, never before", async () => {
  // System Settings takes focus as it opens. A window revealed first is simply
  // covered by it, which leaves the operator looking at the list with nothing
  // to drag into it.
  const { calls, args } = spy();
  await revealForScreenRecording(args);

  const kinds = calls.map(([kind]) => kind);
  assert.deepEqual(kinds, ["pane", "wait", "reveal"]);
  assert.ok(kinds.indexOf("pane") < kinds.indexOf("reveal"));
});

test("the settle wait between them is real, and adjustable", async () => {
  const { calls, args } = spy();
  await revealForScreenRecording({ ...args, settleMs: 250 });
  assert.deepEqual(calls.find(([kind]) => kind === "wait"), ["wait", 250]);
});

/* ── Being honest when there is nothing to offer ──────────────────────────── */

test("a development run still reveals, and says which bundle it revealed", async () => {
  // In development the bundle is Electron.app, and that is genuinely the one
  // macOS is being asked to trust — so it is revealed, and flagged, rather
  // than hidden behind a refusal the operator cannot act on.
  const { args } = spy({ packaged: false, execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" });
  const result = await revealForScreenRecording(args);

  assert.equal(result.ok, true);
  assert.equal(result.isDevelopmentBundle, true);
  assert.ok(result.bundlePath.endsWith("Electron.app"));
});

test("a packaged run is not flagged as a development bundle", async () => {
  const { args } = spy();
  const result = await revealForScreenRecording(args);
  assert.equal(result.isDevelopmentBundle, false);
});

test("with no bundle to drag, the pane still opens and the reason is stated", async () => {
  const { calls, args } = spy({ execPath: "/repo/node_modules/.bin/electron" });
  const result = await revealForScreenRecording(args);

  assert.equal(result.ok, false);
  assert.match(result.reason, /\.app bundle/);
  assert.deepEqual(calls, [["pane", SCREEN_RECORDING_PANE]]);
  assert.ok(!calls.some(([kind]) => kind === "reveal"));
});

test("off macOS nothing is opened at all", async () => {
  for (const platform of ["win32", "linux"]) {
    const { calls, args } = spy({ platform });
    const result = await revealForScreenRecording(args);
    assert.equal(result.ok, false);
    assert.match(result.reason, /macOS/);
    assert.deepEqual(calls, [], `${platform} should not reach the shell`);
  }
});

/* ── The pane itself ──────────────────────────────────────────────────────── */

test("the pane is the Screen Recording page, not the Privacy root", () => {
  // Landing on the root of Privacy & Security means hunting for the right row,
  // which is the step this feature exists to remove.
  assert.match(SCREEN_RECORDING_PANE, /^x-apple\.systempreferences:/);
  assert.match(SCREEN_RECORDING_PANE, /Privacy_ScreenCapture$/);
});
