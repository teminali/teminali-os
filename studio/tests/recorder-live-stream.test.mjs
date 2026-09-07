import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SERVICE_DEFAULTS,
  buildDestinationUrl,
  displayServiceName,
  testLiveConnection,
} from "../electron/liveStreamer.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const electron = (name) => readFileSync(join(here, "..", "electron", name), "utf8");
const src = (...parts) => readFileSync(join(here, "..", "src", ...parts), "utf8");

/* ── Destination URL building ────────────────────────────────────── */

test("YouTube Live destination URL is correctly constructed from stream key", () => {
  const url = buildDestinationUrl("youtube", "", "abcd-1234-wxyz-5678");
  assert.equal(url, "rtmp://a.rtmp.youtube.com/live2/abcd-1234-wxyz-5678");
});

test("YouTube Live with custom or backup rtmp URL strips trailing slashes", () => {
  const url = buildDestinationUrl("youtube", "rtmp://b.rtmp.youtube.com/live2/", "my-secret-key");
  assert.equal(url, "rtmp://b.rtmp.youtube.com/live2/my-secret-key");
});

test("Twitch destination URL uses default ingest and appends stream key", () => {
  const url = buildDestinationUrl("twitch", "", "live_12345_abcde");
  assert.equal(url, "rtmp://live.twitch.tv/app/live_12345_abcde");
});

test("Facebook Live destination URL uses secure RTMPS endpoint", () => {
  const url = buildDestinationUrl("facebook", "", "FB-1234567890");
  assert.equal(url, "rtmps://live-api-s.facebook.com:443/rtmp/FB-1234567890");
});

test("Custom RTMP destination handles custom domain and port cleanly", () => {
  const url = buildDestinationUrl("custom", "rtmp://stream.mycompany.org:1935/live", "token-xyz");
  assert.equal(url, "rtmp://stream.mycompany.org:1935/live/token-xyz");
});

test("Empty stream key preserves base endpoint without trailing slash", () => {
  const url = buildDestinationUrl("youtube", "", "");
  assert.equal(url, "rtmp://a.rtmp.youtube.com/live2");
});

/* ── Display names ───────────────────────────────────────────────── */

test("displayServiceName formats known and custom services", () => {
  assert.equal(displayServiceName("youtube"), "YouTube Live");
  assert.equal(displayServiceName("twitch"), "Twitch");
  assert.equal(displayServiceName("facebook"), "Facebook Live");
  assert.equal(displayServiceName("custom"), "Custom RTMP");
  assert.equal(displayServiceName("unknown"), "Custom RTMP");
});

/* ── Connection test validation ──────────────────────────────────── */

test("testLiveConnection immediately rejects empty stream keys", async () => {
  const res = await testLiveConnection({ service: "youtube", streamKey: "" });
  assert.equal(res.ok, false);
  assert.match(res.error, /stream key is required/i);
});

test("testLiveConnection whitespace-only stream key is rejected", async () => {
  const res = await testLiveConnection({ service: "youtube", streamKey: "   " });
  assert.equal(res.ok, false);
  assert.match(res.error, /stream key is required/i);
});

/* ── Wire contracts ──────────────────────────────────────────────── */

test("screenRecorder.cjs registers liveChunk and testLiveConnection", () => {
  const recorderSource = electron("screenRecorder.cjs");
  assert.match(recorderSource, /ipcMain\.handle\("recorder:liveChunk"/);
  assert.match(recorderSource, /ipcMain\.handle\("recorder:testLiveConnection"/);
  assert.match(recorderSource, /webContents\.send\("recorder:liveStatus"/);
});

test("preload.cjs bridges liveChunk, testLiveConnection, and onLiveStatus", () => {
  const preloadSource = electron("preload.cjs");
  assert.match(preloadSource, /liveChunk:\s*\(sessionId,\s*bytes\)\s*=>/);
  assert.match(preloadSource, /testLiveConnection:\s*\(options\)\s*=>/);
  assert.match(preloadSource, /onLiveStatus:\s*\(listener\)\s*=>/);
});

test("RecorderBridge TypeScript contract declares live streaming methods", () => {
  const contractSource = src("types", "recorder.ts");
  assert.match(contractSource, /export interface LiveStreamConfig/);
  assert.match(contractSource, /export interface LiveStreamStatus/);
  assert.match(contractSource, /liveChunk:\s*\(/);
  assert.match(contractSource, /testLiveConnection:\s*\(/);
  assert.match(contractSource, /onLiveStatus:\s*\(/);
});

test("RecorderBarState interface includes live status flags", () => {
  const contractSource = src("types", "recorder.ts");
  assert.match(contractSource, /isLive\?: boolean/);
  assert.match(contractSource, /liveStatus\?: LiveStreamState \| null/);
});

test("StickySettings persists liveEnabled, liveService, and liveStreamKey", () => {
  const storeSource = src("video", "store", "recorderStore.ts");
  assert.match(storeSource, /liveEnabled:\s*boolean/);
  assert.match(storeSource, /liveService:\s*LiveStreamService/);
  assert.match(storeSource, /liveCustomUrl:\s*string/);
  assert.match(storeSource, /liveStreamKey:\s*string/);
  assert.match(storeSource, /liveBitrateKbps:\s*number/);
  assert.match(storeSource, /liveSaveLocal:\s*boolean/);
});

/* ── Hardening and Resilience Guards ─────────────────────────────── */

test("liveStreamer.cjs configures TCP nodelay, keepalive, and socket timeouts on FFmpeg", () => {
  const streamerSource = electron("liveStreamer.cjs");
  assert.match(streamerSource, /"-tcp_nodelay",\s*"1"/);
  assert.match(streamerSource, /"-tcp_keepalive",\s*"1"/);
  assert.match(streamerSource, /"-timeout",\s*"10000000"/);
  assert.match(streamerSource, /"-timeout",\s*"5000000"/);
});

test("screenRecorder.cjs disables background throttling while window is hidden", () => {
  const recorderSource = electron("screenRecorder.cjs");
  assert.match(recorderSource, /setBackgroundThrottling\(false\)/);
  assert.match(recorderSource, /setBackgroundThrottling\(true\)/);
});

test("screenRecorder.cjs chunk writer catches synchronous write exceptions", () => {
  const recorderSource = electron("screenRecorder.cjs");
  assert.match(recorderSource, /try\s*\{\s*out\.handle\.write/);
  assert.match(recorderSource, /catch\s*\(err\)\s*\{\s*out\.writeError/);
});

test("RecorderBar.tsx renders status-aware LIVE, CONNECTING, and LIVE ERR badges", () => {
  const barSource = src("components", "recorder", "RecorderBar.tsx");
  assert.match(barSource, /LIVE ERR/);
  assert.match(barSource, /CONNECTING/);
  assert.match(barSource, /LIVE/);
});

