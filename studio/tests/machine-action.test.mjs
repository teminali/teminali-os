import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMachineAction,
  isMachineAction,
  acknowledgeAction,
} from "../src/services/voice/machineAction.ts";

/**
 * The capabilities the operator named, in the words they would actually be
 * spoken in. Every one of these was routed to the persona LLM by the old gate
 * — three of them because they are four words or shorter — and answered with
 * an invented account of having been done.
 */
const ACTIONS = [
  ["play that video", "media"],
  ["play it", "media"],
  ["pause the video", "media"],
  ["skip forward in the clip", "media"],
  ["mute it", "media"],
  ["change workspace to teminaliCut", "workspace"],
  ["switch to the landing project", "workspace"],
  ["move over to the repo", "workspace"],
  ["open my downloads folder", "open"],
  ["open the config file", "open"],
  ["show me the readme", "open"],
  ["pull up that component", "open"],
  ["close this tab", "open"],
  ["create a folder called notes", "edit"],
  ["make a new folder", "edit"],
  ["create a file named server dot js", "edit"],
  ["edit that file", "edit"],
  ["rename this file", "edit"],
  ["delete the log files", "edit"],
  ["add a function to that component", "edit"],
  ["run the tests", "shell"],
  ["build the app", "shell"],
  ["install the package", "shell"],
  ["start the server", "shell"],
  ["check the logs", "inspect"],
  ["search the code for that function", "inspect"],
  ["read that file", "inspect"],
];

for (const [utterance, kind] of ACTIONS) {
  test(`"${utterance}" is work for the hands (${kind})`, () => {
    const action = classifyMachineAction(utterance);
    assert.ok(action, `"${utterance}" was routed to the persona, which has no hands`);
    assert.equal(action.kind, kind, action.reason);
  });
}

/** Conversation. Every one of these must stay with Temi. */
const CONVERSATION = [
  "what do you make of the weather today",
  "what do you think about that",
  "how are you doing",
  "how do you feel about mondays",
  "tell me a joke",
  "tell me about yourself",
  "why did you say that",
  "what's your take on the meeting",
  "do you remember what I said earlier",
  "good morning",
  "thanks, that was helpful",
  "I am driving into the city tonight",
  "what would you do in my position",
];

for (const utterance of CONVERSATION) {
  test(`"${utterance}" stays with Temi`, () => {
    const action = classifyMachineAction(utterance);
    assert.equal(action, null, action ? `wrongly delegated as ${action.kind}: ${action.reason}` : "");
  });
}

test("the four-word rule is gone — short imperatives are the normal spoken form", () => {
  for (const short of ["play it", "open that", "run the tests", "pause it"]) {
    assert.ok(isMachineAction(short), `"${short}" is four words or fewer and must still be work`);
  }
});

test("a polite instruction is an instruction, question mark and all", () => {
  for (const polite of [
    "can you open the config file?",
    "could you please play that video?",
    "would you run the tests for me?",
    "I need you to create a folder called notes",
    "hey Temi, open my downloads folder",
  ]) {
    assert.ok(isMachineAction(polite), `"${polite}" was rejected for its punctuation`);
  }
});

test("'what do you make of this error' is an opinion, not a build", () => {
  // The exact false positive the old keyword gate produced: it matched *make*
  // and handed a conversational question to a coding assistant.
  assert.equal(classifyMachineAction("what do you make of this error"), null);
});

test("an opinion frame outranks every action verb inside it", () => {
  assert.equal(classifyMachineAction("what do you think about running the tests"), null);
  assert.equal(classifyMachineAction("do you think I should delete that file"), null);
});

test("an imperative with nothing of the machine's in range is conversation", () => {
  for (const human of ["run along", "open up to me", "make me laugh", "show me some warmth"]) {
    assert.equal(classifyMachineAction(human), null, `"${human}" is not machine work`);
  }
});

test("playback outranks the generic open verb", () => {
  // "play the video" contains no `open`-family verb, but "pull up that clip
  // and play it" contains both. Media is the operator's actual intent.
  assert.equal(classifyMachineAction("play the video")?.kind, "media");
});

test("empty and whitespace transcripts are not actions", () => {
  assert.equal(classifyMachineAction(""), null);
  assert.equal(classifyMachineAction("   "), null);
  assert.equal(classifyMachineAction(null), null);
  assert.equal(classifyMachineAction(undefined), null);
});

test("a bare politeness wrapper with no instruction left is not an action", () => {
  assert.equal(classifyMachineAction("can you"), null);
  assert.equal(classifyMachineAction("please"), null);
});

test("every action kind has an acknowledgement, and it is speakable", () => {
  for (const kind of ["media", "workspace", "open", "edit", "shell", "inspect"]) {
    for (let seed = 0; seed < 5; seed++) {
      const line = acknowledgeAction(kind, seed);
      assert.ok(line.length > 0, `${kind} seed ${seed} said nothing`);
      assert.ok(line.length < 40, `${kind}: "${line}" is too long to say before work starts`);
      assert.ok(!/[*_`#|]/.test(line), `${kind}: "${line}" contains markup`);
      // Never claim completion. The work has not started yet.
      assert.ok(
        !/\b(done|finished|complete|completed|opened|played|created|ran)\b/i.test(line),
        `${kind}: "${line}" claims the work is already done`
      );
    }
  }
});

test("acknowledgements vary, so a working session is not one sentence on a loop", () => {
  const seen = new Set([0, 1, 2].map((seed) => acknowledgeAction("open", seed)));
  assert.ok(seen.size > 1, "every seed produced the same line");
});

test("acknowledgement selection is pure and total for any seed", () => {
  assert.equal(acknowledgeAction("media", 0), acknowledgeAction("media", 0));
  assert.equal(typeof acknowledgeAction("media", -7), "string");
  assert.equal(typeof acknowledgeAction("media", 1.9e9), "string");
});

/**
 * State questions — measured, not imagined.
 *
 * Each row on the left was put to qwen3:8b (the model `server.py` runs) three
 * times on 2026-09-09 with the persona prompt and no gate in front of it. The
 * comment is what came back, every time. None of it was true; none of it could
 * have been. A voice with no eyes answers a question about the machine by
 * inventing a plausible machine.
 */
const STATE_QUESTIONS = [
  ["is the server running", "inspect"],          // "The server is running." ×3
  ["did the build finish", "inspect"],           // "The build is complete." ×3
  ["which port does the config use", "inspect"], // "the default port is 8080" ×3
  ["how many tests are passing right now", "inspect"],
  ["what is in my downloads folder", "inspect"],
  ["what file am I looking at", "inspect"],
  ["have you fixed the login bug yet", "inspect"],
  ["are the tests passing", "inspect"],
  ["is it still running", "inspect"],
  ["has the deploy finished", "inspect"],
  ["what branch am I on", "inspect"],
  ["did that change land", "inspect"],
];

for (const [utterance, kind] of STATE_QUESTIONS) {
  test(`"${utterance}" is a look, not a conversation`, () => {
    const action = classifyMachineAction(utterance);
    assert.ok(action, `"${utterance}" went to the persona, which cannot know the answer`);
    assert.equal(action.kind, kind, action.reason);
  });
}

test("a state question is a look even when it contains a doing verb", () => {
  // "did the build finish" must not be read as an instruction to build.
  assert.equal(classifyMachineAction("did the build finish").kind, "inspect");
  assert.equal(classifyMachineAction("did the deploy work").kind, "inspect");
  // The imperative is still an imperative.
  assert.equal(classifyMachineAction("build the project").kind, "shell");
  assert.equal(classifyMachineAction("run the tests").kind, "shell");
});

test("questions with no machine in them are still conversation", () => {
  for (const line of [
    "how are you",
    "are you always this direct with people",
    "is it raining outside",
    "did you sleep well",
    "what do you make of this error",
    "do you remember what I said",
    "why do we build things if everything eventually dies",
  ]) {
    assert.equal(classifyMachineAction(line), null, `"${line}" was delegated`);
  }
});

/**
 * §6.30, finding 1 — the same question, worn differently.
 *
 * The state gate was written against the shortest form of each question and
 * measured there, so it looked closed. The conversation eval asked "what is
 * *the* port the server runs on" and got "The port is 8080" — the invention
 * §6.0.4 had already closed for "which port". Nobody tells the operator which
 * wording is the safe one, so a gate that holds for one of them holds for none.
 *
 * Each row is a phrasing the old patterns walked past. They are here as a set
 * rather than as one regression case because the defect was never the port: it
 * was the assumption that a wh-word sits against its noun.
 */
const REPHRASED_STATE_QUESTIONS = [
  "what is the port the server runs on",
  "what's the port the server uses",
  "what is the branch I am on",
  "what's the version of the package",
  "what is the model the app uses",
  "what is the command the script runs",
  "which is the file you changed",
  "what's the config",
  "what was the last commit",
  "what is the current branch",
  "which is the main config",
];

for (const utterance of REPHRASED_STATE_QUESTIONS) {
  test(`"${utterance}" is a look, whatever sits between the wh-word and the noun`, () => {
    const action = classifyMachineAction(utterance);
    assert.ok(action, `"${utterance}" went to the persona, which cannot know the answer`);
    assert.equal(action.kind, "inspect", action.reason);
  });
}

test("a bare state question reaches the gate now that its noun is also an object", () => {
  // Both halves have to agree — a state pattern and a machine object — so
  // `port`, `version` and `model` being state nouns but not objects meant
  // these could never arrive however the state patterns were phrased.
  for (const line of ["what's the port", "which version is it", "what model is this"]) {
    const action = classifyMachineAction(line);
    assert.ok(action, `"${line}" went to the persona`);
    assert.equal(action.kind, "inspect", action.reason);
  }
});

test("a definite article is a state question; an indefinite one is a definition", () => {
  // "what is the branch" asks this machine. "what is a branch" asks the world,
  // and the voice may answer it — sending it to the hands wastes a look and
  // answers a question nobody asked.
  assert.equal(classifyMachineAction("what is the branch").kind, "inspect");
  assert.equal(classifyMachineAction("what is a branch"), null);
  assert.equal(classifyMachineAction("what is a file anyway"), null);
});

test("widening the state patterns did not widen them into small talk", () => {
  for (const line of [
    "what is your name",
    "what's the weather",
    "what is the point",
    "what do you think of the model",
    "what would you do about that",
    // The adjective slot is closed for this one: "best" is taste, not state,
    // and the hands cannot settle it by looking.
    "what is the best model",
    "what is the fastest model",
  ]) {
    assert.equal(classifyMachineAction(line), null, `"${line}" was delegated`);
  }
});
