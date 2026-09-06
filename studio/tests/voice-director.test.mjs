import test from "node:test";
import assert from "node:assert/strict";
import { VoiceDirector } from "../src/services/voice/voiceDirector.ts";
import { smoothConversationalPunctuation, sanitizeOngoingAssist } from "../src/services/voice/speakable.ts";

test("VoiceDirector.curateSpeech strips code blocks and syntax", () => {
  const input = `I found the problem. Here is the fix:
\`\`\`ts
export function handleClick() {
  console.log("clicked");
}
\`\`\`
Let me know if you need anything else.`;

  const curated = VoiceDirector.curateSpeech(input, true);
  assert.ok(!curated.includes("handleClick"), "code identifier must not be spoken");
  assert.ok(!curated.includes("console.log"), "console.log must not be spoken");
  assert.ok(curated.includes("I found the problem"), "prose before code must be kept");
  assert.ok(curated.includes("Let me know if you need anything else"), "prose after code must be kept");
});

test("VoiceDirector.curateSpeech strips frontier-run and bash blocks", () => {
  const input = `Let me check the status now.
\`\`\`frontier-run
git status
npm test
\`\`\`
All checks passed.`;

  const curated = VoiceDirector.curateSpeech(input, true);
  assert.ok(!curated.includes("git status"), "terminal command must not be spoken");
  assert.ok(!curated.includes("npm test"), "terminal command must not be spoken");
  assert.ok(curated.includes("Let me check the status now"), "intro prose kept");
  assert.ok(curated.includes("All checks passed"), "outro prose kept");
});

test("VoiceDirector.curateSpeech strips markdown tables and image links", () => {
  const input = `Here is the comparison:
| Metric | Value |
| --- | --- |
| Speed | 10ms |
![Preview](http://example.com/img.png)
Everything is looking great.`;

  const curated = VoiceDirector.curateSpeech(input, true);
  assert.ok(!curated.includes("Metric"), "table headers stripped");
  assert.ok(!curated.includes("http://example.com"), "image url stripped");
  assert.ok(curated.includes("Here is the comparison"), "intro kept");
  assert.ok(curated.includes("Everything is looking great"), "outro kept");
});

test("VoiceDirector converts robotic 'today' to 'now' on ongoing conversations", () => {
  const input = "How can I assist you today? What can I help you with today?";
  const ongoingCurated = VoiceDirector.curateSpeech(input, false);
  assert.ok(ongoingCurated.includes("How can I assist you now?"));
  assert.ok(!ongoingCurated.includes("today"));

  const freshCurated = VoiceDirector.curateSpeech(input, true);
  assert.ok(freshCurated.includes("today"), "fresh conversation can keep 'today'");
});

test("smoothConversationalPunctuation removes stutter commas and collapses punctuation", () => {
  const input = "Well, I checked the files, and everything looks good, but we should test it.";
  const smoothed = smoothConversationalPunctuation(input);
  assert.equal(smoothed, "Well I checked the files and everything looks good but we should test it.");

  const doubled = "Done.. Ready,, let's go!!";
  assert.equal(smoothConversationalPunctuation(doubled), "Done. Ready, let's go!");
});

test("VoiceDirector streams sentences as tokens arrive and ignores code fence content", () => {
  const chunks = [];
  const director = new VoiceDirector({
    isFreshConversation: false,
    maxStreamedChunks: 4,
    onSpeechChunk: (chunk, isFinal) => {
      if (chunk) chunks.push({ chunk, isFinal });
    },
  });

  const stream = [
    "I'm ", "checking ", "the ", "git ", "status. ",
    "```frontier-run\n",
    "git ", "status\n",
    "```\n",
    "Everything ", "is ", "clean.",
  ];

  for (const token of stream) {
    director.pushToken(token);
  }
  director.finish();

  assert.ok(chunks.length >= 2, "Expected at least 2 spoken chunks");
  assert.ok(chunks[0].chunk.includes("I'm checking the git status"));
  assert.ok(!chunks.some((c) => c.chunk.includes("git status\n")));
  assert.ok(chunks[chunks.length - 1].chunk.includes("Everything is clean"));
});

test("VoiceDirector onToolCall provides live step narration descriptions", () => {
  const director = new VoiceDirector({
    onSpeechChunk: () => {},
  });

  const line1 = director.onToolCall({
    id: "call-1",
    name: "frontier.run_command",
    arguments: { command: "npm test" },
    status: "running",
  });
  assert.equal(line1, "Running the tests.");

  const line2 = director.onToolCall({
    id: "call-2",
    name: "read_file",
    arguments: { path: "src/services/voiceDirector.ts" },
    status: "running",
  });
  assert.ok(line2.includes("Reading voiceDirector dot ts"));
});

test("VoiceDirector abort suppresses all subsequent output", () => {
  const chunks = [];
  const director = new VoiceDirector({
    onSpeechChunk: (chunk) => chunks.push(chunk),
  });

  director.pushToken("First thought. ");
  director.abort();
  director.pushToken("Second thought. ");
  director.finish();

  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes("First thought"));
});

test("a run's later steps are spoken as they happen, not saved for the end", () => {
  const chunks = [];
  const director = new VoiceDirector({
    isFreshConversation: false,
    // The real budget: three opening sentences, then hold. See spokenDigest.ts.
    maxStreamedChunks: 3,
    onSpeechChunk: (chunk) => {
      if (chunk) chunks.push(chunk);
    },
  });

  const say = (text) => {
    for (const token of text.split(/(?<=\s)/)) director.pushToken(token);
  };

  // Step one spends the whole opening budget, the way a real preamble does.
  say("Okay. Let me look at the player. I will check what it is showing. ");
  say('```player-tool\n{"action":"status"}\n```\n');
  director.onToolCall({ id: "1", name: "player.status", arguments: {}, status: "running" });
  director.onToolCall({ id: "1", name: "player.status", arguments: {}, status: "completed", result: "paused" });

  const afterOpening = chunks.length;
  assert.equal(afterOpening, 3, "the opening budget is three sentences");

  // Two more steps. Before the per-step budget these were silent, and the
  // operator heard the whole run only once it was over.
  for (const step of [2, 3]) {
    say(`The player is paused, so now I will start step ${step}. `);
    say('```player-tool\n{"action":"play"}\n```\n');
    director.onToolCall({ id: `${step}`, name: "player.play", arguments: {}, status: "running" });
    director.onToolCall({ id: `${step}`, name: "player.play", arguments: {}, status: "completed", result: "playing" });
  }

  assert.equal(chunks.length, afterOpening + 2, "each later step is spoken while it runs");
  assert.ok(chunks[3].includes("step 2"), "step two is announced during step two");
  assert.ok(chunks[4].includes("step 3"), "step three is announced during step three");
  assert.ok(!chunks.some((chunk) => chunk.includes("action")), "the fence body is never spoken");
});

test("a step drops the previous step's unspoken tail rather than narrating behind the run", () => {
  const chunks = [];
  const director = new VoiceDirector({
    isFreshConversation: false,
    maxStreamedChunks: 1,
    onSpeechChunk: (chunk) => {
      if (chunk) chunks.push(chunk);
    },
  });

  const say = (text) => {
    for (const token of text.split(/(?<=\s)/)) director.pushToken(token);
  };

  say("Checking the player. This trailing thought is stale by the time it could be read. ");
  director.onToolCall({ id: "1", name: "player.status", arguments: {}, status: "completed" });
  say("It is paused, so I am resuming it. ");

  assert.ok(chunks.some((chunk) => chunk.includes("Checking the player")), "the step's first sentence is spoken");
  assert.ok(chunks.some((chunk) => chunk.includes("resuming it")), "the next step is spoken");
  assert.ok(!chunks.some((chunk) => chunk.includes("stale")), "the superseded tail is dropped, not queued");
});

test("a step is opened once, however many times a tool call is reported", () => {
  const chunks = [];
  const director = new VoiceDirector({
    isFreshConversation: false,
    maxStreamedChunks: 1,
    onSpeechChunk: (chunk) => {
      if (chunk) chunks.push(chunk);
    },
  });

  const say = (text) => {
    for (const token of text.split(/(?<=\s)/)) director.pushToken(token);
  };

  say("First sentence. Second sentence. ");
  assert.equal(chunks.length, 1, "the budget of one is spent");

  // The same call arriving twice — a re-render, or an error after a result —
  // must not hand the run a second budget for the same step.
  director.onToolCall({ id: "1", name: "player.play", arguments: {}, status: "completed" });
  director.onToolCall({ id: "1", name: "player.play", arguments: {}, status: "error" });
  say("Third sentence. Fourth sentence. ");

  assert.equal(chunks.length, 2, "one completed step buys exactly one fresh budget");
});
