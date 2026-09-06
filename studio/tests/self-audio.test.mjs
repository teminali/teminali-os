import assert from "node:assert/strict";
import test from "node:test";

import {
  SELF_AUDIO_TAIL_MS,
  SelfAudioMonitor,
  isElementAudible,
  watchBrowserAudio,
  watchMediaElements,
  watchTimelineAudio,
} from "../src/services/voice/selfAudio.ts";

/**
 * The app plays video and audio now, and a microphone a few centimetres from
 * the speakers hears all of it. The reported failure was the assistant
 * answering a film — a transcript that is real speech, correctly heard, and
 * from nobody in the room. What is pinned here is the provenance rule: what
 * counts as the app making sound, and how long after it stops the microphone
 * is still suspect.
 */

const element = (patch = {}) => ({
  paused: false,
  ended: false,
  muted: false,
  volume: 1,
  readyState: 4,
  isConnected: true,
  ...patch,
});

test("an element is only audible when every part of it says so", () => {
  assert.equal(isElementAudible(element()), true);
  for (const silent of [
    { paused: true },
    { ended: true },
    { muted: true },
    { volume: 0 },
    { isConnected: false },
    // Told to play, but with nothing to play yet: a video the operator has
    // just opened is silent for a moment before its first frame.
    { readyState: 1 },
  ]) {
    assert.equal(isElementAudible(element(silent)), false, JSON.stringify(silent));
  }
});

test("one source playing is enough, and every source must stop", () => {
  const monitor = new SelfAudioMonitor();
  monitor.set("media:1", true, 1000);
  monitor.set("browser:tab", true, 1000);
  assert.equal(monitor.audible, true);

  monitor.set("media:1", false, 2000);
  assert.equal(monitor.audible, true, "the browser tab is still playing");

  monitor.set("browser:tab", false, 2000);
  assert.equal(monitor.audible, false);
});

test("a turn that overlapped the playback is suspect even after it stops", () => {
  const monitor = new SelfAudioMonitor();
  monitor.set("media:1", true, 1000);
  monitor.set("media:1", false, 5000);

  // The operator started speaking at 4000, while the video was still playing.
  assert.equal(monitor.audibleSince(4000, 20_000), true);
  // And a turn that began after it went quiet, long enough ago that the
  // recogniser's lag cannot still be carrying it, is not.
  assert.equal(monitor.audibleSince(9000, 20_000), false);
});

test("the tail covers a recogniser handing back audio it heard a moment ago", () => {
  const monitor = new SelfAudioMonitor();
  monitor.set("media:1", true, 1000);
  monitor.set("media:1", false, 5000);

  const inside = 5000 + SELF_AUDIO_TAIL_MS - 1;
  assert.equal(monitor.audibleSince(inside, inside), true);
  const outside = 5000 + SELF_AUDIO_TAIL_MS + 1;
  assert.equal(monitor.audibleSince(outside, outside), false);
});

test("an app that has never played anything is never suspect", () => {
  const monitor = new SelfAudioMonitor();
  assert.equal(monitor.audible, false);
  assert.equal(monitor.audibleSince(0), false);
  assert.equal(monitor.audibleSince(Date.now()), false);
});

test("a dropped source cannot leave the microphone deaf", () => {
  const monitor = new SelfAudioMonitor();
  monitor.set("media:1", true, 1000);
  // React unmounts a playing <video> without a `pause` ever being fired; the
  // element is gone rather than silent, and nothing else will ever clear it.
  monitor.drop("media:1", 2000);
  assert.equal(monitor.audible, false);
  assert.equal(monitor.audibleSince(0, 2000 + SELF_AUDIO_TAIL_MS + 1), false);
});

/* A document just real enough to dispatch media events at a capture listener. */
function fakeDocument(nodes) {
  const handlers = new Map();
  return {
    nodes,
    addEventListener(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    removeEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
    },
    querySelectorAll() {
      return this.nodes;
    },
    dispatch(type) {
      for (const handler of handlers.get(type) ?? []) handler();
    },
    listenerCount() {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}

test("the document watch reads elements rather than counting transitions", () => {
  const video = element({ paused: true });
  const doc = fakeDocument([video]);
  const monitor = new SelfAudioMonitor();
  const stop = watchMediaElements(monitor, doc);

  assert.equal(monitor.audible, false);
  video.paused = false;
  doc.dispatch("play");
  assert.equal(monitor.audible, true);

  video.paused = true;
  doc.dispatch("pause");
  assert.equal(monitor.audible, false);

  stop();
  assert.equal(doc.listenerCount(), 0, "the watch leaves nothing behind");
});

test("an element removed while playing stops counting on the next read", () => {
  const video = element();
  const doc = fakeDocument([video]);
  const monitor = new SelfAudioMonitor();
  watchMediaElements(monitor, doc);
  assert.equal(monitor.audible, true);

  // The pane switched files: the element is gone, and no event says so.
  doc.nodes = [];
  assert.equal(monitor.audible, false, "the read re-scans the document");
});

test("a page in the browser panel counts as the app making sound", () => {
  const monitor = new SelfAudioMonitor();
  let publish = () => {};
  const bridge = {
    onState(handler) {
      publish = handler;
      return () => {};
    },
  };
  watchBrowserAudio(monitor, bridge);

  // A state message about navigation says nothing about audio and must not be
  // read as silence — the toolbar and the microphone ask different questions.
  publish({ id: "tab-1", url: "https://example.com", loading: false });
  assert.equal(monitor.audible, false);

  publish({ id: "tab-1", audible: true });
  assert.equal(monitor.audible, true);

  // Closing the tab is the one time the page cannot report its own silence.
  publish({ id: "tab-1", audible: false, closed: true });
  assert.equal(monitor.audible, false);
});

test("the video editor's timeline counts too, and the document sweep cannot see it", () => {
  const monitor = new SelfAudioMonitor();
  let report = () => {};
  let released = false;
  const engine = {
    onAudibleChange(handler) {
      report = handler;
      handler(false);
      return () => { released = true; };
    },
  };
  const stop = watchTimelineAudio(monitor, engine);

  /*
    The document sweep is run over the same moment to make the point: the
    timeline's voices are detached `Audio` elements, so a document that knows
    about no media at all is exactly what `watchMediaElements` sees while the
    operator's footage is playing out loud.
  */
  watchMediaElements(monitor, {
    addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [],
  });

  assert.equal(monitor.audible, false);
  report(true);
  assert.equal(monitor.audible, true, "a playing timeline is the app making sound");
  report(false);
  assert.equal(monitor.audible, false);

  // Stopping the watch forgets the timeline rather than freezing its last word.
  report(true);
  stop();
  assert.equal(released, true);
  assert.equal(monitor.audible, false);
});

test("a browser build has no bridge and no watch", () => {
  const monitor = new SelfAudioMonitor();
  assert.doesNotThrow(() => watchBrowserAudio(monitor, null)());
  assert.doesNotThrow(() => watchMediaElements(monitor, null)());
  assert.doesNotThrow(() => watchTimelineAudio(monitor, null)());
});

/*
  The wiring, which no unit test can reach: the monitor is only worth anything
  if the engine actually consults it, in both of the places our own speakers
  reach — the gate that turns words into a prompt, and the one that lets a
  sound cut the assistant off.
*/
test("the voice engine consults the monitor at both gates", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/services/voice/conversation.ts", import.meta.url), "utf8");

  assert.match(source, /import \{ selfAudio \} from "\.\/selfAudio"/);
  // Barge-in: our own playback is a long run of voiced frames.
  assert.match(source, /if \(selfAudio\.audible\)/);
  // The commit: a turn heard while the app was playing needs the wake word.
  assert.match(source, /selfAudio\.audibleSince\(this\.turnStartedAt\)/);
});
