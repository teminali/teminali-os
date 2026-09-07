import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const electron = (name) => readFileSync(join(here, "..", "electron", name), "utf8");
const server = (name) => readFileSync(join(here, "..", "server", name), "utf8");

/* ── Subprocess Window Leak Prevention (windowsHide: true) ───────── */

test("all electron background child_process spawns and execs set windowsHide: true", () => {
  const liveStreamer = electron("liveStreamer.cjs");
  const mediaAccess = electron("mediaAccess.cjs");
  const screenRecorder = electron("screenRecorder.cjs");
  const videoExport = electron("videoExport.cjs");
  const workspaceMedia = electron("workspaceMedia.cjs");

  // liveStreamer
  assert.match(liveStreamer, /windowsHide:\s*true/);
  // mediaAccess
  assert.match(mediaAccess, /windowsHide:\s*true/);
  // screenRecorder ffmpeg calls
  assert.match(screenRecorder, /windowsHide:\s*true/);
  // videoExport
  assert.match(videoExport, /windowsHide:\s*true/);
  // workspaceMedia
  assert.match(workspaceMedia, /windowsHide:\s*true/);
});

test("server media-probe and speech-local set windowsHide: true on spawned processes", () => {
  const mediaProbe = server("media-probe.js");
  const speechLocal = server("speech-local.js");
  const pointer = server("pointer.js");

  assert.match(mediaProbe, /windowsHide:\s*true/);
  assert.match(speechLocal, /windowsHide:\s*true/);
  assert.match(pointer, /windowsHide:\s*true/);
});

/* ── Windows Display and Bounds Mapping ──────────────────────────── */

test("screenRecorder.cjs resolves display bounds for Windows desktopCapturer sources", () => {
  const recorder = electron("screenRecorder.cjs");
  // Ensures display_id fallback splits source.id (e.g. screen:0:0) and matches displays
  assert.match(recorder, /source\.id\.split\(["']:[["']\)/);
  assert.match(recorder, /screen\.getAllDisplays\(\)/);
  assert.match(recorder, /screen\.getPrimaryDisplay\(\)/);
});

/* ── File URL RFC 8089 Normalization on Windows ──────────────────── */

test("screenRecorder.cjs uses pathToFileURL for robust Windows drive letters and special characters", () => {
  const recorder = electron("screenRecorder.cjs");
  assert.match(recorder, /pathToFileURL/);

  // Validate Node.js pathToFileURL behavior with Windows-style paths
  const winPath = "C:\\Users\\Operator\\Videos\\Teminali #1 %20 Take.mp4";
  const url = pathToFileURL(winPath).href;
  assert.ok(url.startsWith("file:///"));
  assert.ok(url.includes("%23"), "hashes are percent-encoded in URLs");
  assert.ok(url.includes("%25"), "percents are percent-encoded in URLs");
});

/* ── Windows Permissions and Settings ────────────────────────────── */

test("screenRecorder.cjs handles Windows privacy settings URLs for camera and microphone", () => {
  const recorder = electron("screenRecorder.cjs");
  assert.match(recorder, /ms-settings:privacy-webcam/);
  assert.match(recorder, /ms-settings:privacy-microphone/);
});

/* ── Content Protection Guard ────────────────────────────────────── */

test("screenRecorder.cjs wraps setContentProtection in try/catch for Windows compatibility", () => {
  const recorder = electron("screenRecorder.cjs");
  assert.match(recorder, /try\s*\{\s*barWindow\.setContentProtection\(true\);\s*\}\s*catch/);
});

/* ── Windows Atomic Project Saving (renameSync EPERM/EBUSY Guard) ── */

test("videoProjects.cjs provides atomic write fallback for Windows file locking", () => {
  const videoProjects = electron("videoProjects.cjs");
  assert.match(videoProjects, /atomicWriteFileSync/);
  assert.match(videoProjects, /process\.platform === ["']win32["']/);
  assert.match(videoProjects, /copyFileSync/);
});

/* ── Windows Videos and Temp Path Fallbacks ──────────────────────── */

test("videoExport.cjs provides safe fallback when app.getPath('videos') is redirected", () => {
  const videoExport = electron("videoExport.cjs");
  assert.match(videoExport, /getVideosPath\(\)/);
  assert.match(videoExport, /getTempPath\(\)/);
});

/* ── Windows Path and Extension Resolution in media-probe ────────── */

test("media-probe.js findBinary uses path delimiter and checks Windows .exe extensions", () => {
  const mediaProbe = server("media-probe.js");
  assert.match(mediaProbe, /delimiter/);
  assert.match(mediaProbe, /\.exe/);
  assert.match(mediaProbe, /PATHEXT/);
});
