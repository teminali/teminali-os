import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVideoToolEvidence,
  hasVideoToolCalls,
  parseVideoToolCalls,
  runVideoToolCalls,
} from "../src/services/videoToolCalls.ts";

const ok = (data, durationMs = 3) => ({ success: true, data, durationMs });

test("only an explicit video-tool fence is executed", () => {
  // Documentation must never become an edit to the user's project.
  assert.deepEqual(parseVideoToolCalls('```json\n{"tool":"patch_clip","arguments":{}}\n```'), []);
  assert.deepEqual(parseVideoToolCalls('Call it like this: {"tool":"patch_clip"}'), []);
  assert.equal(hasVideoToolCalls("```bash\ndescribe_timeline\n```"), false);

  const calls = parseVideoToolCalls('Reading it.\n```video-tool\n{"tool":"describe_timeline","arguments":{}}\n```');
  assert.deepEqual(calls, [{ tool: "describe_timeline", arguments: {} }]);
});

test("a fence may hold one call, an array, or one per line", () => {
  const array = parseVideoToolCalls(
    '```video-tool\n[{"tool":"patch_clip","arguments":{"clipId":"c1"}},{"tool":"set_effect_param","arguments":{"effect":"glow","param":"radius","value":60}}]\n```',
  );
  assert.deepEqual(array.map((call) => call.tool), ["patch_clip", "set_effect_param"]);

  const lines = parseVideoToolCalls(
    '```video-tool\n{"tool":"patch_clip","arguments":{"clipId":"c1"}}\n{"tool":"patch_clip","arguments":{"clipId":"c2"}}\n```',
  );
  assert.deepEqual(lines.map((call) => call.arguments.clipId), ["c1", "c2"]);

  // Every fence in the turn counts, in order.
  const both = parseVideoToolCalls(
    '```video-tool\n{"tool":"describe_timeline","arguments":{}}\n```\nthen\n```video-tool\n{"tool":"patch_clip","arguments":{}}\n```',
  );
  assert.deepEqual(both.map((call) => call.tool), ["describe_timeline", "patch_clip"]);
});

test("the MCP spelling of a tool call is accepted", () => {
  // A model that has seen the tool schema writes name/input, not tool/arguments.
  const calls = parseVideoToolCalls('```video-tool\n{"name":"patch_clip","input":{"clipId":"c1"}}\n```');
  assert.deepEqual(calls, [{ tool: "patch_clip", arguments: { clipId: "c1" } }]);
});

test("malformed JSON yields no call rather than a guessed one", () => {
  assert.deepEqual(parseVideoToolCalls('```video-tool\n{"tool":"patch_clip",\n```'), []);
  assert.deepEqual(parseVideoToolCalls('```video-tool\npatch_clip transform.rotation 45\n```'), []);
  // A call with no tool name is not a call.
  assert.deepEqual(parseVideoToolCalls('```video-tool\n{"arguments":{"clipId":"c1"}}\n```'), []);
});

test("an unfinished fence still executes: the stream may have been cut", async () => {
  // The engine reads the turn text it has, and a model that stopped mid-fence
  // has still asked for the edit above the cut.
  const calls = parseVideoToolCalls('```video-tool\n{"tool":"describe_timeline","arguments":{}}');
  assert.deepEqual(calls, [{ tool: "describe_timeline", arguments: {} }]);
});

test("a failed tool is never reported as an edit that landed", async () => {
  const executions = await runVideoToolCalls('```video-tool\n{"tool":"patch_clip","arguments":{"clipId":"ghost"}}\n```', {
    execute: async () => ({ success: false, error: 'No clip matching "ghost".', durationMs: 1 }),
  });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].ok, false);
  const evidence = buildVideoToolEvidence(executions);
  assert.match(evidence, /# failed — No clip matching "ghost"\./);
  assert.equal(/succeeded/.test(evidence), false);
});

test("evidence carries the tool's real result", async () => {
  const executions = await runVideoToolCalls('```video-tool\n{"tool":"describe_timeline","arguments":{}}\n```', {
    execute: async () => ok({ tracks: [{ id: "V1", clips: [{ id: "clip-1" }] }] }),
  });
  const evidence = buildVideoToolEvidence(executions);
  assert.match(evidence, /describe_timeline\(\{\}\)/);
  assert.match(evidence, /# succeeded/);
  assert.match(evidence, /"clip-1"/);
});

test("an over-long result is marked truncated rather than silently clipped", async () => {
  const executions = await runVideoToolCalls('```video-tool\n{"tool":"describe_timeline","arguments":{}}\n```', {
    execute: async () => ok({ note: "x".repeat(200) }),
    maxOutputChars: 50,
  });
  assert.equal(executions[0].truncated, true);
  assert.match(buildVideoToolEvidence(executions), /# result truncated/);
});

test("the number of calls per turn is capped", async () => {
  const body = Array.from({ length: 9 }, (_, i) => `{"tool":"patch_clip","arguments":{"clipId":"c${i}"}}`).join("\n");
  let ran = 0;
  const executions = await runVideoToolCalls(`\`\`\`video-tool\n${body}\n\`\`\``, {
    execute: async () => {
      ran += 1;
      return ok({ clipId: "c", changes: [] });
    },
    maxCalls: 3,
  });
  assert.equal(ran, 3);
  assert.equal(executions.length, 3);
});

test("each call is surfaced to the chat as a running then settled tool card", async () => {
  const seen = [];
  await runVideoToolCalls('```video-tool\n{"tool":"patch_clip","arguments":{"clipId":"c1"}}\n```', {
    execute: async () => ok({ clipId: "c1", changes: [{ path: "transform.rotation", from: 0, to: 45 }] }),
    onToolCall: (call) => seen.push(call),
  });
  assert.deepEqual(seen.map((call) => call.status), ["running", "completed"]);
  assert.deepEqual(seen.map((call) => call.name), ["video.patch_clip", "video.patch_clip"]);
  assert.equal(seen[0].id, seen[1].id, "the card updates in place instead of stacking");
  // The card reads as an edit, not as a wall of JSON.
  assert.match(seen[1].result, /transform\.rotation → 45/);
});

test("a cancelled turn stops calling tools", async () => {
  const controller = new AbortController();
  let ran = 0;
  const executions = await runVideoToolCalls(
    '```video-tool\n{"tool":"patch_clip","arguments":{"clipId":"c1"}}\n{"tool":"patch_clip","arguments":{"clipId":"c2"}}\n```',
    {
      execute: async () => {
        ran += 1;
        controller.abort();
        return ok({ clipId: "c1", changes: [] });
      },
      signal: controller.signal,
    },
  );
  assert.equal(ran, 1, "the second call must not run after the user stopped the turn");
  assert.equal(executions.length, 1);
});
