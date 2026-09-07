import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText, looksLikeHtml } from "../src/services/readablePage.ts";
import { runAgentCommands } from "../src/services/agentCommands.ts";

/*
  A page shaped like the one that exposed the bug: a large head of bundler noise
  and inline script, with the answer far enough into the body that the old
  first-4,000-chars cut could never reach it.
*/
const noise = '<link rel="preload" href="/_next/static/chunks/webpack-3t9v5HHZAEREFPtHiog.js"/>'.repeat(80);
const page = `<!DOCTYPE html><html lang="en-GB"><head><meta charSet="utf-8"/>${noise}`
  + `<style>.a{color:#fff}${"/* padding */".repeat(200)}</style>`
  + `<script>window.__DATA__=${JSON.stringify({ pad: "x".repeat(4000) })}</script>`
  + `</head><body><nav>Skip to content</nav>`
  + `<h1>Node.js Releases</h1><p>Node.js v24.20.0 is the current LTS release.</p>`
  + `<p>Details &amp; caveats &lt;here&gt;</p></body></html>`;

test("readable page recognises an HTML document and leaves everything else alone", () => {
  assert.equal(looksLikeHtml(page), true);
  assert.equal(looksLikeHtml("<html><body>hi</body></html>"), true);
  assert.equal(looksLikeHtml('  \n<!doctype HTML><html>'), true);
  // The narrowness is the point: output that merely contains markup is untouched.
  assert.equal(looksLikeHtml('{"ok":true,"body":"<html>not a document</html>"}'), false);
  assert.equal(looksLikeHtml('<?xml version="1.0"?><rss><item/></rss>'), false);
  assert.equal(looksLikeHtml("src/App.tsx:12:  return <html lang=\"en\" />;"), false);
  assert.equal(looksLikeHtml(""), false);
});

test("readable page strips script and style bodies, not just their tags", () => {
  const text = htmlToText(page);
  assert.equal(text.includes("window.__DATA__"), false, "inline script survived");
  assert.equal(text.includes("color:#fff"), false, "inline style survived");
  assert.equal(text.includes("webpack-3t9v5"), false, "bundler noise survived");
  // Not a blanket "no angle bracket": the fixture decodes &lt;here&gt; into real
  // text, so the assertion is about markup, not about the character.
  assert.equal(/<\/?(?:link|script|style|p|h1|nav|body|html|meta)\b/i.test(text), false, "a tag survived");
  assert.equal(text.includes("charSet"), false, "an attribute survived");
});

test("readable page keeps the answer and decodes entities", () => {
  const text = htmlToText(page);
  assert.match(text, /Node\.js v24\.20\.0 is the current LTS release\./);
  assert.match(text, /Details & caveats <here>/);
  // Block ends become newlines, so the heading does not run into the paragraph.
  assert.match(text, /Node\.js Releases\nNode\.js v24\.20\.0/);
});

test("readable page reduces a document to a fraction of its markup", () => {
  const text = htmlToText(page);
  assert.ok(page.length > 8000, `fixture too small to be a real test (${page.length})`);
  assert.ok(text.length < page.length / 8, `only reduced ${page.length} to ${text.length}`);
});

/*
  The end-to-end claim, through the real runner: a fetch whose answer sits past
  the cut must arrive in the evidence. Before the readable step this assertion
  failed on the head alone.
*/
test("a fetched page reaches the model as text, with the answer intact", async () => {
  const executed = await runAgentCommands('```frontier-run\ncurl -s https://nodejs.org/en/about/previous-releases\n```', {
    autoApproveAll: true,
    maxOutputChars: 4_000,
    // Streamed in chunks, the way a real command arrives.
    execute: async (_command, { onOutput }) => {
      for (let at = 0; at < page.length; at += 512) onOutput({ data: page.slice(at, at + 512) });
      return { code: 0, durationMs: 4, truncated: false };
    },
  });

  assert.equal(executed.length, 1);
  const [result] = executed;
  assert.equal(result.executed, true);
  assert.match(result.output, /v24\.20\.0 is the current LTS release/);
  assert.equal(result.output.includes("webpack-3t9v5"), false, "the model was handed bundler noise");
  assert.ok(result.output.length <= 4_100, `evidence was ${result.output.length} chars`);
});

test("a non-HTML command output is passed through byte for byte", async () => {
  const json = '{"bitcoin":{"usd":64230.11}}';
  const executed = await runAgentCommands('```frontier-run\ncurl -s https://api.coingecko.com/x\n```', {
    autoApproveAll: true,
    execute: async (_command, { onOutput }) => {
      onOutput({ data: json });
      return { code: 0, durationMs: 2, truncated: false };
    },
  });
  assert.equal(executed[0].output, json);
});
