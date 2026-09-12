/**
 * Delegation: the sentence leaves her mouth, and something has to actually run.
 *
 * "One AI talks, one AI works" is the product. This file pins the seam between
 * them — `voiceTurnRouter` deciding what an utterance is, and
 * `teminaliAgentBridge` being the only thing in the app that can act on it.
 * Every case below was measured failing, and every one of them failed the same
 * way from the operator's chair: Temi said the work was happening, and it was
 * not.
 *
 *   "use Frontier Max"                 she said she had switched. Nothing had.
 *   "have Codex look at this file"     ran on Frontier; the name was discarded.
 *   "ask Claude Code to run the tests" died on its first permission prompt,
 *                                      denied in under a millisecond, silently.
 *   "open package.json" mid-run        queued without a word, opened minutes on.
 *   "stop, cancel that"                "Stopped." then "encountered an issue".
 *   "now run the tests"                a cold session that had never heard the
 *                                      sentence before it.
 *   "what did it change"               started a second run to find out what
 *                                      the first one did.
 *
 * The parse is pure and is tested as a function. The threading is not — the
 * bridge reaches four stores and the CLI transport, and importing it under
 * `node --test` would pull the whole renderer in — so it is asserted over the
 * source, the way `composer-menu` and `inspect-answer` already do. Each of
 * those says which run-time failure the assertion stands in for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ENGINE_LABELS,
  describeEngineSwitch,
  isRunRecallQuestion,
  parseEngineChoice,
  routeVoiceTurn,
} from "../src/services/voice/voiceTurnRouter.ts";
import { parseWorkspaceTags } from "../src/services/voice/workspaceActions.ts";

const readSource = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

const bridge = await readSource("../src/services/voice/teminaliAgentBridge.ts");
const ai = await readSource("../src/services/aiService.ts");
const cli = await readSource("../src/services/agentCliService.ts");

const NOW = 1_700_000_000_000;
const idle = (text) => routeVoiceTurn(text, { busy: false, speaking: false, run: null, now: NOW });

/* ─────────────────────────────────────────────────────────────────────────────
   WHICH ASSISTANT. "have Codex look at this file" ran on Frontier.

   The engine came from the picker and the name in the sentence was thrown
   away, so the operator asked one assistant for something and another one did
   it — with nothing on screen to say so but a log line naming the wrong CLI.
   ───────────────────────────────────────────────────────────────────────── */

const NAMED = [
  { say: "ask Claude Code to run the tests", engine: "claude" },
  { say: "have Codex look at this file", engine: "codex" },
  { say: "get Claude to check the diff", engine: "claude" },
  { say: "Codex, look at this file", engine: "codex" },
  { say: "fix the failing test with Claude Code", engine: "claude" },
  { say: "use Codex to rename that function", engine: "codex" },
  { say: "run it on Frontier Max", engine: "gemini" },
  { say: "tell cloud code to open the router", engine: "claude" },
  { say: "ask code x to build it", engine: "codex" },
];

for (const { say, engine } of NAMED) {
  test(`ENGINE: "${say}" reaches ${engine}`, () => {
    const choice = parseEngineChoice(say);
    assert.ok(choice, `no engine was read out of "${say}", so the picker decides and the named assistant never sees it`);
    assert.equal(
      choice.engine,
      engine,
      `the work would run on ${choice.engine} after he asked for ${engine} by name`,
    );
  });
}

test("the spoken names are the ones the app actually has", () => {
  // Read from `CodingEngine` in store/assistantActivityStore.ts, which is what
  // the bridge asks when it picks an engine. A fifth value here would be a
  // name nothing can honour.
  assert.deepEqual(Object.keys(ENGINE_LABELS).sort(), ["claude", "codex", "frontier", "gemini"]);
  assert.equal(ENGINE_LABELS.claude, "Claude Code");
  assert.equal(ENGINE_LABELS.codex, "Codex");
  assert.equal(ENGINE_LABELS.gemini, "Frontier Max");
});

test("Flash and Auto are confirmed as Frontier, because the lane has one local mode", () => {
  /*
    `runTask` sends "auto" as the mode for every engine that is not Gemini, so
    asking for Flash and asking for Auto land in exactly the same place.
    Answering "Frontier Flash is on it" would be the same fabrication as the
    engine switch that never happened — a claim about a tier nothing selected.
  */
  assert.equal(parseEngineChoice("use Frontier Flash").engine, "frontier");
  assert.equal(parseEngineChoice("switch to Frontier Auto").engine, "frontier");
  assert.equal(parseEngineChoice("use Frontier Flash").label, "Frontier");
  assert.equal(ENGINE_LABELS.frontier, "Frontier");
});

/* ─────────────────────────────────────────────────────────────────────────────
   A CHOICE OF ENGINE IS NOT A JOB.

   "Use Frontier Max" reached the persona, which answered in character: it said
   it had switched, and nothing had. That is the fabrication this intent exists
   to kill, and it is worse than silence — the operator believes the next run
   is somewhere it is not.
   ───────────────────────────────────────────────────────────────────────── */

const SWITCH_ONLY = [
  "use Frontier Max",
  "switch to Claude Code",
  "switch over to Codex please",
  "use Codex from now on",
  "go back to Frontier",
  "frontier max",
  "put it on Codex",
  "change to Claude Code",
  "use gemini",
];

for (const say of SWITCH_ONLY) {
  test(`SWITCH: "${say}" changes the engine instead of starting a run`, () => {
    const choice = parseEngineChoice(say);
    assert.ok(choice, `"${say}" named no engine at all, so it went to the persona to be answered in character`);
    assert.equal(
      choice.switchOnly,
      true,
      `"${say}" was read as a job for ${choice.label}; an agent run starts and the operator never gets the switch`,
    );
  });
}

test("a job that names an engine is still a job", () => {
  // The costly direction. Reading "use Claude Code to run it" as a bare switch
  // would confirm the engine and silently drop the work.
  for (const say of [
    "use Claude Code to run it",
    "ask Claude Code to run the tests",
    "have Codex look at this file",
    "Codex, look at this file",
    "fix the bug with Claude Code",
  ]) {
    assert.equal(
      parseEngineChoice(say).switchOnly,
      false,
      `"${say}" would be answered with a confirmation and the work would never run`,
    );
  }
});

test("ordinary talk never chooses an engine", () => {
  /*
    The cost of a false match here is the whole session moving to another
    assistant because of a word in a sentence about something else. This shell
    is a video editor too, which is why no bare "flash", "max" or "cloud" is a
    name.
  */
  for (const say of [
    "that song is a banger",
    "my terminal job is stressful and I might quit",
    "use the flash effect on that clip",
    "mute the video",
    "I want to test how good you can sing. Can you sing?",
    "The last agent I used would just delete files without asking.",
    "what a release that was, I slept for ten hours",
    "max out the volume on that track",
  ]) {
    assert.equal(parseEngineChoice(say), null, `"${say}" was read as a choice of assistant`);
  }
});

test('"use Frontier Max" no longer goes to the persona', () => {
  // Measured: classified `converse`, answered in character, "I've switched to
  // Frontier Max" — said by the one part of the system that cannot switch
  // anything.
  const decision = idle("use Frontier Max");
  assert.notEqual(decision.action.kind, "converse", "the persona would answer it, and answering it is inventing it");
  assert.equal(decision.action.kind, "delegate", "it must reach the bridge, which is the half that can write the store");
});

test("nothing is said until the switch has actually happened", () => {
  /*
    `speak` is null on purpose: the confirmation comes from the bridge, after
    the store write, built from what the store then says. A line spoken here
    would be spoken before anything changed — which is precisely the bug.
  */
  assert.equal(idle("use Frontier Max").speak, null);
  assert.match(bridge, /const landed = useAssistantActivityStore\.getState\(\)\.activeEngine;/);
  assert.ok(
    bridge.indexOf("activityStore.setActiveEngine(choice.engine);") <
      bridge.indexOf("const line = describeEngineSwitch(ENGINE_LABELS[landed], busy);"),
    "the store must be written before the sentence about it is built",
  );
});

test("a switch mid-run does not claim the running job moved", () => {
  // It cannot: the turn in flight was started by another CLI and there is no
  // handover. Saying otherwise would be a second fabrication inside the fix
  // for the first.
  const busy = describeEngineSwitch("Claude Code", true);
  assert.match(busy, /next/i);
  assert.doesNotMatch(describeEngineSwitch("Claude Code", false), /next one/i);
});

test("the bridge writes the engine the operator named, not the picker's", () => {
  // `setActiveEngine` is the store the bridge itself reads on the next run, so
  // this is the switch, not a note about it.
  assert.match(bridge, /activityStore\.setActiveEngine\(choice\.engine\)/);
  assert.match(
    bridge,
    /const named = parseEngineChoice\(prompt\);[\s\S]{0,400}?named\?\.engine \|\|/,
    "the name in the sentence must outrank the picker, or Codex work runs on Frontier",
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
   PERMISSION. "ask Claude Code to run the tests" died in a millisecond.

   `aiService` denies every CLI permission event when no gate is passed, and
   the bridge passed none — so the first tool call the CLI asked about was
   refused before the operator could hear the question, and the run ended
   having done nothing.
   ───────────────────────────────────────────────────────────────────────── */

test("the delegate options carry an approval gate", () => {
  // CONTRACT: the field is named `approveCommand` and is optional, so the
  // voice stage can pass its own spoken gate without this file knowing about
  // the stage.
  assert.match(
    bridge,
    /approveCommand\?: \(request: AgentCommandRequest\) => Promise<boolean>;/,
    "without the field the stage cannot hand its gate over and every permission event is denied",
  );
});

test("the gate reaches the stream, and is defaulted rather than skipped", () => {
  assert.match(
    bridge,
    /approveCommand: options\.approveCommand \?\? this\.voiceApprovalGate\(/,
    "an absent gate means `approved = false` in aiService — a refusal the operator never hears",
  );
  // And `aiService` is still the thing that would deny, so the default is not
  // decoration.
  assert.match(ai, /const approved = approve\s*\?[\s\S]{0,400}?: false;/);
});

test("the spoken question goes where the spoken answer is listened for", () => {
  // `hooks/useSpokenApproval` reads whatever is in `store/approvalStore` aloud
  // and settles it from a spoken "yes". The voice lane has no buttons, so this
  // store is the only door it has.
  assert.match(bridge, /import \{ useApprovalStore \} from "\.\.\/\.\.\/store\/approvalStore";/);
  assert.match(bridge, /store\.offer\(\{[\s\S]{0,400}?source: "agent"/);
  assert.match(
    bridge,
    /alwaysLabel: null/,
    'offering "always" would promise a memory nothing here keeps — the gateway answer carries remember: false',
  );
});

test("a question nobody answers refuses, rather than hanging", () => {
  // A promise that never settles leaves the CLI blocked inside its tool call
  // for the gateway's full five minutes, which is the failure this replaced.
  assert.match(bridge, /const APPROVAL_WAIT_MS = 180_000;/);
  assert.match(bridge, /setTimeout\(\(\) => settle\(false, "Refused — nobody answered"\), APPROVAL_WAIT_MS\)/);
});

test("a stop settles the standing question instead of abandoning it", () => {
  // Otherwise the CLI stays blocked on an answer that can no longer arrive,
  // and a later "yes" answers for a process that is already gone.
  assert.match(
    bridge,
    /static stopCurrentTask\(\) \{[\s\S]{0,400}?this\.pendingApproval\?\.settle\(false\);/,
  );
  assert.ok(
    bridge.indexOf("this.pendingApproval?.settle(false);\n    this.activeController?.abort();") > -1,
    "release the CLI before the abort, or it waits on a run that has already ended",
  );
});

test('"yes, go ahead" answers the prompt instead of starting a second run', () => {
  /*
    The stage's `useSpokenApproval` consumes an approval answer before routing,
    when it is mounted and listening. This is the net under it, and the reason
    one is needed: "run it" and "yes run it" both classify as `shell`, so a
    missed consume turns the answer to a permission prompt into another agent
    run while the first one stays blocked.
  */
  assert.equal(idle("run it").action.kind, "delegate", "the corpus this net exists for");
  assert.match(
    bridge,
    /const verdict = classifyApprovalReply\(clean\);[\s\S]{0,200}?pending\.settle\(verdict !== "deny"\)/,
  );
  assert.ok(
    bridge.indexOf("const pending = this.pendingApproval;") < bridge.indexOf("const choice = parseEngineChoice(clean);"),
    "the standing question is asked about first: it is the one thing blocking a live run",
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
   THE QUEUE. "open package.json" mid-run was accepted in silence.

   Temi had already said "On it."; the file opened minutes later, when the run
   in front of it finished. The folder path refused out loud — files did not.
   ───────────────────────────────────────────────────────────────────────── */

test("a queued prompt is spoken, not only shown", () => {
  assert.match(
    bridge,
    /const waiting = describeQueue\(this\.queue\.length\);[\s\S]{0,500}?options\.onCompleted\?\.\(waiting\)/,
    "`onCompleted` is what speaks; a toast is on a screen the operator is not looking at, which is why they asked out loud",
  );
});

test("a refused prompt is still spoken too", () => {
  // The neighbouring path, unchanged — asserted so the queue fix cannot be
  // written by moving this one.
  assert.match(bridge, /const refusal = describeRejection\(result\.reason\);[\s\S]{0,700}?options\.onCompleted\?\.\(refusal\)/);
});

/* ─────────────────────────────────────────────────────────────────────────────
   STOPPING. "stop, cancel that" then "the background assistant encountered an
   issue" — the operator got what they asked for and was told it went wrong.
   ───────────────────────────────────────────────────────────────────────── */

test("a cancellation is not reported as a failure", () => {
  assert.match(bridge, /const aborted =\s*\n\s*controller\.signal\.aborted \|\|/);
  assert.ok(
    bridge.indexOf("if (aborted) {") <
      bridge.indexOf("options.onCompleted?.(`The background assistant encountered an issue"),
    "the abort has to be recognised before the error line is built, or it is spoken anyway",
  );
  assert.match(bridge, /return CANCELLED_NOTE;/);
});

test("a cancelled run says nothing, because 'Stopped.' was already said", () => {
  // `STOP_ACKNOWLEDGEMENT` goes out the moment the stop is routed. A second
  // sentence about a single event is how the two-voices bug sounded.
  const cancelBlock = bridge.slice(bridge.indexOf("if (aborted) {"), bridge.indexOf("return CANCELLED_NOTE;"));
  assert.doesNotMatch(cancelBlock, /onCompleted/, "nothing further may be spoken about a stop the operator asked for");
  assert.match(cancelBlock, /status: "success"/, "and the activity row must not read as a failure either");
});

/* ─────────────────────────────────────────────────────────────────────────────
   MEMORY. "now run the tests", one sentence after "fix the failing test".

   Both CLIs are processes that resume by id. The voice lane passed none, so
   every spoken sentence opened a session that had never heard the one before
   it, and the operator had to say the whole thing again.
   ───────────────────────────────────────────────────────────────────────── */

test("a spoken conversation is one CLI session, not a series of strangers", () => {
  assert.match(bridge, /agentSessionId: resumeSessionId,/);
  assert.match(
    bridge,
    /onAgentSession: \(sessionId\) => \{[\s\S]{0,200}?this\.sessions\.set\(/,
    "the id the CLI reports has to be kept, or the next turn is cold again",
  );
  assert.match(ai, /sessionId: options\.agentSessionId \?\? null,/, "and aiService is what passes it to the CLI");
});

test("a session is not resumed into a workspace it never ran in", () => {
  // A teminaliCut thread resumed inside teminaliCode hands the CLI a history
  // of files that are not there.
  assert.match(bridge, /remembered\.workspace === workspace \? remembered\.id : null/);
});

/* ─────────────────────────────────────────────────────────────────────────────
   RECALL. "what did it change", asked once the run has ended.

   `turnIntent` sees an idle session and calls everything an instruction, so a
   question *about* the work became more work: a second agent run, started to
   discover what the first one had already reported.
   ───────────────────────────────────────────────────────────────────────── */

const RECALL = [
  "what did it change",
  "what did it do",
  "what files did it touch",
  "what just happened",
  "how did it go",
  "did it work",
  "tell me what it did",
];

for (const say of RECALL) {
  test(`RECALL: "${say}" is a question about the last run`, () => {
    assert.equal(isRunRecallQuestion(say), true, `"${say}" would start a fresh run to answer itself`);
  });
}

test("a question about the world is not a question about the run", () => {
  // The other direction: swallowing these into a stale run report would answer
  // the wrong question with total confidence.
  for (const say of [
    "what's the capital of France",
    "what did I have for lunch",
    "what do you think of the name Temi",
    "change the readme",
  ]) {
    assert.equal(isRunRecallQuestion(say), false, `"${say}" would be answered from a run report instead`);
  }
});

test("the report of the run that just finished is kept, and answered from", () => {
  assert.match(bridge, /this\.lastReport = \{ text: completionSummary, finishedAt: Date\.now\(\) \};/);
  assert.match(
    bridge,
    /isRunRecallQuestion\(clean\) &&\s*\n\s*Date\.now\(\) - report\.finishedAt < REPORT_RECALL_MS/,
    "and only while it is still the answer — an hour later the honest reply is to go and look",
  );
  assert.match(bridge, /!this\.activeController &&/, "a live run answers from the digest instead; this is the post-run case");
});

/* ─────────────────────────────────────────────────────────────────────────────
   HANDED OVER FROM AGENT F. Three fixes whose other halves already landed.
   ───────────────────────────────────────────────────────────────────────── */

test('"close that file" closes a tab instead of being dropped', () => {
  /*
    The bridge's `onWorkspace` chain ended at `open-project`, so the event
    arrived and nothing happened while Temi confirmed the close — the same
    class of lie as the engine switch that never switched.
  */
  assert.match(bridge, /else if \(event\.action === "close-file"\) \{/);
  assert.match(bridge, /live\.closeTab\(tab\.id\)/, "closeTab takes a tab id; a path closes nothing");
  assert.match(
    bridge,
    /const live = useStudioStore\.getState\(\);/,
    "read fresh: the `store` snapshot this run opened with has a minutes-old tab list",
  );
  assert.match(bridge, /if \(scope === "all"\)/, "and 'close all the tabs' means all of them");
});

test("the CLI lane knows the close event exists", () => {
  // It typechecked only because `frontierEngine`'s onWorkspace is `(event:
  // any)`, which is how two panes ended up with no branch for it at all.
  assert.match(cli, /\| \{ type: "workspace"; action: "close-file"; scope: "active" \| "all" \| "path"; path\?: string \}/);
});

test("every workspace action a CLI turn emits is executed, not just the first", () => {
  /*
    `text.match(...)` without /g returns one match, so "open the readme and
    then open package.json" ran the first tag and dropped the rest without a
    word. The old pattern also demanded a `path` attribute, which a
    `close-file scope="all"` tag does not carry — so that one could never match
    at all.
  */
  assert.match(cli, /for \(const tag of parseWorkspaceTags\(text\)\)/);
  assert.doesNotMatch(cli, /text\.match\(\/<workspace-action/, "a non-global match runs one action and loses the rest");

  const tags = parseWorkspaceTags(
    'ok <workspace-action action="open-file" path="README.md" /> and ' +
      '<workspace-action action="open-file" path="package.json" /> then ' +
      '<workspace-action action="close-file" scope="all" />',
  );
  assert.equal(tags.length, 3, "all three were asked for out loud");
  assert.equal(tags[2].scope, "all", "and the scope-only tag has no path for the old pattern to match on");
});

test('"open the file I was just editing" is told which files are open', () => {
  // Without this the model holds nothing but the workspace root, guesses a
  // path, and the operator hears a confirmation for a file that never opened.
  assert.match(ai, /openEditors: \(\) => \{/);
  assert.match(ai, /activePath: tabs\.find\(\(tab\) => tab\.id === activeTabId\)\?\.path \?\? null,/);
  assert.match(ai, /openPaths: tabs\.map\(\(tab\) => tab\.path\),/);
});

/* ─────────────────────────────────────────────────────────────────────────────
   The corpora may not overlap: a sentence that is both a switch and a job
   would make one of the two tests above pass for free.
   ───────────────────────────────────────────────────────────────────────── */

test("no sentence is both a switch and a job", () => {
  const jobs = new Set(NAMED.map(({ say }) => say.toLowerCase()));
  const overlap = SWITCH_ONLY.filter((say) => jobs.has(say.toLowerCase()));
  assert.deepEqual(overlap, [], `these are in both corpora: ${overlap.join(" / ")}`);
});
