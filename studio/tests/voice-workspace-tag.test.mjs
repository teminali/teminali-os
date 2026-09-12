/**
 * She does what the tag says, and she never says the tag.
 *
 * The Gemini lane moves the shell by emitting `<workspace-action ... />` into
 * the same stream it speaks from. Three things were wrong with that, and all
 * three were things the operator could hear:
 *
 *   - "Open package.json" opened the file and then read the markup out loud,
 *     cut off at the first dot in the path, because that is where the sentence
 *     sounded finished to the speech path.
 *   - "Open the readme and then open package.json" ran the first tag only. The
 *     site used `.match`, which is not global, so every action after the first
 *     one in a turn was parsed and thrown away in silence.
 *   - "Close that file" reached no closer at all. It was classified as an open
 *     and delegated to the agent, there was no close verb anywhere on the lane,
 *     nothing touched `closeTab`, and she confirmed a close that never
 *     happened.
 *
 * The parsing and the stripping live in `workspaceActions.ts` rather than in
 * `frontierEngine.ts` so that they can be run here instead of read: the engine
 * imports the gateway and the whole renderer graph, and a tag that is only
 * asserted by matching source text is a tag nobody has executed. The wiring in
 * the engine -- which text reaches the speech path, and what the spoken prompt
 * tells the model it may emit -- is the part this file still reads as source,
 * because it is wiring and not logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createTagStripper,
  describeOpenEditors,
  parseWorkspaceTags,
  stripWorkspaceTags,
  OPEN_TABS_LIMIT,
} from "../src/services/voice/workspaceActions.ts";

const read = (relative) => readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");

/** The workspace a spoken turn is answered from. */
const ROOT = "/Users/teminali/Documents/my_projects/teminali/teminaliCode";

/**
 * Everything the speech path would be handed, for a model reply delivered as
 * `chunks`. This is the stream side of the contract: onToken plus the flush,
 * concatenated, exactly as the engine emits it.
 */
const spoken = (chunks) => {
  const stripper = createTagStripper();
  let heard = "";
  for (const chunk of chunks) heard += stripper.push(chunk);
  return heard + stripper.flush();
};

/** The same reply arriving one character at a time, the worst case. */
const perCharacter = (text) => spoken([...text]);

/* ── she never says the tag ──────────────────────────────────────────────── */

test('"open package.json" opens the file without reading the markup aloud', () => {
  // What regressing sounds like: "Opening package. " -- the voice stops at the
  // first dot in the path, because to the speech path that is a full stop.
  const reply =
    '<workspace-action action="open-file" path="/Users/teminali/package.json" />\nOpened package.json for you.';

  assert.equal(stripWorkspaceTags(reply), "Opened package.json for you.");
  assert.ok(!spoken([reply]).includes("<workspace-action"));
  assert.ok(!perCharacter(reply).includes("<workspace-action"));
  // And nothing of the tag survives in pieces either: no stray bracket, no
  // orphaned attribute name left mid-sentence.
  assert.ok(!perCharacter(reply).includes("path="));
  assert.ok(!perCharacter(reply).includes("<"));
});

test("a tag split across stream chunks is never spoken in fragments", () => {
  // The real failure mode: the tag arrives as tokens, so `<workspace-` reaches
  // the voice a beat before the tag is closed. Held back, it is never said.
  const chunks = [
    "Sure. ",
    "<work",
    'space-action action="open',
    '-file" path="/Users/teminali/src/app.ts"',
    " />",
    "\nOpened app.ts.",
  ];
  const heard = spoken(chunks);
  // The words arrive intact and the tag is gone. The space the tag sat in stays
  // -- the stream cannot tidy whitespace it has already emitted, and only the
  // completed text is tidied, by `stripWorkspaceTags`.
  assert.equal(heard, "Sure. \nOpened app.ts.");
  assert.ok(!heard.includes("<work"));
});

test("any number of tags leaves no markup in the spoken text", () => {
  // Four in one turn, on their own lines, the shape the model actually emits.
  const reply = [
    '<workspace-action action="open-file" path="a.ts" />',
    '<workspace-action action="open-file" path="b.ts" />',
    '<workspace-action action="reveal" path="src" />',
    '<workspace-action action="close-file" scope="all" />',
    "All set.",
  ].join("\n");

  for (const heard of [stripWorkspaceTags(reply), spoken([reply]), perCharacter(reply)]) {
    assert.ok(!heard.includes("<workspace-action"), "markup reached the speech path");
    assert.ok(heard.includes("All set."));
  }
});

test("ordinary prose passes through unharmed, angle brackets and all", () => {
  // The stripper must not cost the operator words. A `<` that is not the start
  // of a tag is released as soon as it cannot be one.
  const reply = "Use a < b to compare, and <em>this</em> is fine.";
  assert.equal(spoken([reply]), reply);
  assert.equal(perCharacter(reply), reply);
  assert.equal(stripWorkspaceTags(reply), reply);
});

test("a tag the model never closes is spoken, not swallowed", () => {
  // Silence is the worse failure. A malformed tag ends up said out loud, which
  // is ugly and recoverable; holding the rest of the answer behind it is not.
  const heard = spoken(['<workspace-action action="open-file" path="a.ts"', " and there it is."]);
  assert.ok(heard.includes("and there it is."));
});

/* ── every action of the turn, in order ──────────────────────────────────── */

test('"open the readme and then open package.json" runs both, in that order', () => {
  // Regressing means the second half of the sentence is parsed and dropped:
  // the readme opens, package.json does not, and she says she opened both.
  const reply = [
    '<workspace-action action="open-file" path="README.md" />',
    '<workspace-action action="open-file" path="package.json" />',
    "Opened the readme and package.json.",
  ].join("\n");

  const tags = parseWorkspaceTags(reply);
  assert.equal(tags.length, 2);
  assert.deepEqual(tags.map((tag) => tag.path), ["README.md", "package.json"]);
  // "and then" is an order the operator stated. The last one asked for is the
  // tab that ends up in front, so the order of execution is the feature.
  assert.equal(tags[1].path, "package.json");
});

test("the attributes are read by name, not by position", () => {
  // The old regex pinned `action` before `path`, so a tag written the other way
  // round did nothing at all and the operator got a confirmation for it anyway.
  const tags = parseWorkspaceTags(
    `<workspace-action path="/tmp/x.ts" action="open-file" />` +
      `<workspace-action ACTION='reveal' PATH='/tmp/src' />`,
  );
  assert.deepEqual(
    tags.map((tag) => [tag.action, tag.path]),
    [["open-file", "/tmp/x.ts"], ["reveal", "/tmp/src"]],
  );
});

test("a tag with no action attribute is not an action", () => {
  assert.deepEqual(parseWorkspaceTags('<workspace-action path="/tmp/x.ts" />'), []);
  assert.deepEqual(parseWorkspaceTags("nothing to see here"), []);
  assert.deepEqual(parseWorkspaceTags(""), []);
});

/* ── closing ─────────────────────────────────────────────────────────────── */

test('"close that file" and "close this tab" mean the tab in front', () => {
  // Both sentences reach the same tag. A close-file with no path is the active
  // tab: with no file named, "that file" is the one the operator is looking at.
  const [scoped] = parseWorkspaceTags('<workspace-action action="close-file" scope="active" />');
  assert.equal(scoped.action, "close-file");
  assert.equal(scoped.scope, "active");
  assert.equal(scoped.path, null);

  const [bare] = parseWorkspaceTags('<workspace-action action="close-file" />');
  assert.equal(bare.action, "close-file");
  assert.equal(bare.path, null);
});

test('"close everything" closes every tab, and a named file closes only that one', () => {
  const [all] = parseWorkspaceTags('<workspace-action action="close-file" scope="all" />');
  assert.equal(all.scope, "all");

  const [named] = parseWorkspaceTags('<workspace-action action="close-file" path="src/app.ts" />');
  assert.equal(named.path, "src/app.ts");
  assert.equal(named.scope, null);
});

/* ── what is already open ────────────────────────────────────────────────── */

test('"open the file I was just editing" has something to resolve against', () => {
  // Without this block the model holds only the workspace root, guesses a path,
  // opens a read error, and she confirms the open regardless.
  const context = describeOpenEditors(
    { activePath: `${ROOT}/studio/src/App.tsx`, openPaths: [`${ROOT}/README.md`, `${ROOT}/studio/src/App.tsx`] },
    ROOT,
  );
  assert.match(context, /Open Tabs \(2\): README\.md, studio\/src\/App\.tsx/);
  assert.match(context, /Active File: studio\/src\/App\.tsx/);
  // Relative to the workspace, because the absolute prefix is the same on every
  // line and this prompt is spoken from, not scrolled.
  assert.ok(!context.includes(ROOT));
});

test("the tab list is capped, and says how many it did not name", () => {
  const many = Array.from({ length: 12 }, (_, index) => `${ROOT}/src/file${index}.ts`);
  const context = describeOpenEditors({ activePath: many[0], openPaths: many }, ROOT);
  const named = context.split("\n")[0].split(", ").filter((part) => part.includes("file")).length;
  assert.equal(named, OPEN_TABS_LIMIT);
  assert.match(context, /\+6 more/);
  // It is context for one spoken sentence. Twelve absolute paths would cost
  // more window than the rest of the prompt together.
  assert.ok(context.length < 400, `context is ${context.length} chars`);
});

test("nothing open says so, rather than saying nothing", () => {
  // A model told "Open Tabs: none" asks which file. A model told nothing at all
  // invents one.
  assert.equal(describeOpenEditors({ openPaths: [] }, ROOT), "Open Tabs: none");
  assert.equal(describeOpenEditors(null, ROOT), "Open Tabs: none");
  assert.match(describeOpenEditors({ activePath: `${ROOT}/a.ts`, openPaths: [] }, ROOT), /Active File: a\.ts/);
});

test("a file outside the workspace keeps the path that can be handed back", () => {
  // A relative path that climbs out of the root is not a name the model can
  // emit in a tag, so anything outside stays absolute.
  const context = describeOpenEditors({ activePath: "/etc/hosts", openPaths: ["/etc/hosts"] }, ROOT);
  assert.match(context, /\/etc\/hosts/);
});

/* ── the engine's half of the wiring ─────────────────────────────────────── */

test("the engine strips the tags off the text it completes with", async () => {
  const engine = await read("services/frontierEngine.ts");
  // The voice bridge overwrites everything onToken streamed with `fullText` and
  // hands that to the speech path, so this line is the one that decides whether
  // the markup is read aloud.
  assert.match(engine, /fullText: stripWorkspaceTags\(accumulated\)/);
  // And the stream side, so nothing is said before completion either.
  assert.match(engine, /const stripper = createTagStripper\(\);/);
  assert.match(engine, /const speakable = stripper\.push\(data\.delta\.text\);/);
  assert.match(engine, /const tail = stripper\.flush\(\);/);
});

test("the engine executes every tag rather than the first one", async () => {
  const engine = await read("services/frontierEngine.ts");
  assert.match(engine, /for \(const tag of parseWorkspaceTags\(accumulated\)\)/);
  // The non-global `.match` that ran one action per turn is gone for good.
  assert.ok(!/accumulated\.match\(\/<workspace-action/.test(engine));
});

test("the spoken prompt teaches the close verb and forbids reading tags aloud", async () => {
  const engine = await read("services/frontierEngine.ts");
  const voice = engine.slice(engine.indexOf("Your name is Temy, the real-time voice assistant"));
  const prompt = voice.slice(0, voice.indexOf("Recent Workspaces:"));

  assert.match(prompt, /action="close-file" scope="active"/);
  assert.match(prompt, /action="close-file" path=/);
  assert.match(prompt, /action="close-file" scope="all"/);
  // The sentences the operator actually says, so the model maps them itself.
  assert.match(prompt, /close that file/i);
  assert.match(prompt, /close all tabs/i);
  // A confirmation without the tag is the lie that started this.
  assert.match(prompt, /Never say a file was closed without emitting the tag/);
  assert.match(prompt, /Never read a tag, a path attribute or an angle bracket aloud/);
});

test("the spoken prompt carries the open tabs, and only the spoken one does", async () => {
  const engine = await read("services/frontierEngine.ts");
  assert.match(engine, /const read = isVoice \? options\.capabilities\?\.openEditors : undefined;/);
  assert.match(engine, /describeOpenEditors\(read\(\), currentPath\)/);
  // It is interpolated into the voice prompt, after the workspace block.
  const voice = engine.slice(engine.indexOf("Your name is Temy, the real-time voice assistant"));
  assert.match(voice.slice(0, voice.indexOf("`\n    : `")), /\$\{editorContext\}/);
  // A host that cannot answer must not cost the operator the turn.
  assert.match(engine, /try \{\n      return describeOpenEditors/);
});
