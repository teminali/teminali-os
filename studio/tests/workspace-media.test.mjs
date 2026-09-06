import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkspaceMedia, parseByteRange } from "../server/workspace-media.js";
import { MEDIA_EXTENSIONS } from "../server/workspace.js";
import { WORKSPACE_MEDIA_TYPES, describeMediaError, formatDuration, syncWorkspaceMediaRoot, workspaceMediaOf, workspaceMediaUrl } from "../src/services/workspaceMedia.ts";

/**
 * The media route: what it streams, what it refuses, and how it answers a
 * seek. A `<video>` element is the client, and it is unforgiving in one
 * specific way — it plays a 200 but cannot seek in one, so the 206 path is
 * the feature, not an optimisation.
 */

const BYTES = Buffer.from("0123456789abcdef"); // 16 bytes, easy to index

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "workspace-media-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

/* ── the range grammar ───────────────────────────────────────────────────── */

test("the three single-range forms are read, and the end is clamped", () => {
  assert.deepEqual(parseByteRange("bytes=2-5", 16), { kind: "range", start: 2, end: 5 });
  assert.deepEqual(parseByteRange("bytes=3-", 16), { kind: "range", start: 3, end: 15 });
  assert.deepEqual(parseByteRange("bytes=-4", 16), { kind: "range", start: 12, end: 15 });
  assert.deepEqual(parseByteRange("bytes=0-999", 16), { kind: "range", start: 0, end: 15 });
  assert.deepEqual(parseByteRange("bytes=-999", 16), { kind: "range", start: 0, end: 15 });
});

test("a start past the end is unsatisfiable; anything unreadable is no range at all", () => {
  assert.deepEqual(parseByteRange("bytes=16-", 16), { kind: "unsatisfiable" });
  assert.deepEqual(parseByteRange("bytes=5-2", 16), { kind: "unsatisfiable" });
  assert.deepEqual(parseByteRange("bytes=-0", 16), { kind: "unsatisfiable" });
  assert.deepEqual(parseByteRange("bytes=0-1,4-5", 16), { kind: "none" });
  assert.deepEqual(parseByteRange("items=0-1", 16), { kind: "none" });
  assert.deepEqual(parseByteRange(null, 16), { kind: "none" });
  assert.deepEqual(parseByteRange("bytes=-", 16), { kind: "none" });
});

/* ── serving ─────────────────────────────────────────────────────────────── */

test("no range: the whole file as a 200 that advertises ranges", async () => {
  const root = workspace({ "clip.mp4": BYTES });
  const answer = await openWorkspaceMedia(root, "clip.mp4");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["Content-Type"], "video/mp4");
  assert.equal(answer.headers["Content-Length"], "16");
  assert.equal(answer.headers["Accept-Ranges"], "bytes");
  assert.equal(answer.headers["Cache-Control"], "no-store");
  assert.equal("Content-Range" in answer.headers, false);
  assert.equal(await drain(answer.stream), "0123456789abcdef");
});

test("a seek is a 206 with exactly the bytes asked for", async () => {
  const root = workspace({ "track.mp3": BYTES });
  const answer = await openWorkspaceMedia(root, "track.mp3", { range: "bytes=2-5" });
  assert.equal(answer.status, 206);
  assert.equal(answer.headers["Content-Type"], "audio/mpeg");
  assert.equal(answer.headers["Content-Range"], "bytes 2-5/16");
  assert.equal(answer.headers["Content-Length"], "4");
  assert.equal(await drain(answer.stream), "2345");
});

test("Chromium's opening `bytes=0-` gets a 206 covering the file, which is how it learns it can seek", async () => {
  const root = workspace({ "clip.webm": BYTES });
  const answer = await openWorkspaceMedia(root, "clip.webm", { range: "bytes=0-" });
  assert.equal(answer.status, 206);
  assert.equal(answer.headers["Content-Range"], "bytes 0-15/16");
  assert.equal(await drain(answer.stream), "0123456789abcdef");
});

test("a range past the end is a 416 that states the size", async () => {
  const root = workspace({ "clip.mov": BYTES });
  const answer = await openWorkspaceMedia(root, "clip.mov", { range: "bytes=16-" });
  assert.equal(answer.status, 416);
  assert.equal(answer.headers["Content-Range"], "bytes */16");
  assert.equal(answer.stream, undefined);
});

test("HEAD carries the headers and no body", async () => {
  const root = workspace({ "voice.wav": BYTES });
  const answer = await openWorkspaceMedia(root, "voice.wav", { method: "HEAD", range: "bytes=4-7" });
  assert.equal(answer.status, 206);
  assert.equal(answer.headers["Content-Length"], "4");
  assert.equal(answer.stream, undefined);
});

test("an empty file streams as an empty 200 rather than a broken range", async () => {
  const root = workspace({ "silence.flac": "" });
  const answer = await openWorkspaceMedia(root, "silence.flac", { range: "bytes=0-" });
  assert.equal(answer.status, 416);
  const whole = await openWorkspaceMedia(root, "silence.flac");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers["Content-Length"], "0");
  assert.equal(await drain(whole.stream), "");
});

/* ── refusals ────────────────────────────────────────────────────────────── */

test("an escape, a missing file, a folder and a symlink all look the same from outside: 404", async () => {
  const root = workspace({ "clip.mp4": BYTES });
  mkdirSync(join(root, "media.mp4"));
  writeFileSync(join(tmpdir(), "outside-media.mp4"), BYTES);
  test.after(() => rmSync(join(tmpdir(), "outside-media.mp4"), { force: true }));
  symlinkSync(join(tmpdir(), "outside-media.mp4"), join(root, "link.mp4"));

  assert.equal((await openWorkspaceMedia(root, "../outside-media.mp4")).status, 404);
  assert.equal((await openWorkspaceMedia(root, "missing.mp4")).status, 404);
  assert.equal((await openWorkspaceMedia(root, "media.mp4")).status, 404);
  assert.equal((await openWorkspaceMedia(root, "link.mp4")).status, 404);
  assert.equal((await openWorkspaceMedia(root, "clip\0.mp4")).status, 404);
});

test("a file the JSON reader serves is refused here, so no file has two readers", async () => {
  const root = workspace({ "notes.md": "hi", "logo.png": "x" });
  assert.equal((await openWorkspaceMedia(root, "notes.md")).status, 415);
  assert.equal((await openWorkspaceMedia(root, "logo.png")).status, 415);
});

test("no workspace root is a 503, not a read from nowhere", async () => {
  assert.equal((await openWorkspaceMedia(null, "clip.mp4")).status, 503);
  assert.equal((await openWorkspaceMedia("", "clip.mp4")).status, 503);
});

/* ── the pane's side ─────────────────────────────────────────────────────── */

test("the pane and the gateway admit exactly the same media formats", () => {
  assert.deepEqual(new Set(Object.keys(WORKSPACE_MEDIA_TYPES)), MEDIA_EXTENSIONS);
});

test("the element is chosen by extension, and a non-media path gets nothing", () => {
  assert.deepEqual(workspaceMediaOf("shots/Take 1.MOV"), { kind: "video", mimeType: "video/quicktime" });
  assert.deepEqual(workspaceMediaOf("voice/note.m4a"), { kind: "audio", mimeType: "audio/mp4" });
  assert.equal(workspaceMediaOf("notes.md"), null);
  assert.equal(workspaceMediaOf("book.xlsx"), null);
});

test("the URL comes from the bridge, encodes each segment, and is null in a browser build", () => {
  const bridge = { url: (path) => `teminali-media://abc/${path}`, announceRoot() {} };
  assert.equal(workspaceMediaUrl(bridge, "shots/Take 1 #final.mov"), "teminali-media://abc/shots/Take%201%20%23final.mov");
  assert.equal(workspaceMediaUrl(null, "clip.mp4"), null);
  assert.equal(workspaceMediaUrl(undefined, "clip.mp4"), null);
});

test("a codec Chromium cannot play is named with the conversion that fixes it", () => {
  const notSupported = describeMediaError(4, "shots/take.mov");
  assert.match(notSupported, /ProRes|HEVC/);
  assert.match(notSupported, /ffmpeg/);
  assert.match(describeMediaError(4, "film.mp4"), /HEVC|AC-3/);
  assert.match(describeMediaError(4, "song.ogg"), /ffmpeg/);
  assert.match(describeMediaError(3, "clip.mp4"), /decode|damaged/i);
  assert.match(describeMediaError(2, "clip.mp4"), /protocol/);
  assert.match(describeMediaError(0, "clip.mp4"), /did not name/);
});

test("a duration reads as a clock", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65.4), "1:05");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(Number.NaN), "");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "live");
});

/**
 * Which root main is told, and when.
 *
 * The store opens on a hardcoded `workspacePath` that stands until the
 * gateway's projects response lands. Repeating that guess is not a harmless
 * head start: main resolves every relative media path against the last root it
 * was given, so a restored pane asks for its file under a project the operator
 * never opened — a 404 no element retries, or worse, a different file of the
 * same name.
 */
function fakeStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    },
  };
}

function withBridge(run) {
  const announced = [];
  const previous = globalThis.window;
  globalThis.window = { teminali: { workspaceMedia: { url: (p) => p, announceRoot: (root) => { announced.push(root); return true; } } } };
  try {
    run(announced);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("the boot-time guess is never announced; main is better off knowing nothing", () => {
  withBridge((announced) => {
    const store = fakeStore({ workspacePath: "/guessed/root", workspaceRootConfirmed: false });
    const stop = syncWorkspaceMediaRoot(store);
    assert.deepEqual(announced, []);
    stop();
  });
});

test("the root reaches main the moment the gateway confirms it, even when it equals the guess", () => {
  withBridge((announced) => {
    const store = fakeStore({ workspacePath: "/guessed/root", workspaceRootConfirmed: false });
    const stop = syncWorkspaceMediaRoot(store);
    store.set({ workspaceRootConfirmed: true });
    assert.deepEqual(announced, ["/guessed/root"]);
    stop();
  });
});

test("a confirmed root is announced once, and again only when the project changes", () => {
  withBridge((announced) => {
    const store = fakeStore({ workspacePath: "/one", workspaceRootConfirmed: true });
    const stop = syncWorkspaceMediaRoot(store);
    store.set({ workspacePath: "/one" });
    store.set({ workspacePath: "/two" });
    assert.deepEqual(announced, ["/one", "/two"]);
    stop();
    store.set({ workspacePath: "/three" });
    assert.deepEqual(announced, ["/one", "/two"]);
  });
});

test("a browser build has no bridge to announce to, and does not throw looking for one", () => {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    const store = fakeStore({ workspacePath: "/one", workspaceRootConfirmed: true });
    assert.doesNotThrow(() => syncWorkspaceMediaRoot(store)());
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
