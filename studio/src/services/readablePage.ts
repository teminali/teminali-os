/**
 * Turning a fetched web page into something the lane can actually read.
 *
 * The local lane already fetches a named URL without being asked twice — the
 * eval's `web-fetch-url` case scores 3/3. What it could not do was *learn*
 * anything from the fetch. `curl` of a real documentation page returns an HTML
 * document, and the command pipeline keeps only the first `maxOutputChars` of
 * it, so the model was handed the `<head>`: doctype, webpack module hashes,
 * `<link rel=...>`, and none of the answer.
 *
 * Measured on https://nodejs.org/en/about/previous-releases, the case the eval
 * asks about (296,070 bytes downloaded, 295,973 chars decoded):
 *
 *   raw, first 4,000 chars     0 occurrences of "LTS", no version number
 *   after `htmlToText`         5,683 chars, first "LTS" at offset 481
 *
 * The fix belongs here rather than in the system prompt: it costs no prompt
 * tokens, and the window — not the tool count — is this lane's real constraint.
 *
 * It is a large improvement, not yet a complete one, and the gap is worth
 * knowing. The lane's real allowance is `toolResultChars`: 2,621 chars on an 8k
 * window, 10,485 on 32k. So on 32k the whole page now arrives; on 8k the prose
 * arrives but the release table — first version number at offset 5,010 — still
 * falls outside the cut. Closing that means dropping site chrome (this page
 * spends its first 481 chars on nav links), which is a heuristic worth its own
 * measurement rather than a guess bolted on here.
 *
 * This is deliberately not a browser. It does not run scripts, so a page that
 * renders entirely on the client still yields little; that is a known limit,
 * not a bug to fix by adding a headless browser to a local-first product.
 */

/** The entities worth decoding: the ones that survive tag-stripping as noise. */
const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#0*39;|&apos;/g, "'"],
  [/&#x2019;|&rsquo;/g, "’"],
  [/&mdash;/g, "—"],
  [/&ndash;/g, "–"],
  [/&copy;/g, "©"],
  [/&middot;/g, "·"],
];

/** Elements that hold the page, when a page says which one it is. */
const CONTENT_ROOTS = ["main", "article"];

/**
 * Elements that are the site, not the page.
 *
 * `header` is in the list even though an article's title sometimes sits inside
 * one, because the title is recovered separately from `<title>` — the two rules
 * are a pair, and dropping `header` without the prepend would lose headings.
 */
const CHROME = ["nav", "aside", "footer", "header"];

/**
 * The floor under which an extracted root is not believed.
 *
 * A page that renders on the client ships an empty `<main>`; trusting it would
 * turn a thin result into an empty one. Below this, the whole document is used
 * instead — the same "measure, don't assume" rule the rest of this file follows.
 */
const MIN_ROOT_CHARS = 200;

/**
 * A tag, with `>` inside a quoted attribute value not ending it.
 *
 * `<[^>]+>` stops at the first `>`, so a tag carrying one in an attribute — a
 * URL with a query, or Wikipedia's `data-mw` payloads, which hold whole
 * templates — ends early and the rest of the attribute is emitted as if it were
 * the page's own words. Measured on one Wikipedia article that leaked 1,274
 * chars of raw wikitext ahead of the lead paragraph.
 *
 * A quoted run may not contain `<`, so an unbalanced quote in malformed markup
 * fails this pattern near where it started instead of swallowing the document;
 * the plain catch-all still runs afterwards and picks it up.
 */
const TAG_WITH_ATTRIBUTES = /<[a-zA-Z!/?][^>"'<]*(?:(?:"[^"<]*"|'[^'<]*')[^>"'<]*)*>/g;

/**
 * The ranges of `tag` in `html`, matched to the *balancing* close tag.
 *
 * A non-greedy `<tag>...</tag>` regex stops at the first close, which for a
 * nested element ends the range in the middle of it. That is tolerable for
 * `<script>` (scripts do not nest) and wrong for `<nav>` and `<article>`, which
 * do. Ranges come back in source order and never overlap.
 */
function elementRanges(html: string, tag: string): Array<{ start: number; end: number; innerStart: number; innerEnd: number }> {
  const token = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "gi");
  const ranges: Array<{ start: number; end: number; innerStart: number; innerEnd: number }> = [];
  let depth = 0;
  let start = 0;
  let innerStart = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    if (match[1] === "/") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) ranges.push({ start, end: token.lastIndex, innerStart, innerEnd: match.index });
      continue;
    }
    if (/\/\s*$/.test(match[2])) continue;
    if (depth === 0) {
      start = match.index;
      innerStart = token.lastIndex;
    }
    depth += 1;
  }
  return ranges;
}

/** The page's own title, which survives the chrome rules that drop headings. */
function documentTitle(html: string): string {
  const found = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return found ? decodeEntities(found[1]).replace(/\s+/g, " ").trim() : "";
}

/**
 * The part of the document that is this page rather than this site.
 *
 * `<main>` and `<article>` are taken on the page's own word; `role="main"` is
 * the same claim made by a document that predates the element. Every match is
 * kept, so an index of articles does not collapse to its first entry.
 */
function contentRoot(html: string): string | null {
  for (const tag of CONTENT_ROOTS) {
    const found = elementRanges(html, tag);
    if (found.length) return found.map((range) => html.slice(range.innerStart, range.innerEnd)).join("\n");
  }
  const roled = /<([a-z][\w-]*)[^>]*\brole=["']main["'][^>]*>/i.exec(html);
  if (!roled) return null;
  const from = roled.index;
  const [range] = elementRanges(html.slice(from), roled[1]);
  return range ? html.slice(from + range.innerStart, from + range.innerEnd) : null;
}

/** The same markup with the site's furniture removed, innermost last. */
function dropChrome(html: string): string {
  let out = html;
  for (const tag of CHROME) {
    for (const range of elementRanges(out, tag).reverse()) out = `${out.slice(0, range.start)} ${out.slice(range.end)}`;
  }
  return out;
}

/** A decoded numeric entity, or undefined when the number is not a character. */
function codePoint(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return undefined;
  if (value >= 0xd800 && value <= 0xdfff) return undefined;
  return String.fromCodePoint(value);
}

/** Named entities from the table, then any numeric one that is a real character. */
function decodeEntities(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  out = out.replace(/&#(\d{1,7});/g, (whole, digits) => codePoint(Number(digits)) ?? whole);
  return out.replace(/&#x([0-9a-f]{1,6});/gi, (whole, hex) => codePoint(parseInt(hex, 16)) ?? whole);
}

/** Tags, script bodies and entities gone; reading order kept. */
function stripMarkup(html: string): string {
  let text = html.replace(/(?:<!--[\s\S]*?-->)/g, " ");
  text = text.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block-level ends become newlines so the reading order survives the squeeze.
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)\s*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(TAG_WITH_ATTRIBUTES, " ");
  // Whatever was too malformed for the pattern above is still not prose.
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  // Collapse runs of spaces, then runs of blank lines, without joining lines.
  text = text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Whether output is an HTML *document*, judged only on its opening.
 *
 * The test is deliberately narrow. A command whose output merely contains a tag
 * — an API returning a JSON string with markup in it, an XML feed, a grep hit in
 * a template — must be left exactly as it came back, because the operator asked
 * for that text and rewriting it would be the same class of mistake as
 * overwriting a file the model had only seen one line of.
 */
export function looksLikeHtml(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text.slice(0, 200));
}

/**
 * An HTML document reduced to the page's own text, in reading order.
 *
 * `<script>`, `<style>` and `<noscript>` go first and whole: their bodies are
 * not markup, so stripping tags alone would leave minified JavaScript behind —
 * which is exactly the noise that made the raw fetch useless.
 */
export function htmlToText(html: string): string {
  const whole = stripMarkup(dropChrome(html));
  const root = contentRoot(html);
  const page = root === null ? "" : stripMarkup(dropChrome(root));
  const body = page.length >= MIN_ROOT_CHARS ? page : whole;

  const title = documentTitle(html);
  if (!title || body.slice(0, title.length + 2).includes(title)) return body;
  return body ? `${title}\n\n${body}` : title;
}
