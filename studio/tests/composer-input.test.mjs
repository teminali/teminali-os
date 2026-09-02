import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The composer must always have a field in it.
 *
 * This is a regression test for a bug that made the empty state — the surface
 * every new chat opens on — impossible to type into. The tall variant rendered
 * its textarea under `tall && (value || !tall)`, which for a tall composer
 * reduces to `tall && value`: no value, no field, and no keystroke could ever
 * create one because there was nothing to press a key into.
 *
 * The component is .tsx and the node test runner cannot import JSX, so this
 * reads the source. That is a weaker check than mounting it, and it is chosen
 * deliberately over no check at all: the failure mode here is total (the
 * primary input of the application does not exist) and cheap to assert against.
 */

const composerPath = new URL("../src/components/chat/Composer.tsx", import.meta.url);

test("the tall composer renders its field whether or not it has a value", async () => {
  const source = await readFile(composerPath, "utf8");

  // The exact shape of the bug: a render condition on `tall` that also requires
  // a value. Any expression gating the field on `value` is the same defect
  // wearing different parentheses.
  assert.doesNotMatch(
    source,
    /\{\s*tall\s*&&\s*\(\s*value\s*\|\|/,
    "the tall field must not be gated on already having a value",
  );

  // And the positive statement: `tall` alone mounts it.
  assert.match(source, /\{tall\s*&&\s*\(/, "the tall variant must render on `tall` alone");
});

test("both composer variants own a textarea, and both are the same field", async () => {
  const source = await readFile(composerPath, "utf8");

  const textareas = source.match(/<textarea\b/g) ?? [];
  assert.equal(textareas.length, 2, "one field for the tall variant, one for the follow-up bar");

  // Both must carry the ref, or focus, autoFocus and the auto-grow effect
  // silently apply to whichever one happened to mount.
  const refs = source.match(/ref=\{areaRef\}/g) ?? [];
  assert.equal(refs.length, 2, "every field is the ref'd field");
});

test("the two variants are mutually exclusive, so there is never a second caret", async () => {
  const source = await readFile(composerPath, "utf8");
  assert.match(source, /\{!tall\s*&&\s*\(/, "the follow-up field renders only when not tall");
});

test("a field with no visible placeholder still names itself for a screen reader", async () => {
  const source = await readFile(composerPath, "utf8");
  // The tall variant draws its placeholder as a separate line, so the field
  // itself has no placeholder attribute to be read out.
  assert.match(source, /aria-label=\{placeholder\}/);
});

test("the placeholder never swallows the click meant for the field", async () => {
  const source = await readFile(composerPath, "utf8");
  const placeholderLine = /<p className="absolute[^"]*text-ink-placeholder[^"]*"/.exec(source);
  assert.ok(placeholderLine, "the tall placeholder is drawn over the field");
  assert.match(placeholderLine[0], /pointer-events-none/);
});
