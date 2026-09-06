import test from "node:test";
import assert from "node:assert/strict";

import {
  cursorHint,
  platformName,
  systemAudioWarning,
} from "../src/video/engine/platformCopy.ts";

/* ── Naming the machine ───────────────────────────────────────────────────── */

test("each platform is named the way an operator would name it", () => {
  assert.equal(platformName("darwin"), "macOS");
  assert.equal(platformName("win32"), "Windows");
  assert.equal(platformName("linux"), "Linux");
});

test("an unknown platform is not guessed at", () => {
  assert.equal(platformName(undefined), "this platform");
  assert.equal(platformName("freebsd"), "this platform");
});

/* ── The system-audio warning ─────────────────────────────────────────────── */

test("Windows gets no warning, because Windows can serve the request", () => {
  assert.equal(systemAudioWarning("win32", true), null);
  assert.equal(systemAudioWarning("win32", false), null);
});

test("the warning names the platform it is actually talking about", () => {
  const linux = systemAudioWarning("linux", true);
  assert.match(linux, /Linux/);
  assert.doesNotMatch(linux, /macOS/, "a Linux operator must not be told about macOS");

  assert.match(systemAudioWarning("darwin", true), /macOS/);
});

test("narration is promised only when a microphone is actually selected", () => {
  assert.match(systemAudioWarning("darwin", true), /microphone is still recorded/i);

  const silent = systemAudioWarning("darwin", false);
  assert.match(silent, /no sound at all/i);
  assert.doesNotMatch(silent, /still recorded/i, "a take with no mic has nothing to reassure about");
});

/* ── The pointer hint ─────────────────────────────────────────────────────── */

test("macOS states the measured fact that earned the option", () => {
  assert.match(cursorHint("darwin"), /does not contain the cursor/);
});

test("elsewhere the hint warns about doubling instead of asserting the unmeasured", () => {
  for (const platform of ["win32", "linux", undefined]) {
    const hint = cursorHint(platform);
    assert.match(hint, /two/, `${platform} should be warned about a doubled pointer`);
    assert.doesNotMatch(hint, /macOS/, `${platform} must not be told a macOS fact`);
  }
});
