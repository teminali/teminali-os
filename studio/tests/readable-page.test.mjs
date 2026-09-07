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

/*
  Chrome, and the measurement behind it.

  Stripping tags was only half the job: what came back was the whole *site* —
  top nav, sidebar, footer, cookie line — with the page somewhere inside it. On
  a corpus of six real pages fetched 2026-09-07 (nodejs.org, MDN, Wikipedia,
  docs.python.org, github.com, blog.rust-lang.org), the offset at which the
  answer appeared moved:

    node    1,590 -> 1,208      mdn     2,421 ->   304
    wiki    4,446 -> 1,441      pydocs  8,048 -> 7,290
    github  4,080 -> 1,865      rust      211 ->    92

  Against `toolResultChars` on an 8k window (2,621), that is five of six pages
  carrying their answer into the model's window, up from three. The sixth is not
  a chrome failure: docs.python.org genuinely spends 7,290 chars of prose before
  the sentence in question, which no amount of stripping moves.

  Fixtures below are padded past MIN_ROOT_CHARS, because a root thinner than
  that is deliberately not believed.
*/
const filler = "The page's own words, repeated so the content root clears the floor. ".repeat(5);

const withLandmarks = `<!DOCTYPE html><html><head><title>Releases — Example</title></head><body>`
  + `<header><a href="/">Example</a><nav>Learn Download Blog Docs</nav></header>`
  + `<aside><nav>Change page About Governance Branding</nav></aside>`
  + `<main><h1>Releases</h1><p>${filler}</p><p>v24 is the current LTS.</p></main>`
  + `<footer><nav>Cookie Policy Trademark Bylaws</nav><p>Copyright &copy; 2026.</p></footer>`
  + `</body></html>`;

test("readable page returns the page, not the site around it", () => {
  const text = htmlToText(withLandmarks);
  assert.match(text, /v24 is the current LTS\./, "the answer was dropped with the chrome");
  for (const furniture of ["Learn Download Blog", "Change page", "Cookie Policy", "Copyright"]) {
    assert.equal(text.includes(furniture), false, `${furniture} survived`);
  }
});

test("readable page recovers the title that the chrome rules drop", () => {
  // The h1 sits inside the <header> this file deletes, so <title> is the only
  // thing left saying what the page is. Dropping both would be a regression.
  const inHeader = `<!DOCTYPE html><html><head><title>Announcing Rust 1.83.0</title></head><body>`
    + `<article><header><h1>Announcing Rust 1.83.0</h1></header><p>${filler}</p></article></body></html>`;
  assert.match(htmlToText(inHeader), /^Announcing Rust 1\.83\.0\n/);
});

test("readable page does not say the title twice", () => {
  const text = htmlToText(withLandmarks);
  assert.equal(text.indexOf("Releases — Example"), 0);
  assert.equal(text.indexOf("Releases — Example", 1), -1, "the title was repeated");
});

test("an attribute value is not part of the page's words", () => {
  // A `>` inside a quoted attribute used to end the tag match early and spill
  // the rest of the value into the text. Wikipedia's data-mw payloads carry
  // whole templates, so this leaked 1,274 chars of wikitext before the article.
  const leaky = `<!DOCTYPE html><html><head><title>T</title></head><body><main>`
    + `<div data-mw='{"wt":"{{cite web | url=https://x/tags?after=v0>NOT_PROSE}}"}'>`
    + `<p>${filler}</p></div></main></body></html>`;
  const text = htmlToText(leaky);
  assert.equal(text.includes("NOT_PROSE"), false, "an attribute value reached the model as text");
  assert.equal(text.includes("cite web"), false, "an attribute value reached the model as text");
  assert.match(text, /The page's own words/);
});

test("a nested element does not end its parent early", () => {
  // Balanced matching is the whole point: a non-greedy regex would stop at the
  // inner </nav> and leave the outer nav's tail behind as text.
  const nested = `<!DOCTYPE html><html><head><title>T</title></head><body>`
    + `<nav>Outer start<nav>Inner links</nav>Outer tail</nav>`
    + `<main><p>${filler}</p></main></body></html>`;
  const text = htmlToText(nested);
  assert.equal(text.includes("Outer tail"), false, "the outer nav ended at the inner close");
  assert.equal(text.includes("Inner links"), false);
});

test("every article is kept, so an index does not collapse to its first entry", () => {
  const index = `<!DOCTYPE html><html><head><title>T</title></head><body>`
    + `<article><p>First post. ${filler}</p></article>`
    + `<article><p>Second post.</p></article></body></html>`;
  const text = htmlToText(index);
  assert.match(text, /First post\./);
  assert.match(text, /Second post\./);
});

test("an empty content root is not believed", () => {
  // A client-rendered page ships an empty <main>. Trusting it would turn a thin
  // result into an empty one, so the whole document is used instead.
  const clientRendered = `<!DOCTYPE html><html><head><title>T</title></head><body>`
    + `<main id="root"></main><div id="fallback"><p>${filler}</p></div></body></html>`;
  assert.match(htmlToText(clientRendered), /The page's own words/);
});

test("numeric entities decode, in the body and in the title", () => {
  const numeric = `<!DOCTYPE html><html><head><title>json &#8212; JSON encoder</title></head>`
    + `<body><main><p>${filler}</p><p>A &#160;gap, a &#x2014; dash, and &#99999999; left alone.</p>`
    + `</main></body></html>`;
  const text = htmlToText(numeric);
  assert.match(text, /^json — JSON encoder\n/);
  assert.match(text, /a — dash/);
  assert.match(text, /&#99999999; left alone/, "a number that is not a character was decoded anyway");
});
