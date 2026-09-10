import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readTrigger, scoreMatch } from "../src/utils/composerTrigger.ts";

/**
 * The composer's placeholder advertises "/ for skills, @ for context". These
 * pin the two rules that decide whether that feels like an editor or like a
 * menu that keeps interrupting you.
 */

test("a trigger opens at the start of a token", () => {
  assert.deepEqual(readTrigger("/", 1), { kind: "skill", at: 0, query: "" });
  assert.deepEqual(readTrigger("@", 1), { kind: "file", at: 0, query: "" });
  assert.deepEqual(readTrigger("look at @App", 12), { kind: "file", at: 8, query: "App" });
});

test("punctuation inside a word is not a trigger", () => {
  // The single most annoying failure mode: a menu popping open every time you
  // type a path or an email address.
  assert.equal(readTrigger("src/App.tsx", 11), null);
  assert.equal(readTrigger("user@host.com", 13), null);
  assert.equal(readTrigger("a/b", 3), null);
});

test("a space closes the trigger", () => {
  assert.equal(readTrigger("@App and then", 13), null);
  assert.equal(readTrigger("/skill ", 7), null);
});

test("a newline closes the trigger", () => {
  assert.equal(readTrigger("@App\nnext line", 14), null);
});

test("the trigger tracks the caret, not the end of the text", () => {
  // Typing in the middle of an existing prompt must open the menu for the
  // token under the caret, not for something later in the string.
  const value = "@Rea and @Other";
  assert.deepEqual(readTrigger(value, 4), { kind: "file", at: 0, query: "Rea" });
});

test("deleting back past the trigger character closes the menu", () => {
  assert.deepEqual(readTrigger("@a", 2), { kind: "file", at: 0, query: "a" });
  assert.deepEqual(readTrigger("@", 1), { kind: "file", at: 0, query: "" });
  assert.equal(readTrigger("", 0), null);
});

test("matching is a subsequence, the way a file picker behaves", () => {
  assert.ok(scoreMatch("src/App.tsx", "sAT") !== null, "sAT should find src/App.tsx");
  assert.ok(scoreMatch("src/App.tsx", "app") !== null);
  assert.equal(scoreMatch("src/App.tsx", "zzz"), null);
  assert.equal(scoreMatch("anything", ""), 0, "an empty query matches everything equally");
});

test("the obvious answer ranks first", () => {
  const query = "app";
  const exact = scoreMatch("App.tsx", query);
  const buried = scoreMatch("src/components/wrapper/unrelated-appendix.ts", query);
  assert.ok(exact !== null && buried !== null);
  assert.ok(exact > buried, "a start-of-segment match beats one buried mid-word");
});

test("consecutive characters score above scattered ones", () => {
  const together = scoreMatch("readme.md", "read");
  const scattered = scoreMatch("r-e-a-d-me.md", "read");
  assert.ok(together !== null && scattered !== null);
  assert.ok(together > scattered);
});

/* ── Wired to the composer people actually type into ───────────────────────
   The menu, its trigger rules and every test above passed for six sessions
   against `chat/Composer.tsx`, which the voice stage replaced: the live box is
   `voice/TemiComposer.tsx` and its only key handler was Enter. Porting it is
   what made the placeholder's promise true again, and these guard the port. */

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the live composer mounts the menu and gives it the keyboard", async () => {
  const composer = await readSource("../src/components/voice/TemiComposer.tsx");
  assert.match(composer, /<ComposerMenu/, "the menu is mounted");
  assert.match(composer, /readTrigger\(element\.value/, "the trigger is read off the caret");
  // Arrows move, Enter and Tab accept, Escape closes — and while it is open
  // Enter must not send a half-written prompt.
  assert.match(composer, /if \(trigger && menuItems\.length > 0\) \{[\s\S]*?"ArrowDown"/);
  assert.match(composer, /if \(trigger && menuItems\.length > 0\) \{[\s\S]*?event\.key === "Enter" \|\| event\.key === "Tab"/);
  assert.match(composer, /if \(trigger && menuItems\.length > 0\) \{[\s\S]*?"Escape"[\s\S]*?setTrigger\(null\)/);
});

test("a skill is mounted and a file is pasted as an @-path", async () => {
  const composer = await readSource("../src/components/voice/TemiComposer.tsx");
  assert.match(composer, /if \(skill\) setSkill\(skill\)/, "a skill changes the next turn, it is not typed");
  assert.match(composer, /onChange\(`\$\{before\}@\$\{item\.id\} \$\{after\}`\)/, "a file goes in as context");
});

test("Up recalls a prompt, but only where the arrow has nothing else to do", async () => {
  const composer = await readSource("../src/components/voice/TemiComposer.tsx");
  assert.match(composer, /atFirstLine\(value, caret\) : atLastLine\(value, caret\)/);
  assert.match(composer, /onNavigateHistory\(event\.key === "ArrowUp" \? "older" : "newer", value\)/);
  // The ring is the stage's, because this component is remounted when the
  // empty screen becomes a conversation.
  const stage = await readSource("../src/components/voice/TemiVoiceStage.tsx");
  assert.match(stage, /const historyRef = useRef<PromptHistory>\(EMPTY_HISTORY\)/);
  assert.match(stage, /historyRef\.current = remember\(historyRef\.current, text\)/, "sending records the prompt");
  assert.match(stage, /historyRef\.current = stopBrowsing\(historyRef\.current\)/, "typing leaves the ring");
});

test("a second prompt queues; it does not kill the run in flight", async () => {
  const bridge = await readSource("../src/services/voice/teminaliAgentBridge.ts");
  assert.doesNotMatch(
    bridge,
    /static async delegateTask[\s\S]{0,400}?this\.activeController\?\.abort\(\)/,
    "delegateTask no longer opens by aborting whatever was running",
  );
  assert.match(bridge, /if \(this\.activeController\) \{[\s\S]*?enqueueTask</);
  assert.match(bridge, /private static drain\(\)/, "and starts the next one when the slot frees");
  // A stop means stop. Draining after one would start the next item instead.
  assert.match(bridge, /static stopCurrentTask\(\) \{[\s\S]*?this\.queue = \[\];/);
});
