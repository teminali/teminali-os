import assert from "node:assert/strict";
import test from "node:test";
import { isTruncatingRewrite, parseWorkspaceEdits } from "../src/services/liveEditProtocol.ts";

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

test("live edit refuses a path block that holds a fragment of a long file", () => {
  // The shape the local lane actually produces: asked to change one default in
  // an 812-line file it has seen one line of, it answers with a two-line path
  // block. Committing that deletes 810 lines, so the applier must not.
  const long = Array.from({ length: 812 }, (_, i) => `const line${i} = ${i};`).join("\n");
  assert.equal(isTruncatingRewrite(long, "  port: Number(process.env.PORT ?? 4310),\n"), true);

  // The same file rewritten in full is an edit, not a truncation.
  assert.equal(isTruncatingRewrite(long, long.replace("line3 = 3", "line3 = 4310")), false);
});

test("live edit lets a short file be rewritten, and a long one be halved", () => {
  // Below the floor "rewrite the whole thing" is an ordinary request, and the
  // model can hold the file in its window, so nothing is refused.
  const short = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(isTruncatingRewrite(short, "line 0"), false);

  // At the cut itself: keeping half of a long file is allowed, one line less is not.
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(isTruncatingRewrite(long, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")), false);
  assert.equal(isTruncatingRewrite(long, Array.from({ length: 49 }, (_, i) => `line ${i}`).join("\n")), true);
});
