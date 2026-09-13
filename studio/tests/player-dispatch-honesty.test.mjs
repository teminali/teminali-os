import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  dispatchPlayerCommand,
  notePlayerOnScreen,
  playerWillTake,
  subscribePlayerCommands,
} from "../src/services/playerControl.ts";

/*
  `dispatchPlayerCommand` answers one question and used to answer a different
  one. Its callers read the return value as "did a pane act on this": on false
  `aiService` tells the model no player is mounted, and `voice/playerActions`
  hands the turn back unhandled. What it actually measured was whether anything
  was subscribed, and a pane subscribes to the whole action list while acting
  on part of it. The episode gallery listens for `episode` and `episodes` and
  drops the other eighteen, so a `pause` said to the gallery came back true and
  Temi said it was done.

  The honest answer is built out of the snapshot the pane already publishes:
  `unsupported` is its own refusal list, and `view` and `series` say which of
  the two listeners is on screen. Nothing here is a new contract, which is why
  the fix did not need the panes to change.
*/

/** A snapshot shaped like a pane's, with only the fields the dispatch reads. */
function snapshot(overrides = {}) {
  return {
    view: "player",
    path: "/films/one.mkv",
    title: "One",
    kind: "video",
    series: null,
    playing: true,
    ended: false,
    time: 12,
    duration: 400,
    volume: 1,
    muted: false,
    rate: 1,
    subtitles: { available: [], active: null },
    fullscreen: false,
    unsupported: [],
    error: null,
    ...overrides,
  };
}

const SERIES = { folder: "/films/show", title: "Show", index: 2, count: 8, episodes: [] };

/** Subscribes, dispatches, and reports both the answer and what arrived. */
function dispatch(command, onScreen) {
  notePlayerOnScreen(onScreen);
  const seen = [];
  const stop = subscribePlayerCommands((received) => seen.push(received));
  try {
    return { answered: dispatchPlayerCommand(command), seen };
  } finally {
    stop();
    notePlayerOnScreen(null);
  }
}

test("no player mounted is still the plain no", () => {
  notePlayerOnScreen(null);
  assert.equal(dispatchPlayerCommand({ action: "pause" }), false);
  notePlayerOnScreen(snapshot());
  try {
    assert.equal(dispatchPlayerCommand({ action: "pause" }), false);
  } finally {
    notePlayerOnScreen(null);
  }
});

test("the episode gallery takes the list and refuses the rest", () => {
  const gallery = snapshot({ view: "episodes", playing: false, series: SERIES });

  for (const action of ["episode", "episodes"]) {
    const { answered, seen } = dispatch({ action, value: 3 }, gallery);
    assert.equal(answered, true, `the gallery answers ${action}`);
    assert.equal(seen.length, 1);
  }

  /*
    The measured bug. Every one of these returned true before, because
    something was subscribed, and the operator was told a film had been paused
    while looking at a grid of thumbnails.
  */
  for (const action of ["play", "pause", "toggle", "seek", "volume", "mute", "fullscreen", "next"]) {
    const { answered, seen } = dispatch({ action, value: 1 }, gallery);
    assert.equal(answered, false, `the gallery cannot answer ${action}`);
    assert.equal(seen.length, 0, `${action} must not be delivered to a listener that drops it`);
  }
});

test("`episode` reaches a player only when there is a list above it", () => {
  // A film opened on its own from the File panel. No gallery is mounted, so
  // nothing at all handles `episode`: the player itself returns early on it.
  const lone = dispatch({ action: "episode", value: 2 }, snapshot({ series: null }));
  assert.equal(lone.answered, false);
  assert.equal(lone.seen.length, 0);

  // An episode playing inside the gallery. Both panes are mounted, and the one
  // above takes it.
  const inSeries = dispatch({ action: "episode", value: 2 }, snapshot({ series: SERIES }));
  assert.equal(inSeries.answered, true);
  assert.equal(inSeries.seen.length, 1);
});

test("what the pane published as unsupported is refused here, not just at the gateway", () => {
  /*
    The gateway spends `unsupported` before it sends anything, but the chat and
    the voice lane call `dispatchPlayerCommand` in this renderer and never see
    it. A `<video>` element publishes `chapter` and `audio_track` as things it
    cannot do, and `MediaPlayer`'s `runCommand` has no branch for either, so
    both used to come back true and move nothing.
  */
  const video = snapshot({
    unsupported: [
      { action: "chapter", reason: "This player does not read the file's chapters." },
      { action: "audio_track", reason: "This player plays the file's first audio track." },
    ],
  });

  for (const action of ["chapter", "audio_track"]) {
    const { answered, seen } = dispatch({ action, value: 1 }, video);
    assert.equal(answered, false, `${action} was published as unsupported`);
    assert.equal(seen.length, 0);
  }

  const { answered, seen } = dispatch({ action: "pause" }, video);
  assert.equal(answered, true, "an action not on the list is unaffected");
  assert.equal(seen.length, 1);
});

test("silence is permission: a listener that has not published yet is still driven", () => {
  /*
    A pane subscribes in one effect and publishes in the next, and a command
    landing between the two is a real ordering rather than a hypothetical.
    Refusing on no information would invent a failure, so that window answers
    the way it always has.
  */
  const { answered, seen } = dispatch({ action: "pause" }, null);
  assert.equal(answered, true);
  assert.equal(seen.length, 1);
  assert.equal(playerWillTake({ action: "chapter" }, null), true);
});

test("playerWillTake is a pure reading of the snapshot", () => {
  const gallery = snapshot({ view: "episodes", series: SERIES });
  assert.equal(playerWillTake({ action: "episode" }, gallery), true);
  assert.equal(playerWillTake({ action: "episodes" }, gallery), true);
  assert.equal(playerWillTake({ action: "restart" }, gallery), false);

  assert.equal(playerWillTake({ action: "restart" }, snapshot()), true);
  assert.equal(playerWillTake({ action: "episode" }, snapshot()), false);
  assert.equal(playerWillTake({ action: "episode" }, snapshot({ series: SERIES })), true);

  const refused = snapshot({ unsupported: [{ action: "frame_step", reason: "No frame rate." }] });
  assert.equal(playerWillTake({ action: "frame_step" }, refused), false);
  assert.equal(playerWillTake({ action: "frame_back" }, refused), true);
});

/*
  The other half of the file's bug report was that the `Set` above the dispatch
  is per renderer, so a command sent in one window cannot reach a listener in
  another. That is true and it is deliberately not fixed: it is not reachable,
  because every caller of both functions is inside `App`, and `App` is the one
  document of the three that load this bundle that mounts any of them. The
  argument is written out in full above the `Set` in `playerControl.ts`.

  It is an argument that rests on a fact about the tree rather than on
  anything the type system holds, so the fact is pinned here. The day somebody
  dispatches or subscribes from the overlay surface or the recorder bar, the
  latent drop becomes a live one and this test is what says so.
*/
test("every caller of the dispatch lives in the studio window", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      if (/dispatchPlayerCommand\(|subscribePlayerCommands\(/.test(text)) {
        found.push(path.relative(src, full));
      }
    }
  })(src);

  assert.deepEqual(found.sort(), [
    "components/chat/StudioChat.tsx",
    "components/workspace/panels/AgentPane.tsx",
    "components/workspace/panels/GalleryPane.tsx",
    "components/workspace/panels/MediaPlayer.tsx",
    "services/aiService.ts",
    "services/playerControl.ts",
    "services/voice/playerActions.ts",
  ]);

  // And neither second surface is one of them. `src/main.tsx` renders a single
  // component for each, and `App` for everything else.
  const entry = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
  assert.match(entry, /surface === "overlay" \? \(\s*<AssistantOverlaySurface \/>/);
  assert.match(entry, /windowKind === "recorder-bar" \? \(\s*<RecorderBar \/>/);
});
