import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceEdits } from "../src/services/liveEditProtocol.ts";

test("live edit parses explicit streamed and complete workspace file blocks", () => {
  const streamed = parseWorkspaceEdits('Working…\n```frontier-file path="src/App.tsx"\nexport const ready = tr');
  assert.deepEqual(streamed, [{ path: "src/App.tsx", content: "export const ready = tr", complete: false }]);

  const complete = parseWorkspaceEdits('```tsx path="src/App.tsx"\nexport const ready = true;\n```');
  assert.deepEqual(complete, [{ path: "src/App.tsx", content: "export const ready = true;\n", complete: true }]);
});

test("live edit supports a conventional file header and strips it from committed content", () => {
  const edits = parseWorkspaceEdits("```css\n/* no path */\n```\n```ts\n// file: src/state.ts\nexport const value = 1;\n```");
  assert.deepEqual(edits, [{ path: "src/state.ts", content: "export const value = 1;\n", complete: true }]);
});

test("live edit recognizes conventional markdown filename headings", () => {
  assert.deepEqual(
    parseWorkspaceEdits("### `src/components/Card.tsx`\n\n```tsx\nexport const Card = () => <article />;\n```"),
    [{ path: "src/components/Card.tsx", content: "export const Card = () => <article />;\n", complete: true }],
  );
});

test("a single code block may target the active file only for a real edit request", () => {
  assert.deepEqual(
    parseWorkspaceEdits("```tsx\nexport default function App() { return null; }\n```", { activePath: "src/App.tsx", userPrompt: "Fix and update the current component" }),
    [{ path: "src/App.tsx", content: "export default function App() { return null; }\n", complete: true }],
  );
  assert.deepEqual(
    parseWorkspaceEdits("```tsx\nexport default function App() { return null; }\n```", { activePath: "src/App.tsx", userPrompt: "Explain this code" }),
    [],
  );
});

test("live edit rejects unsafe and ambiguous inferred paths", () => {
  assert.deepEqual(parseWorkspaceEdits("```ts path=../outside.ts\nunsafe\n```"), []);
  assert.deepEqual(
    parseWorkspaceEdits("```ts\none\n```\n```ts\ntwo\n```", { activePath: "src/App.tsx", userPrompt: "update it" }),
    [],
  );
});

test("a multi-file scaffold answer with no path headers still reaches disk", () => {
  // The exact shape a local model produced in the landing-page benchmark:
  // three unlabelled fences, previously parsed to zero edits.
  const answer = [
    "Here is the page.",
    "```html\n<!DOCTYPE html>\n<html></html>\n```",
    "```css\nbody { margin: 0; }\n```",
    "```js\nconsole.log('ready');\n```",
  ].join("\n");

  assert.deepEqual(
    parseWorkspaceEdits(answer, { userPrompt: "Build a production-grade landing page for Teminali Nexus" }),
    [
      { path: "index.html", content: "<!DOCTYPE html>\n<html></html>\n", complete: true },
      { path: "styles.css", content: "body { margin: 0; }\n", complete: true },
      { path: "script.js", content: "console.log('ready');\n", complete: true },
    ],
  );
});

test("scaffold inference never guesses for repeated or unconventional languages", () => {
  // Two css blocks: which one is styles.css is unknowable, so commit nothing.
  assert.deepEqual(
    parseWorkspaceEdits("```css\na{}\n```\n```css\nb{}\n```", { userPrompt: "build the page" }),
    [],
  );
  // Python has no single conventional filename here.
  assert.deepEqual(
    parseWorkspaceEdits("```py\nprint(1)\n```", { userPrompt: "build a script" }),
    [],
  );
  // No edit intent means an explanatory answer is never written to disk.
  assert.deepEqual(
    parseWorkspaceEdits("```html\n<p>demo</p>\n```", { userPrompt: "Explain how this markup works" }),
    [],
  );
});

test("an explicit path always wins over scaffold inference", () => {
  assert.deepEqual(
    parseWorkspaceEdits('```html path="public/landing.html"\n<main></main>\n```', { userPrompt: "build the landing page" }),
    [{ path: "public/landing.html", content: "<main></main>\n", complete: true }],
  );
});
