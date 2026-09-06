/*
  The assistant's own voice in a take.

  Its replies are synthesised in the renderer and played at the speakers, so
  no input device on the machine hears them and a recorded conversation had
  only the operator's half. Two pieces fix that, and both fail silently, so
  both are tested here: the tap that takes the signal where it exists
  (`speechBus.ts`) and the rule for where it lands (`capturePlan.ts`).
*/
import test from "node:test";
import assert from "node:assert/strict";

import { planSound } from "../src/video/engine/capturePlan.ts";
import {
  openSpeechTap,
  resetSpeechBus,
  routeElementToBus,
  speechBus,
} from "../src/services/voice/speechBus.ts";

/* ── A fake context that records what was wired to what ──────────────────── */

function fakeContext({ state = "running", gain = true, streamDest = true, elementSource = true, clone = true } = {}) {
  const connections = [];
  const context = { state };

  const node = (name) => ({
    name,
    context,
    connect: (target) => connections.push([name, target.name]),
  });

  context.destination = node("destination");
  if (gain) context.createGain = () => node("gain");
  if (streamDest) {
    context.createMediaStreamDestination = () => {
      const dest = node("tap");
      let stopped = false;
      const track = {
        name: "tapTrack",
        stop() { stopped = true; },
        get stopped() { return stopped; },
        ...(clone ? { clone: () => ({ name: "clone", stopped: false, stop() { this.stopped = true; } }) } : {}),
      };
      dest.stream = { getAudioTracks: () => [track] };
      dest.track = track;
      return dest;
    };
  }
  if (elementSource) context.createMediaElementSource = () => node("element");

  context.connections = connections;
  return context;
}

test.beforeEach(() => resetSpeechBus());

/* ── The bus ─────────────────────────────────────────────────────────────── */

test("the bus stays in front of the destination, so the speakers still get every reply", () => {
  const context = fakeContext();
  const bus = speechBus(context);
  assert.equal(bus.name, "gain");
  assert.deepEqual(context.connections, [["gain", "destination"]]);
});

test("the same context is given the same bus rather than a new one each reply", () => {
  const context = fakeContext();
  speechBus(context);
  speechBus(context);
  // One connection, not two: a second gain node feeding the destination would
  // play every clause twice as loud as the one before it.
  assert.equal(context.connections.length, 1);
});

test("a context with no gain node falls back to the destination, so audibility is never the thing lost", () => {
  const context = fakeContext({ gain: false });
  assert.equal(speechBus(context).name, "destination");
});

/* ── The tap ─────────────────────────────────────────────────────────────── */

test("the tap is fed by the bus and hands back a track", () => {
  const context = fakeContext();
  const track = openSpeechTap(context);
  assert.ok(track);
  assert.deepEqual(context.connections, [["gain", "destination"], ["gain", "tap"]]);
});

test("a bus built before the tap is rebuilt to feed it", () => {
  const context = fakeContext();
  speechBus(context);                       // the first reply, before any recording
  assert.deepEqual(context.connections, [["gain", "destination"]]);
  openSpeechTap(context);                   // a take starts mid-conversation
  assert.deepEqual(
    context.connections,
    [["gain", "destination"], ["gain", "destination"], ["gain", "tap"]],
    "the rebuilt bus reconnects to the destination and to the tap",
  );
});

test("what comes back is a clone, so stopping it at the end of a take leaves the tap alive", () => {
  const context = fakeContext();
  const first = openSpeechTap(context);
  first.stop();

  const second = openSpeechTap(context);
  assert.ok(second);
  assert.equal(second.stopped, false, "the second take gets a track that is not already stopped");
});

test("a context that cannot clone hands back nothing rather than a track that is unsafe to stop", () => {
  assert.equal(openSpeechTap(fakeContext({ clone: false })), null);
});

test("a context with no stream destination hands back nothing", () => {
  assert.equal(openSpeechTap(fakeContext({ streamDest: false })), null);
});

/* ── The whole-file path ─────────────────────────────────────────────────── */

test("a whole-file reply is routed through the bus", () => {
  const context = fakeContext();
  assert.equal(routeElementToBus(context, {}), true);
  assert.deepEqual(context.connections, [["gain", "destination"], ["element", "gain"]]);
});

test("a suspended context leaves the element alone — inaudible is worse than unrecorded", () => {
  const context = fakeContext({ state: "suspended" });
  assert.equal(routeElementToBus(context, {}), false);
  assert.deepEqual(context.connections, []);
});

/* ── Where the sound lands ───────────────────────────────────────────────── */

const plan = (over) => planSound({
  assistantVoice: true, systemAudio: false, mic: false, cameraVideo: false, ...over,
});

test("with nothing but the assistant, its voice rides the screen clip", () => {
  assert.deepEqual(plan(), { tapAssistant: true, screen: ["assistant"], camera: [] });
});

test("the microphone and the assistant are one narration", () => {
  assert.deepEqual(plan({ mic: true }).screen, ["mic", "assistant"]);
});

test("the assistant follows the microphone onto the camera clip, so it cannot drift from the face", () => {
  const result = plan({ mic: true, cameraVideo: true });
  assert.deepEqual(result.camera, ["mic", "assistant"]);
  assert.deepEqual(result.screen, []);
});

test("a camera with nobody talking into it does not take the narration with it", () => {
  // No microphone means no face to stay in sync with, and the screen clip is
  // the one clip every take has.
  const result = plan({ cameraVideo: true });
  assert.deepEqual(result.screen, ["assistant"]);
  assert.deepEqual(result.camera, []);
});

test("system audio suppresses the tap, because that loopback already carries the speakers", () => {
  const result = plan({ systemAudio: true, mic: true });
  assert.equal(result.tapAssistant, false);
  assert.deepEqual(result.screen, ["systemAudio", "mic"]);
  assert.ok(!result.screen.includes("assistant"), "a reply in the file twice is worse than one absent");
});

test("system audio still rides the screen clip while the narration rides the camera", () => {
  const result = plan({ systemAudio: true, mic: true, cameraVideo: true });
  assert.deepEqual(result.screen, ["systemAudio"]);
  assert.deepEqual(result.camera, ["mic"]);
});

test("the setting off means no tap, whatever else the take has", () => {
  assert.deepEqual(
    plan({ assistantVoice: false, mic: true }),
    { tapAssistant: false, screen: ["mic"], camera: [] },
  );
});

test("a take with no sound at all still asks for none", () => {
  assert.deepEqual(
    plan({ assistantVoice: false }),
    { tapAssistant: false, screen: [], camera: [] },
  );
});
