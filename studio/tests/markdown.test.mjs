import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeMarkdown, safeHref, tokenizeInline } from "../src/services/markdown.ts";

const kinds = (text) => tokenizeInline(text).map((token) => `${token.type}:${token.value}`);

test("inline emphasis, code, and strikethrough are tokenized", () => {
  assert.deepEqual(kinds("a **b** c"), ["text:a ", "bold:b", "text: c"]);
  assert.deepEqual(kinds("*i* and _j_"), ["italic:i", "text: and ", "italic:j"]);
  assert.deepEqual(kinds("***both***"), ["boldItalic:both"]);
  assert.deepEqual(kinds("~~gone~~"), ["strike:gone"]);
  assert.deepEqual(kinds("run `npm test` now"), ["text:run ", "code:npm test", "text: now"]);
});

test("inline code wins over emphasis inside it", () => {
  // ``**x**`` inside backticks must stay literal, not render as bold.
  assert.deepEqual(kinds("`**x**`"), ["code:**x**"]);
});

test("links are tokenized and bare urls are auto-linked", () => {
  assert.deepEqual(tokenizeInline("[docs](https://example.com)"), [
    { type: "link", value: "docs", href: "https://example.com" },
  ]);
  assert.deepEqual(tokenizeInline("see https://example.com/x"), [
    { type: "text", value: "see " },
    { type: "link", value: "https://example.com/x", href: "https://example.com/x" },
  ]);
});

test("dangerous link schemes never become links", () => {
  // A model or a paste must not be able to produce a javascript: anchor.
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>"), null);
  assert.equal(safeHref("vbscript:x"), null);
  assert.equal(safeHref("https://ok.example"), "https://ok.example");
  assert.equal(safeHref("mailto:a@b.co"), "mailto:a@b.co");

  const tokens = tokenizeInline("[click](javascript:alert(1))");
  assert.equal(tokens.every((token) => token.type !== "link"), true);
  assert.equal(tokens.map((t) => t.value).join(""), "[click](javascript:alert(1))");
});

test("plain text passes through untouched and merges", () => {
  assert.deepEqual(tokenizeInline("just words"), [{ type: "text", value: "just words" }]);
  assert.deepEqual(tokenizeInline(""), []);
});

test("markdown detection distinguishes structure from prose", () => {
  assert.equal(looksLikeMarkdown("# Heading"), true);
  assert.equal(looksLikeMarkdown("- one\n- two"), true);
  assert.equal(looksLikeMarkdown("1. first"), true);
  assert.equal(looksLikeMarkdown("| a | b |"), true);
  assert.equal(looksLikeMarkdown("use `code`"), true);
  assert.equal(looksLikeMarkdown("**bold**"), true);
  assert.equal(looksLikeMarkdown("just a normal sentence"), false);
  assert.equal(looksLikeMarkdown("2 * 3 = 6"), false);
});

import { extractCodeFromResponse } from "../src/services/markdown.ts";

test("inline edits extract code without prose or fence markers", () => {
  // The exact failure mode: the whole reply was written into the file.
  const reply = "Here's the refactored version:\n\n```ts\nexport const add = (a: number, b: number) => a + b;\n```\n\nThis uses an arrow function.";
  assert.equal(extractCodeFromResponse(reply), "export const add = (a: number, b: number) => a + b;");
});

test("the longest fenced block wins over an inline mention", () => {
  const reply = "Rename `foo`:\n```ts\nconst x = 1;\n```\ndetails\n```ts\nexport function longer() {\n  return 42;\n}\n```";
  assert.match(extractCodeFromResponse(reply), /export function longer/);
});

test("an unterminated fence still yields its code while streaming", () => {
  assert.equal(extractCodeFromResponse("```js\nconst a = 1;\nconst b = 2;"), "const a = 1;\nconst b = 2;");
});

test("a bare code reply is returned untouched", () => {
  assert.equal(extractCodeFromResponse("const a = 1;\nconst b = 2;"), "const a = 1;\nconst b = 2;");
  assert.equal(extractCodeFromResponse(""), "");
});

test("conversational wrappers around unfenced code are trimmed", () => {
  const reply = "Sure, here is the fix.\nconst value = compute(input);\nThis handles the edge case.";
  assert.equal(extractCodeFromResponse(reply), "const value = compute(input);");
});
