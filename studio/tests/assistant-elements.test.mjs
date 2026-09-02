import assert from "node:assert/strict";
import test from "node:test";

import {
  centreOf,
  describeElement,
  indexElements,
  inventoryText,
  rankElements,
  scoreElement,
} from "../src/services/assistant/elements.ts";
import { buildPrompt, systemPrompt } from "../src/services/assistant/prompt.ts";

function element(id, overrides = {}) {
  return {
    id,
    role: "AXButton",
    label: id,
    frame: { x: 0, y: 0, width: 100, height: 24 },
    enabled: true,
    focused: false,
    actions: ["AXPress"],
    depth: 5,
    path: "Window",
    ...overrides,
  };
}

const WINDOW = { x: 0, y: 0, width: 1200, height: 800 };

/* ── Scoring ──────────────────────────────────────────────────────────────── */

test("a named button outranks an unnamed group of the same size", () => {
  const button = element("button", { role: "AXButton", label: "Send" });
  const group = element("group", { role: "AXGroup", label: undefined });
  assert.ok(scoreElement(button, WINDOW) > scoreElement(group, WINDOW));
});

test("a group covering most of the window is scaffolding, not a target", () => {
  const scaffold = element("bg", { role: "AXGroup", label: "Content", frame: { x: 0, y: 0, width: 1200, height: 780 } });
  const control = element("ok", { role: "AXButton", label: "OK" });
  assert.ok(scoreElement(control, WINDOW) > scoreElement(scaffold, WINDOW));
});

test("an element outside the focused window ranks below one inside it", () => {
  const inside = element("in", { frame: { x: 40, y: 40, width: 90, height: 24 } });
  const outside = element("out", { frame: { x: 4000, y: 40, width: 90, height: 24 } });
  assert.ok(scoreElement(inside, WINDOW) > scoreElement(outside, WINDOW));
});

test("a control too small to aim at is penalised", () => {
  const speck = element("speck", { frame: { x: 10, y: 10, width: 2, height: 2 } });
  assert.ok(scoreElement(speck, WINDOW) < scoreElement(element("normal"), WINDOW));
});

test("a disabled element is kept in the inventory, only ranked lower", () => {
  // "That button is greyed out" is a useful answer and cannot be given by an
  // assistant that was never shown the button.
  const disabled = element("d", { enabled: false });
  const ranked = rankElements([disabled], { windowFrame: WINDOW, limit: 10 });
  assert.equal(ranked.length, 1);
  assert.ok(scoreElement(disabled, WINDOW) < scoreElement(element("e"), WINDOW));
});

/* ── Ranking ──────────────────────────────────────────────────────────────── */

test("the budget is honoured and the best survive", () => {
  const noise = Array.from({ length: 200 }, (_, index) =>
    element(`g${index}`, { role: "AXGroup", label: undefined, frame: { x: index, y: index, width: 300, height: 300 } }));
  const wanted = element("send", { label: "Send", frame: { x: 500, y: 700, width: 80, height: 24 } });
  const ranked = rankElements([...noise, wanted], { windowFrame: WINDOW, limit: 20 });
  assert.equal(ranked.length, 20);
  assert.ok(ranked.some((entry) => entry.id === "send"));
});

test("survivors come back in reading order, not score order", () => {
  const bottom = element("bottom", { label: "Bottom", frame: { x: 10, y: 600, width: 80, height: 24 } });
  const top = element("top", { role: "AXGroup", label: "Top", frame: { x: 10, y: 20, width: 80, height: 24 } });
  const ranked = rankElements([bottom, top], { windowFrame: WINDOW, limit: 10 });
  // `bottom` scores higher (interactive role) but `top` is drawn first, and the
  // model is looking at the screenshot while it reads this list.
  assert.deepEqual(ranked.map((entry) => entry.id), ["top", "bottom"]);
});

test("elements on the same row are ordered left to right", () => {
  const right = element("right", { frame: { x: 400, y: 100, width: 60, height: 24 } });
  const left = element("left", { frame: { x: 40, y: 104, width: 60, height: 24 } });
  const ranked = rankElements([right, left], { windowFrame: WINDOW, limit: 10 });
  assert.deepEqual(ranked.map((entry) => entry.id), ["left", "right"]);
});

test("ranking the same screen twice gives the same inventory", () => {
  const input = [element("a"), element("b", { role: "AXGroup" }), element("c", { enabled: false })];
  assert.deepEqual(
    rankElements(input, { windowFrame: WINDOW, limit: 2 }).map((entry) => entry.id),
    rankElements(input, { windowFrame: WINDOW, limit: 2 }).map((entry) => entry.id),
  );
});

/* ── Geometry ─────────────────────────────────────────────────────────────── */

test("the click point is the centre of the frame the OS reported", () => {
  assert.deepEqual(centreOf({ x: 100, y: 200, width: 80, height: 40 }), { x: 140, y: 220 });
});

/* ── Description ──────────────────────────────────────────────────────────── */

test("a description leads with the id, because the id is what comes back", () => {
  const text = describeElement(element("e7", { label: "Publish release" }));
  assert.ok(text.startsWith("e7 "));
  assert.match(text, /Button/);
  assert.match(text, /"Publish release"/);
});

test("a disabled element says so in its line", () => {
  assert.match(describeElement(element("e1", { enabled: false })), /disabled/);
});

test("a long label is collapsed rather than filling the context", () => {
  const text = describeElement(element("e1", { label: `${"very ".repeat(60)}long` }));
  assert.ok(text.length < 220);
  assert.match(text, /…/);
});

test("the inventory is one element per line", () => {
  const lines = inventoryText([element("e0"), element("e1")]).split("\n");
  assert.equal(lines.length, 2);
});

test("elements are indexed by the id the plan will name", () => {
  const index = indexElements([element("e0"), element("e1")]);
  assert.equal(index.get("e1").id, "e1");
  assert.equal(index.get("e9"), undefined);
});

/* ── Prompt ───────────────────────────────────────────────────────────────── */

const OBSERVATION = {
  id: "obs_1",
  capturedAt: "2026-09-02T10:00:00.000Z",
  application: { name: "Safari", bundleId: "com.apple.Safari", pid: 501 },
  window: { title: "Teminali — Studio", frame: WINDOW },
  screens: [{ id: 1, main: true, x: 0, y: 0, width: 1512, height: 982, scale: 2 }],
  elements: [],
  truncated: false,
  sceneDescription: "A browser window with a toolbar and a page of text.",
  frame: null,
};

test("the prompt tells the model it cannot see coordinates", () => {
  const text = systemPrompt("agent");
  assert.match(text, /never write one/i);
  assert.match(text, /names an element by its id/i);
});

test("talk mode is told it may only point", () => {
  assert.match(systemPrompt("talk"), /you do not act/i);
  assert.doesNotMatch(systemPrompt("talk"), /You may act/);
});

test("agent mode is told to stop short of destructive work", () => {
  assert.match(systemPrompt("agent"), /destructive, irreversible/i);
});

test("the prompt carries the application, the inventory and the question", () => {
  const elements = [element("e0", { label: "Reload" })];
  const text = buildPrompt({
    question: "how do I reload the page",
    mode: "talk",
    observation: OBSERVATION,
    elements,
    inventory: inventoryText(elements),
  });
  assert.match(text, /Frontmost application: Safari/);
  assert.match(text, /Teminali — Studio/);
  assert.match(text, /e0 {2}Button {2}"Reload"/);
  assert.match(text, /how do I reload the page/);
});

test("the scene description is labelled as context, never as geometry", () => {
  const text = buildPrompt({
    question: "q", mode: "talk", observation: OBSERVATION, elements: [], inventory: "",
  });
  assert.match(text, /never a source of positions/);
});

test("a truncated inventory says so rather than reading as complete", () => {
  const text = buildPrompt({
    question: "q",
    mode: "talk",
    observation: { ...OBSERVATION, truncated: true },
    elements: [element("e0")],
    inventory: "e0",
  });
  assert.match(text, /of more/);
  assert.match(text, /cut to fit/);
});
