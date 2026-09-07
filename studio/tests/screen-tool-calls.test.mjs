import assert from "node:assert/strict";
import test from "node:test";
import { parseScreenToolCalls, summariseScreen } from "../src/services/screenToolCalls.ts";

const fence = (body, tag = "screen") => "Let me look.\n```" + tag + "\n" + body + "\n```";

test("an explicit screen fence is a look", () => {
  const looks = parseScreenToolCalls(fence('{"action":"look","question":"what does the dialog say?"}'));
  assert.deepEqual(looks, [{ action: "look", question: "what does the dialog say?" }]);
});

test("an empty object is a look, because there is only one action", () => {
  assert.deepEqual(parseScreenToolCalls(fence("{}")), [{ action: "look" }]);
});

test("documentation is not an instruction", () => {
  const text = 'To look at the screen you would write:\n```json\n{"action":"look"}\n```';
  assert.deepEqual(parseScreenToolCalls(text), []);
});

test("a screenshot fence is not a screen fence", () => {
  assert.deepEqual(parseScreenToolCalls(fence('{"action":"look"}', "screenshot")), []);
});

test("a half-remembered tag still earns its call", () => {
  assert.deepEqual(parseScreenToolCalls(fence('{"action":"look"}', "screen-tool")), [{ action: "look" }]);
});

test("an invented action is refused rather than silently observed", () => {
  assert.deepEqual(parseScreenToolCalls(fence('{"action":"click","element":"OK"}')), []);
});

test("two looks in one reply are one look", () => {
  const text = fence('{"action":"look"}') + "\n" + fence('{"action":"look","question":"again"}');
  assert.equal(parseScreenToolCalls(text).length, 1);
});

const observation = {
  application: { name: "Safari" },
  window: { title: "Bank — Transfer" },
  sceneDescription: "A red error dialog over a form.",
  truncated: false,
  elements: [
    { role: "AXStaticText", label: "", value: "Insufficient funds" },
    { role: "AXButton", label: "OK", focused: true },
    { role: "AXGroup" },
  ],
};

test("the summary names the app, the window, the scene and the named controls", () => {
  const text = summariseScreen(observation, "what does the dialog say?");
  assert.match(text, /Looking for: what does the dialog say\?/);
  assert.match(text, /Frontmost application: Safari/);
  assert.match(text, /Window: Bank — Transfer/);
  assert.match(text, /A red error dialog over a form\./);
  assert.match(text, /Insufficient funds/);
  assert.match(text, /AXButton: OK \(focused\)/);
});

test("an element with neither label nor value costs nothing", () => {
  assert.ok(!summariseScreen(observation).includes("AXGroup"));
});

test("a cut list says it was cut, so absence is never reported from it", () => {
  const many = {
    application: { name: "Finder" },
    truncated: true,
    elements: Array.from({ length: 30 }, (_, i) => ({ role: "AXButton", label: `b${i}` })),
  };
  const text = summariseScreen(many);
  assert.match(text, /12 of 30\+/);
  assert.match(text, /cut to fit/);
});

test("a screen with no named controls says so rather than implying emptiness", () => {
  const text = summariseScreen({ application: { name: "Preview" }, sceneDescription: "A PDF page." });
  assert.match(text, /No named controls were reported/);
});
