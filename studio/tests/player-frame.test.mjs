/*
  `player_frame`, at the seam where the camera broke.

  The camera's frame path has a bug that has survived four releases: the window
  POSTs `images`, the gateway forwards `image`, and `resolveCameraFrame` reads
  `images` — so `look_at_me` fails every single time, and nothing caught it,
  because each of the three files is correct on its own. The failure lives
  entirely in the spelling of a key across a process boundary.

  So the word is pinned here, at both ends: `image`, singular, from the pane
  through the POST to the resolver. The rest is the round trip's own shape —
  a request that waits, an answer that arrives on its own POST, and every way
  it can fail loudly rather than time out.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openRun, closeRun, requestPlayerFrame, resolvePlayerFrame } from "../server/permission-bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A one-pixel JPEG's worth of base64. Nothing here decodes it; it only has to be a non-empty string. */
const PICTURE = "/9j/4AAQSkZJRg==";

test("the pane and the resolver spell the frame the same way", () => {
  /*
    A source assertion, deliberately, and the only one in this file. The bug it
    guards against is not reachable from either side alone: the renderer needs
    a DOM and the resolver needs a run, and both pass their own tests while
    disagreeing. What is actually wrong in the camera's case is a key name in a
    JSON body, so a key name in a JSON body is what is asserted.
  */
  const source = fs.readFileSync(path.join(here, "..", "src", "services", "playerFrame.ts"), "utf8");
  assert.match(source, /"\/api\/workspace\/player-frame"/, "the pane must answer on the route the gateway listens on");
  assert.match(source, /image\?: string/, "the capture's picture is `image`, singular — the word `resolvePlayerFrame` reads");
  // Comments stripped first: the header explains the camera's bug, and naming it is not committing it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/\bimages\b/.test(code), false, "`images` is the camera's spelling and the reason its frame never arrives");
});

test("a frame is asked for on the run's stream and answered on its own request", async () => {
  const seen = [];
  const token = openRun("frame-run", (event) => { seen.push(event); return true; });

  const pending = requestPlayerFrame({ runId: "frame-run", token });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "player-frame");
  assert.ok(seen[0].id, "the id is how the answer finds its way back");
  assert.ok(seen[0].expiresInMs > 0, "the window is told how long it has");

  const outcome = resolvePlayerFrame({
    runId: "frame-run",
    id: seen[0].id,
    image: PICTURE,
    time: 61.5,
    duration: 1200,
    title: "Episode 2",
  });
  assert.deepEqual(outcome, { ok: true });

  const frame = await pending;
  assert.equal(frame.image, PICTURE);
  assert.equal(frame.time, 61.5);
  assert.equal(frame.duration, 1200);
  assert.equal(frame.title, "Episode 2");
  assert.ok(Date.parse(frame.capturedAt), "when it was taken, so a stale frame can be told from a fresh one");
  closeRun("frame-run");
});

test("a frame the window could not take is a tool error, not a silence", async () => {
  const seen = [];
  const token = openRun("frame-error", (event) => { seen.push(event); return true; });
  const pending = requestPlayerFrame({ runId: "frame-error", token });
  resolvePlayerFrame({ runId: "frame-error", id: seen[0].id, error: "The player has no picture yet." });
  await assert.rejects(pending, /no picture yet/);

  // An answer with neither a picture nor a reason still fails, rather than resolving to an empty frame.
  const second = requestPlayerFrame({ runId: "frame-error", token });
  resolvePlayerFrame({ runId: "frame-error", id: seen[1].id, image: "" });
  await assert.rejects(second, /could not produce a picture/);
  closeRun("frame-error");
});

test("nothing else can answer for the window, and nothing answers twice", async () => {
  const seen = [];
  const token = openRun("frame-guard", (event) => { seen.push(event); return true; });

  await assert.rejects(requestPlayerFrame({ runId: "frame-guard", token: "not-the-token" }), /rejected the caller/);
  await assert.rejects(requestPlayerFrame({ runId: "no-such-run", token }), /no longer running/);

  const pending = requestPlayerFrame({ runId: "frame-guard", token });
  assert.deepEqual(resolvePlayerFrame({ runId: "frame-guard", id: seen[0].id, image: PICTURE }), { ok: true });
  await pending;
  // The second answer has nothing waiting on it and says so rather than throwing.
  assert.equal(resolvePlayerFrame({ runId: "frame-guard", id: seen[0].id, image: PICTURE }).ok, false);
  assert.equal(resolvePlayerFrame({ runId: "frame-guard", id: "invented", image: PICTURE }).ok, false);
  assert.equal(resolvePlayerFrame({ runId: "no-such-run", id: "x", image: PICTURE }).ok, false);
  closeRun("frame-guard");
});

test("a stopped turn fails the frame it was waiting for instead of holding the shim", async () => {
  /*
    The same choice the browser routes make and the camera does not: a frame is
    asked for in a chain — look, seek, look again — so a turn the operator
    stopped can have one in flight, and the shim holding it would sit out the
    whole timeout before the CLI could exit.
  */
  const token = openRun("frame-stopped", () => true);
  const pending = requestPlayerFrame({ runId: "frame-stopped", token });
  closeRun("frame-stopped");
  await assert.rejects(pending, /turn ended/);
});

test("a closed stream is said now, not waited out", async () => {
  const token = openRun("frame-mute", () => false);
  await assert.rejects(requestPlayerFrame({ runId: "frame-mute", token }), /stream is closed/);
  closeRun("frame-mute");
});

test("the engine is asked before the element, because while mpv has the picture there is no element", () => {
  /*
    An ordering assertion, and it is load-bearing rather than pedantic. While
    mpv owns the picture the pane hands over a null `element` on purpose — the
    frame is in another process, on a window this document cannot draw — so
    testing the element first answers "No video is open" about a film that is
    playing, and the agent repeats that sentence to the operator.

    None of this path has run on a Mac: `canEmbedSpawned` is false on darwin,
    so `engine` is null on this machine and every capture here is the element's.
    The order is therefore checked in the source rather than by running it.
  */
  const source = fs.readFileSync(path.join(here, "..", "src", "services", "playerFrame.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const engine = code.indexOf("showing?.engine");
  const element = code.indexOf("showing?.element");
  assert.ok(engine > 0 && element > 0, "both paths must still be there");
  assert.ok(engine < element, "the element path would answer first and answer wrongly");
  // Crossing a process boundary made this async; a caller that forgot would
  // POST a promise and the agent would receive `{}`.
  assert.match(code, /export async function capturePlayerFrame\(\): Promise<PlayerFrameCapture>/);
  assert.match(code, /await capturePlayerFrame\(\)/);
});
