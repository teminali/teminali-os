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
];

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
 * An HTML document reduced to its text, in reading order.
 *
 * `<script>`, `<style>` and `<noscript>` go first and whole: their bodies are
 * not markup, so stripping tags alone would leave minified JavaScript behind —
 * which is exactly the noise that made the raw fetch useless.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/(?:<!--[\s\S]*?-->)/g, " ");
  text = text.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block-level ends become newlines so the reading order survives the squeeze.
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)\s*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  for (const [pattern, replacement] of ENTITIES) text = text.replace(pattern, replacement);
  // Collapse runs of spaces, then runs of blank lines, without joining lines.
  text = text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
