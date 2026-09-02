import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_LIMITS,
  describeStep,
  extractJson,
  parseChord,
  readPlan,
  validatePlan,
} from "../src/services/assistant/plan.ts";
import {
  ASSISTANT_AUTONOMY_LADDER,
  DEFAULT_ASSISTANT_SETTINGS,
} from "../src/services/assistant/types.ts";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function element(id, overrides = {}) {
  return {
    id,
    role: "AXButton",
    label: id.toUpperCase(),
    frame: { x: 10, y: 20, width: 80, height: 24 },
    enabled: true,
    focused: false,
    actions: ["AXPress"],
    depth: 4,
    path: "Window › Toolbar",
    ...overrides,
  };
}

const ELEMENTS = [
  element("e0", { label: "Send" }),
  element("e1", { label: "Cancel" }),
  element("e2", { label: "Publish", enabled: false }),
  element("e3", { role: "AXTextField", label: "Search", actions: ["AXConfirm"] }),
];

const agent = (plan) => validatePlan(plan, { elements: ELEMENTS, mode: "agent" });
const talk = (plan) => validatePlan(plan, { elements: ELEMENTS, mode: "talk" });

/* ── The load-bearing rule: no invented targets ───────────────────────────── */

test("a step naming an element that was never observed is rejected", () => {
  const result = agent({ say: "Clicking it.", steps: [{ kind: "click", element: "e99" }] });
  assert.equal(result.steps.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /not an element that was found on screen/);
});

test("a plan whose every step is invented still speaks, and acts on nothing", () => {
  const result = agent({
    say: "I will press the big green button.",
    steps: [{ kind: "click", element: "green" }, { kind: "click", element: "also-green" }],
  });
  assert.equal(result.steps.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.equal(result.say, "I will press the big green button.");
});

test("coordinates supplied by the model are not carried into the plan", () => {
  // A model that writes x/y is not partially trusted: the protocol has nowhere
  // to put them, so they are dropped with every other unknown key.
  const result = agent({ say: "ok", steps: [{ kind: "click", element: "e0", x: 900, y: 400 }] });
  assert.equal(result.steps.length, 1);
  assert.deepEqual(Object.keys(result.steps[0]).sort(), ["button", "count", "element", "kind"]);
  assert.equal("x" in result.steps[0], false);
  assert.equal("y" in result.steps[0], false);
});

test("a disabled element is refused by name, not silently skipped", () => {
  const result = agent({ say: "ok", steps: [{ kind: "click", element: "e2" }] });
  assert.equal(result.steps.length, 0);
  assert.match(result.rejected[0].reason, /"Publish" is disabled/);
});

/* ── Mode gating ──────────────────────────────────────────────────────────── */

test("talk mode keeps pointing and withholds every acting step", () => {
  const result = talk({
    say: "The send button is here.",
    steps: [
      { kind: "point", element: "e0", note: "top right" },
      { kind: "click", element: "e0" },
      { kind: "type", text: "hello" },
      { kind: "key", chord: "cmd+s" },
    ],
  });
  assert.deepEqual(result.steps, [{ kind: "point", element: "e0", note: "top right" }]);
  assert.equal(result.actionsWithheld, true);
  assert.equal(result.rejected.length, 3);
  for (const entry of result.rejected) assert.match(entry.reason, /does not act/);
});

test("dictate mode cannot act either — the gate is \"is not agent\", not \"is talk\"", () => {
  const result = validatePlan(
    { say: "ok", steps: [{ kind: "click", element: "e0" }, { kind: "point", element: "e0" }] },
    { elements: ELEMENTS, mode: "dictate" },
  );
  assert.deepEqual(result.steps, [{ kind: "point", element: "e0" }]);
  assert.equal(result.actionsWithheld, true);
});

test("agent mode does not report actions withheld when it acted", () => {
  const result = agent({ say: "ok", steps: [{ kind: "click", element: "e0" }] });
  assert.equal(result.actionsWithheld, false);
});

/* ── Step shapes ──────────────────────────────────────────────────────────── */

test("click defaults to one left button press and clamps a silly count", () => {
  assert.deepEqual(agent({ steps: [{ kind: "click", element: "e0" }] }).steps[0], {
    kind: "click", element: "e0", button: "left", count: 1,
  });
  assert.equal(agent({ steps: [{ kind: "click", element: "e0", count: 99 }] }).steps[0].count, 3);
  assert.equal(agent({ steps: [{ kind: "click", element: "e0", button: "middle" }] }).steps[0].button, "left");
});

test("an unknown verb is refused by name", () => {
  const result = agent({ steps: [{ kind: "drag", element: "e0" }] });
  assert.match(result.rejected[0].reason, /"drag" is not something this assistant can do/);
});

test("typed text is bounded", () => {
  const long = "x".repeat(PLAN_LIMITS.maxTypeLength + 1);
  assert.match(agent({ steps: [{ kind: "type", text: long }] }).rejected[0].reason, /exceeds/);
  assert.equal(agent({ steps: [{ kind: "type", text: "hello" }] }).steps[0].text, "hello");
});

test("a scroll that moves nothing is refused rather than executed", () => {
  assert.match(agent({ steps: [{ kind: "scroll", element: "e0", dx: 0, dy: 0 }] }).rejected[0].reason, /moved nothing/);
});

test("scroll distance is clamped", () => {
  assert.equal(agent({ steps: [{ kind: "scroll", element: "e0", dy: -99999 }] }).steps[0].dy, -PLAN_LIMITS.maxScroll);
});

test("a wait is bounded and a zero wait is refused", () => {
  assert.equal(agent({ steps: [{ kind: "wait", ms: 999999 }] }).steps[0].ms, PLAN_LIMITS.maxWaitMs);
  assert.match(agent({ steps: [{ kind: "wait", ms: 0 }] }).rejected[0].reason, /no duration/);
});

test("the step count is capped and the overflow is reported", () => {
  const steps = Array.from({ length: PLAN_LIMITS.maxSteps + 3 }, () => ({ kind: "click", element: "e0" }));
  const result = agent({ steps });
  assert.equal(result.steps.length, PLAN_LIMITS.maxSteps);
  assert.equal(result.rejected.length, 3);
  assert.match(result.rejected[0].reason, /exceeded/);
});

/* ── Chords ───────────────────────────────────────────────────────────────── */

test("a chord must name exactly one key", () => {
  assert.equal(parseChord("cmd+s").ok, true);
  assert.equal(parseChord("cmd+shift+p").ok, true);
  assert.equal(parseChord("cmd").ok, false);
  assert.equal(parseChord("cmd+s+t").ok, false);
  assert.equal(parseChord("").ok, false);
});

test("a chord naming a key the helper cannot press is refused", () => {
  const result = parseChord("cmd+eject");
  assert.equal(result.ok, false);
  assert.match(result.reason, /"eject" is not a key/);
});

test("chords are normalised so the helper receives one spelling", () => {
  const result = parseChord("  Command + Shift + P ");
  assert.equal(result.ok, true);
  assert.equal(result.chord, "command+shift+p");
});

/* ── Reading a reply ──────────────────────────────────────────────────────── */

test("JSON is found inside a fenced block", () => {
  const raw = 'Sure!\n```json\n{"say":"hi","steps":[]}\n```\nHope that helps.';
  assert.deepEqual(extractJson(raw), { say: "hi", steps: [] });
});

test("a brace inside a string does not end the object early", () => {
  assert.deepEqual(extractJson('{"say":"press { then }","steps":[]}'), { say: "press { then }", steps: [] });
});

test("an escaped quote inside a string is handled", () => {
  assert.deepEqual(extractJson('{"say":"the \\"Send\\" button","steps":[]}'), { say: 'the "Send" button', steps: [] });
});

test("a reply with no JSON at all is an answer, not a crash", () => {
  assert.equal(extractJson("I am not sure what you mean."), null);
  const result = readPlan("I am not sure what you mean.", { elements: ELEMENTS, mode: "agent" });
  assert.equal(result.steps.length, 0);
  assert.match(result.rejected[0].reason, /not a JSON object/);
});

test("a plan with only speech is valid", () => {
  const result = readPlan('{"say":"That setting is under Preferences.","steps":[]}', {
    elements: ELEMENTS, mode: "talk",
  });
  assert.equal(result.say, "That setting is under Preferences.");
  assert.deepEqual(result.steps, []);
  assert.deepEqual(result.rejected, []);
});

test("a plan with no speech still says something rather than going silent", () => {
  assert.ok(agent({ steps: [{ kind: "click", element: "e0" }] }).say.length > 0);
});

test("speech is truncated rather than read aloud forever", () => {
  const result = agent({ say: "word ".repeat(400), steps: [] });
  assert.ok(result.say.length <= PLAN_LIMITS.maxSayLength);
});

/* ── Description ──────────────────────────────────────────────────────────── */

test("a step is described with the element's own label, not its id", () => {
  assert.equal(describeStep({ kind: "click", element: "e0", button: "left", count: 1 }, ELEMENTS), "Click “Send”");
  assert.equal(describeStep({ kind: "key", chord: "cmd+s" }, ELEMENTS), "Press cmd+s");
  assert.match(describeStep({ kind: "point", element: "e1", note: "left of Send" }, ELEMENTS), /Point at “Cancel” — left of Send/);
});

/* ── Defaults ─────────────────────────────────────────────────────────────── */

test("the assistant defaults to the top of the ladder, deliberately", () => {
  // Changed by the operator on 2026-09-03: a hands-free assistant that stops for
  // approval on every click is not hands-free. The confirmation step did not
  // disappear — it moved out of the default and into the operator's hands, which
  // is why the two safer rungs must stay on the ladder for this to be reversible.
  const mostPermissive = ASSISTANT_AUTONOMY_LADDER[ASSISTANT_AUTONOMY_LADDER.length - 1];
  assert.equal(DEFAULT_ASSISTANT_SETTINGS.autonomy, mostPermissive);
  assert.equal(DEFAULT_ASSISTANT_SETTINGS.autonomy, "auto");
  assert.ok(ASSISTANT_AUTONOMY_LADDER.includes("guide"));
  assert.ok(ASSISTANT_AUTONOMY_LADDER.includes("confirm"));
});

test("the assistant defaults to acting rather than explaining", () => {
  assert.equal(DEFAULT_ASSISTANT_SETTINGS.mode, "agent");
});
