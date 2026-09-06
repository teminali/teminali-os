/*
  The player, from the local lane.

  The agent CLI lane reaches the player through the gateway and is covered by
  tests/player-state.test.mjs. This is the other lane: a model running inside
  the window, writing a fence that `frontierEngine` executes against the pane
  directly.

  What is worth testing is what actually went wrong in front of an operator.
  Asked to play a file open in the viewer, the local lane had no player tool,
  reached for `video-tool`, read the Teminali Cut timeline instead, and
  reported that the file did not exist. So: that the fence is parsed, that a
  malformed call comes back as a sentence rather than silence, that
  documentation is never executed, and that the two lanes accept the same
  actions — because an action one lane takes and the other rejects is the same
  class of bug wearing different clothes.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildPlayerToolEvidence,
  checkPlayerCommand,
  describeLivePlayer,
  executePlayerRequests,
  hasPlayerToolCalls,
  isRejection,
  parseFallbackPlayerToolCalls,
  parsePlayerToolCalls,
} from "../src/services/playerToolCalls.ts";
import { PLAYER_ACTIONS } from "../src/services/playerControl.ts";
import { LOCAL_PLAYER_ACTIONS, PLAYER_READ_ACTION } from "../src/services/playerToolCalls.ts";

const here = dirname(fileURLToPath(import.meta.url));

function snapshot(overrides = {}) {
  return {
    view: "player",
    path: "Downloads/4K Video Downloads/Instagram.mp4",
    title: "Instagram.mp4",
    kind: "video",
    series: null,
    playing: true,
    ended: false,
    time: 1,
    duration: 104,
    volume: 1,
    muted: false,
    rate: 1,
    subtitles: { available: [], active: null },
    fullscreen: false,
    error: null,
    ...overrides,
  };
}

test("a fence holding one command is parsed", () => {
  const text = 'Playing it now.\n```player-tool\n{"action":"play"}\n```';
  assert.equal(hasPlayerToolCalls(text), true);
  const parsed = parsePlayerToolCalls(text);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].command, { action: "play" });
});

test("an array in one fence is every command in order", () => {
  const text = '```player-tool\n[{"action":"episode","value":2},{"action":"play"}]\n```';
  const parsed = parsePlayerToolCalls(text);
  assert.deepEqual(parsed.map((item) => item.command.action), ["episode", "play"]);
  assert.equal(parsed[0].command.value, 2);
});

test("a json block is documentation and is never executed", () => {
  const text = 'To play it you would write:\n```json\n{"action":"play"}\n```';
  assert.equal(hasPlayerToolCalls(text), false);
  assert.equal(parsePlayerToolCalls(text).length, 0);
  assert.equal(parseFallbackPlayerToolCalls(text).length, 0);
});

test("a mistyped tag still lands, because the protocol was understood", () => {
  for (const tag of ["player_tool", "player-control", "player"]) {
    const parsed = parseFallbackPlayerToolCalls(`\`\`\`${tag}\n{"action":"pause"}\n\`\`\``);
    assert.equal(parsed.length, 1, tag);
    assert.deepEqual(parsed[0].command, { action: "pause" });
  }
});

test("the editor fence's shape is unwrapped rather than refused", () => {
  // A model that has just called video-tool writes {"tool":..,"arguments":{..}}
  // here out of habit. The intent is unambiguous.
  const checked = checkPlayerCommand({ tool: "player", arguments: { action: "seek", value: 30 } });
  assert.equal(isRejection(checked), false);
  assert.deepEqual(checked.command, { action: "seek", value: 30 });
});

test("an action the player does not have is refused with the list", () => {
  const checked = checkPlayerCommand({ action: "rewind_a_bit" });
  assert.equal(isRejection(checked), true);
  assert.match(checked.reason, /not a player action/);
  for (const action of PLAYER_ACTIONS) assert.ok(checked.reason.includes(action), action);
});

test("an action that needs a value is refused without one, in words", () => {
  const checked = checkPlayerCommand({ action: "seek" });
  assert.equal(isRejection(checked), true);
  assert.match(checked.reason, /numeric "value"/);
});

test("a number written as a string is taken, not argued with", () => {
  const checked = checkPlayerCommand({ action: "volume", value: "0.5" });
  assert.equal(isRejection(checked), false);
  assert.equal(checked.command.value, 0.5);
});

test("every action the gateway accepts, this fence accepts too", () => {
  // The drift this guards: an action added to one lane and not the other means
  // "pause it" works by voice and fails in chat, or the reverse.
  const gateway = readFileSync(join(here, "..", "server", "player-state.js"), "utf8");
  const list = gateway.match(/export const PLAYER_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(list, "server/player-state.js must still export a frozen PLAYER_ACTIONS list");
  const serverActions = [...list[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...PLAYER_ACTIONS].sort(), serverActions.sort());
  // The fence accepts one more than the gateway does, and only one: reading.
  // The CLI lane reads with a separate `player` tool; a fence has no room for
  // that split, and a model with only verbs loops asking for status.
  assert.deepEqual(
    LOCAL_PLAYER_ACTIONS.filter((action) => !serverActions.includes(action)),
    [PLAYER_READ_ACTION],
  );
  // A value each rule accepts, so the loop proves the action is known rather
  // than re-testing the value rules a test above already covers.
  const value = { subtitles: "English", fullscreen: true };
  for (const action of serverActions) {
    const checked = checkPlayerCommand({ action, value: action in value ? value[action] : 1 });
    assert.equal(isRejection(checked), false, `${action} was refused by the fence`);
  }
});

test("a command reaches the player and the state it left is the observation", async () => {
  const seen = [];
  const executions = await executePlayerRequests(parsePlayerToolCalls('```player-tool\n{"action":"play"}\n```'), {
    execute: async (command) => {
      seen.push(command);
      return { delivered: true, snapshot: snapshot() };
    },
  });
  assert.deepEqual(seen, [{ action: "play" }]);
  assert.equal(executions[0].ok, true);
  assert.match(executions[0].note, /Instagram\.mp4.*playing at 0:01 of 1:44/);
});

test("no mounted player is a plain failure, not a silence", async () => {
  const executions = await executePlayerRequests(parsePlayerToolCalls('```player-tool\n{"action":"play"}\n```'), {
    execute: async () => ({ delivered: false, snapshot: null }),
  });
  assert.equal(executions[0].ok, false);
  assert.match(executions[0].error, /No player is mounted/);
});

test("a malformed call is still evidence, so it is not repeated verbatim", async () => {
  const executions = await executePlayerRequests(parsePlayerToolCalls('```player-tool\n{"action":"seek"}\n```'), {
    execute: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].ok, false);
  assert.match(buildPlayerToolEvidence(executions), /numeric "value"/);
});

test("the evidence says which surface it came from", () => {
  const evidence = buildPlayerToolEvidence([
    { command: { action: "play" }, ok: true, note: describeLivePlayer(snapshot()), durationMs: 3 },
  ]);
  assert.match(evidence, /not the.*Teminali Cut timeline/s);
  assert.match(evidence, /`describe_timeline` cannot see it/);
});

test("an empty player is described as empty, not as an error", () => {
  assert.match(describeLivePlayer(null), /Nothing is open in the built-in player/);
});

test("a gallery is described with the action that starts an episode", () => {
  const described = describeLivePlayer(snapshot({
    view: "episodes",
    series: { folder: "Season 1", title: "Season 1", index: null, count: 8, episodes: [] },
  }));
  assert.match(described, /8 items/);
  assert.match(described, /"episode"/);
});

test("what the player cannot play is said, not hidden behind paused", () => {
  const described = describeLivePlayer(snapshot({ playing: false, error: "unsupported codec" }));
  assert.match(described, /cannot play \(unsupported codec\)/);
});

test("asking to read the player is an action, not a refusal and a retry", () => {
  // The loop the operator watched: six `{"action":"status"}` fences, six
  // refusals, six apologies, sixty-six seconds, and no answer.
  for (const word of ["status", "state", "current", "describe", "get_state"]) {
    const checked = checkPlayerCommand({ action: word });
    assert.equal(isRejection(checked), false, word);
    assert.equal(checked.command.action, PLAYER_READ_ACTION);
  }
});

test("a refusal names the read action too, so looking is always reachable", () => {
  const checked = checkPlayerCommand({ action: "rewind_a_bit" });
  assert.equal(isRejection(checked), true);
  assert.ok(checked.reason.includes(PLAYER_READ_ACTION));
});
