/**
 * The two ways the switch between the voice and the hands betrays the operator.
 *
 * `routeVoiceTurn` decides, on every finished transcript, whether Temi answers
 * it herself or hands it to the Teminali OS assistant, which can read and edit
 * files in the operator's workspace. The gate it asks is
 * `classifyMachineAction`. This file is the corpus that pins both directions of
 * that decision, in sentences a person would actually say out loud.
 *
 * ── CORPUS A is a SAFETY corpus ────────────────────────────────────────────
 *
 * Every sentence in it is the operator TALKING TO HER. A regression here means
 * the voice launched an agent against his workspace while he was only having a
 * conversation: a background run he did not ask for, touching files he did not
 * name, and an "On it." over the top of a question he wanted answered.
 *
 * It is not hypothetical. Measured 2026-09-12, spoken aloud:
 *
 *   "I want to test how good you can sing. Can you sing?"
 *       classified `shell`, and an agent run started. `test` is a verb in the
 *       run group AND a noun in `MACHINE_NOUNS`, so the verb satisfied its own
 *       object requirement.
 *
 *   "Okay, um, I didn't tell you to work on the handover uh or anything to do
 *    with a terminal code. Uh, just want to make a conversation with you..."
 *       classified `edit`, because "terminal" (out of "a terminal code")
 *       licensed "make" three clauses away. The operator's sentence saying
 *       *do not do work* was itself read as work.
 *
 * Both come from the same hole: `hasObjectFor` tested `MACHINE_NOUNS` against
 * the WHOLE sentence, so any machine-ish noun anywhere licensed any verb
 * anywhere, in either order, across any distance.
 *
 * ── CORPUS B is a CAPABILITY corpus ────────────────────────────────────────
 *
 * Every sentence in it is the operator ASKING FOR WORK. A regression here means
 * his instructions stopped reaching the hands, and that failure is not quiet:
 * the persona LLM has no hands and a prompt that never admits it, so it answers
 * in character and describes work that never happened. It once described a file
 * it had never read. Under-delegation costs trust; over-delegation costs a
 * moment. Neither is free, which is why both halves are here.
 *
 * The corpora are written from what SHOULD happen, not from what the current
 * gate does. A failure here is information, not a case to soften.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyMachineAction } from "../src/services/voice/machineAction.ts";
import { routeVoiceTurn } from "../src/services/voice/voiceTurnRouter.ts";

const NOW = 1_700_000_000_000;

/** Nothing running. The state the operator is in for most of a day. */
function idle(text) {
  return routeVoiceTurn(text, { busy: false, speaking: false, run: null, now: NOW });
}

/** An agent is already working. A delegation here is a *second* run. */
function during(text) {
  return routeVoiceTurn(text, {
    busy: true,
    speaking: false,
    run: {
      startedAt: NOW - 40_000,
      engine: "claude",
      toolCalls: [
        {
          id: "1",
          name: "Edit",
          arguments: { file_path: "studio/src/services/voice/machineAction.ts" },
          status: "completed",
        },
      ],
      lastText: "",
    },
    now: NOW,
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   CORPUS A. MUST NOT DELEGATE.

   A regression on any line below means the voice ran an agent against the
   operator's workspace when he was talking to it.
   ───────────────────────────────────────────────────────────────────────── */

const MUST_NOT_DELEGATE = [
  // ── Aimed at her as a person. The object of the sentence is Temi herself.
  {
    say: "I want to test how good you can sing. Can you sing?",
    why: "he is asking her to perform, not asking for a test to be run",
  },
  {
    say: "Can you sing something for me?",
    why: "there is nothing in the workspace called a song here, only her",
  },
  {
    say: "Sing me the chorus of that song you like.",
    why: "the song is hers to sing, not a file to open",
  },
  {
    say: "Tell me a joke about a project manager.",
    why: "the project manager is the punchline, not a codebase",
  },
  {
    say: "What do you look like in your head?",
    why: "a question about her self-image, which only she can answer",
  },
  {
    say: "How are you holding up today?",
    why: "small talk with a colleague at the start of a day",
  },
  {
    say: "What's your take on the name Temi?",
    why: "an opinion was asked for, and an opinion is the only thing that answers it",
  },
  {
    say: "Do you think I should take the investor call?",
    why: "he wants her judgement, not a look at his calendar",
  },
  {
    say: "Do you ever get lonely when I close the laptop?",
    why: "the laptop is scenery in a question about her, nothing is being closed",
  },

  // ── Ordinary talk that happens to carry a machine noun.
  {
    say: "That song is a banger.",
    why: "he is enjoying music, and no verb was aimed at anything",
  },
  {
    say: "My terminal job is stressful and I might quit.",
    why: "a terminal job is a kind of contract, and quitting it is not a command",
  },
  {
    say: "I had a bug in my coffee this morning.",
    why: "an insect, told as a story, with nothing asked of anyone",
  },
  {
    say: "What a release that was, I slept for ten hours.",
    why: "relief after a hard week, not a version being cut",
  },
  {
    say: "This project of mine is exhausting.",
    why: "he is venting about his life, and a vent is answered by listening",
  },
  {
    say: "My whole build-up to the pitch fell apart.",
    why: "a build-up is a story beat, and nothing here compiles",
  },
  {
    say: "The test results from the doctor came back fine.",
    why: "a hospital test, and treating it as a suite run would be grotesque",
  },
  {
    say: "I need to change my flight before Friday.",
    why: "a travel problem he is thinking out loud about",
  },
  {
    say: "That bug bite on my arm is killing me.",
    why: "nothing here is a defect and nothing here is a process",
  },
  {
    say: "My screen time this week is embarrassing.",
    why: "a confession, and the only sane reply is a human one",
  },

  // ── Negated instructions. The sentence says do not, and that is the point.
  {
    say: "Okay, um, I didn't tell you to work on the handover uh or anything to do with a terminal code. Uh, just want to make a conversation with you...",
    why: "he is explicitly calling off work he never ordered, then asking to talk",
  },
  {
    say: "Don't open anything, I just want to talk.",
    why: "an instruction not to act cannot itself be an instruction to act",
  },
  {
    say: "You don't need to run the tests, I already did.",
    why: "he is telling her the work is unnecessary because it is already done",
  },
  {
    say: "No need to change the file, I sorted it out myself.",
    why: "he is closing a task, and running it now would undo his own fix",
  },
  {
    say: "Stop trying to edit my code, I'm just thinking out loud.",
    why: "he is complaining about exactly this behaviour while it happens",
  },
  {
    say: "I never asked you to build anything.",
    why: "a denial that any instruction was given, read as one",
  },
  {
    say: "Don't run anything without asking me first.",
    why: "a standing rule about permission, not a job",
  },

  // ── Hypothetical and reported speech. Someone else's imperative, or nobody's.
  {
    say: "If I asked you to delete the file, would you actually do it?",
    why: "the deletion is the subject of the question, not a request for one",
  },
  {
    say: "He told me to run the build before the demo, but I forgot.",
    why: "the instruction was given by a third party, in the past, to him",
  },
  {
    say: "Imagine you had to fix this whole thing yourself.",
    why: "an invitation to imagine, which is answered in words",
  },
  {
    say: "Suppose I told you to open the config, would that scare you?",
    why: "he is probing how she feels about a command he is pointedly not giving",
  },
  {
    say: "The last agent I used would just delete files without asking.",
    why: "a story about a previous tool, and acting on it would prove his point",
  },

  // ── Small talk built out of words that are also action verbs.
  {
    say: "Let me think for a second.",
    why: "he is asking for a pause, and the thinking is his",
  },
  {
    say: "Make yourself comfortable, this is going to be a long one.",
    why: "a welcome, addressed to her and nothing else",
  },
  {
    say: "Check this out, I got the deal.",
    why: "he is sharing good news, and there is nothing on disk to check",
  },
  {
    say: "Test me on something, let's see what you remember.",
    why: "he wants to be quizzed, and the thing under test is him",
  },
  {
    say: "Go on, I'm listening.",
    why: "he is inviting her to keep speaking",
  },
  {
    say: "Show me what you've got.",
    why: "a challenge to the voice, with no object in the workspace",
  },
  {
    say: "Run that by me again.",
    why: "he did not follow what she said and wants it re-explained",
  },
  {
    say: "Let's start with the good news.",
    why: "he is ordering the agenda of a conversation",
  },
  {
    say: "Look at you, going all philosophical on me.",
    why: "he is teasing her, and the thing being looked at is her",
  },
];

for (const { say, why } of MUST_NOT_DELEGATE) {
  test(`SAFETY: "${say}" stays in the voice`, () => {
    const decision = idle(say);
    const gate = classifyMachineAction(say);

    if (decision.action.kind === "delegate") {
      assert.fail(
        [
          "the voice launched an agent against the operator's workspace.",
          `    he said:  "${say}"`,
          `    it is talk because: ${why}`,
          `    but it routed: delegate/${decision.action.action}`,
          `    the gate's reason: ${gate ? gate.reason : "(none, the router delegated anyway)"}`,
        ].join("\n"),
      );
    }

    if (gate) {
      assert.fail(
        [
          "the gate called conversation work. The router happened to catch it,",
          "    so no agent ran, but the classification is one refactor away from doing so.",
          `    he said:  "${say}"`,
          `    it is talk because: ${why}`,
          `    the gate said: ${gate.kind} because ${gate.reason}`,
          `    the router rescued it as: ${decision.action.kind}`,
        ].join("\n"),
      );
    }
  });
}

/**
 * The same corpus with an agent already running.
 *
 * Reported as one test with the whole list, because the interesting number
 * here is how many, not which one first: mid-run, a delegation is a *second*
 * agent on the same workspace, and several of these route to `status` or
 * `explain` instead, which is a correct and different answer.
 */
test("SAFETY, mid-run: no conversational turn starts a second agent", () => {
  const offenders = MUST_NOT_DELEGATE
    .map(({ say, why }) => ({ say, why, decision: during(say) }))
    .filter(({ decision }) => decision.action.kind === "delegate")
    .map(({ say, why, decision }) => `    "${say}"\n      -> delegate/${decision.action.action}; it is talk because ${why}`);

  assert.equal(
    offenders.length,
    0,
    `${offenders.length} conversational turns started a second agent while one was already working:\n${offenders.join("\n")}`,
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
   CORPUS B. MUST DELEGATE.

   A regression on any line below means his instruction stopped reaching the
   hands, and the persona answered it from nothing.

   Routed idle only, deliberately. Mid-run, several of these are correctly
   answered from the run digest instead ("is the build passing" becomes a
   status answer), and asserting `delegate` there would be asserting the wrong
   thing.
   ───────────────────────────────────────────────────────────────────────── */

const MUST_DELEGATE = [
  // ── Looking at what exists. The cheapest thing the hands can do.
  {
    say: "Open the voice router and tell me what it does.",
    why: "she cannot describe a file she has never read, and she will try",
    kind: "open",
  },
  {
    say: "Show me the config file.",
    why: "a named file he wants on screen",
    kind: "open",
  },
  {
    say: "What's in package dot json?",
    why: "the contents of a real file, which only a read can answer",
    kind: "inspect",
  },
  {
    say: "Read me the top of the gateway log.",
    why: "the log exists and its first lines are a fact, not a guess",
    kind: "inspect",
  },
  {
    say: "Search the codebase for where we set the port.",
    why: "a search over files he cannot run himself while driving",
    kind: "inspect",
  },
  {
    say: "Pull up the diff for that last commit.",
    why: "the diff is in git, and she would otherwise invent a plausible one",
  },
  {
    say: "Look at the failing test and tell me why it broke.",
    why: "the reason is in the test output, which has to be read before it is explained",
    kind: "inspect",
  },

  // ── Changing things.
  {
    say: "Rename that function to something clearer.",
    why: "a rename is an edit to a real symbol in a real file",
    kind: "edit",
  },
  {
    say: "Fix the failing test and run the suite again.",
    why: "two pieces of work in one breath, both of them hands work",
    kind: "edit",
  },
  {
    say: "Add a route for the token endpoint.",
    why: "a route is code, and code has to be written somewhere",
    kind: "edit",
  },
  {
    say: "Delete the old renders folder.",
    why: "a destructive change he asked for by name",
    kind: "edit",
  },
  {
    say: "Update the readme with the new test count.",
    why: "the count has to be measured and the file has to be written",
    kind: "edit",
  },
  {
    say: "Write a test for the endpointer.",
    why: "new code in a new file, which is the plainest kind of work there is",
    kind: "edit",
  },
  {
    say: "Refactor the voice router so the gate lives in its own module.",
    why: "a refactor names its file and its shape, and nothing about it is chat",
    kind: "edit",
  },

  // ── Running things.
  {
    say: "Run the test suite.",
    why: "the suite either runs or it does not, and she cannot run it by talking",
    kind: "shell",
  },
  {
    say: "Build the app and tell me if it breaks.",
    why: "whether it breaks is only knowable by building it",
    kind: "shell",
  },
  {
    say: "Start the dev server on a different port.",
    why: "a process he wants started, with an argument",
    kind: "shell",
  },
  {
    say: "Kill whatever is on port four three one zero.",
    why: "the stale gateway is the single most common thing in his way",
    kind: "shell",
  },
  {
    say: "Install the new dependency and re-run the build.",
    why: "an install changes the tree on disk",
    kind: "shell",
  },

  // ── Driving Teminali OS itself: the workspace, the panels, the editor.
  {
    say: "Switch the workspace over to teminaliCut.",
    why: "changing project root is the OS obeying him, not a topic",
    kind: "workspace",
  },
  {
    say: "Open the terminal panel.",
    why: "a panel in this app that he wants visible",
    kind: "open",
  },
  {
    say: "Close the browser tab and go back to the editor.",
    why: "two window commands aimed at surfaces the OS owns",
    kind: "open",
  },
  {
    say: "Split the editor and put the test file on the right.",
    why: "a layout he wants, expressed the way anyone would say it out loud",
  },
  {
    say: "Take me back to the chat panel.",
    why: "navigation inside the app, phrased politely rather than as a verb",
  },

  // ── Questions she genuinely cannot answer without going and looking.
  {
    say: "How many tests are there now?",
    why: "a number, and a voice with no eyes answers a number by inventing one",
    kind: "inspect",
  },
  {
    say: "Is the build passing?",
    why: "measured 2026-09-09: answered 'the build is complete' three times out of three, untrue every time",
    kind: "inspect",
  },
  {
    say: "What branch am I on?",
    why: "git knows and she does not",
    kind: "inspect",
  },
  {
    say: "Which port is the gateway on?",
    why: "the invented '8080' is why the state gate exists at all",
    kind: "inspect",
  },
  {
    say: "Did the last deploy go through?",
    why: "a fact about the world, with a yes or no she has no access to",
    kind: "inspect",
  },
  {
    say: "Is there anything uncommitted in the tree?",
    why: "he is about to switch branches and needs the real answer, not a reassuring one",
    kind: "inspect",
  },
];

for (const { say, why, kind } of MUST_DELEGATE) {
  test(`CAPABILITY: "${say}" reaches the hands`, () => {
    const decision = idle(say);
    const gate = classifyMachineAction(say);

    if (decision.action.kind !== "delegate") {
      assert.fail(
        [
          "the instruction never reached the hands, so the persona answered it with no way to know.",
          `    he said:  "${say}"`,
          `    it is work because: ${why}`,
          `    but it routed: ${decision.action.kind}`,
          `    the router's reason: ${decision.reason}`,
          `    the gate said: ${gate ? `${gate.kind} (${gate.reason})` : "not work at all"}`,
        ].join("\n"),
      );
    }

    if (kind && decision.action.action !== kind) {
      assert.fail(
        [
          "delegated, but filed under the wrong family, so Temi narrates the wrong thing while it runs.",
          `    he said:  "${say}"`,
          `    expected: ${kind}`,
          `    got:      ${decision.action.action} because ${gate ? gate.reason : "(unknown)"}`,
        ].join("\n"),
      );
    }
  });
}

/**
 * The corpora may not overlap.
 *
 * Cheap, and it catches the one way this file could quietly stop meaning
 * anything: a sentence added to both lists, where whatever the gate does one
 * of the two tests goes green.
 */
test("no sentence appears in both corpora", () => {
  const safety = new Set(MUST_NOT_DELEGATE.map(({ say }) => say.toLowerCase()));
  const overlap = MUST_DELEGATE.filter(({ say }) => safety.has(say.toLowerCase())).map(({ say }) => say);
  assert.deepEqual(overlap, [], `these sentences are in both corpora: ${overlap.join(" / ")}`);
});
