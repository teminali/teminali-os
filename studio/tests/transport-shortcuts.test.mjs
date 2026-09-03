import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* ── The transport's labels are its specification ───────────────────────────
   Every transport button names its shortcut in `title` / `aria-label`, and
   for a long while not one of those keys was bound anywhere in `src/` — the
   buttons advertised a keyboard the editor did not have. DESIGN.md forbids an
   affordance that does nothing, so these tests read the claims out of the
   markup and insist the hook answers each one. Adding a new `(Key)` to a
   title without binding it fails here, which is the only way the two stay
   honest with each other.
   ───────────────────────────────────────────────────────────────────────── */

const controlsPath = new URL(
  "../src/video/components/preview/PlaybackControls.tsx",
  import.meta.url,
);
const hookPath = new URL(
  "../src/video/hooks/useTransportShortcuts.ts",
  import.meta.url,
);
const panePath = new URL(
  "../src/components/workspace/panels/VideoPane.tsx",
  import.meta.url,
);

/** What a label calls a key, and the `event.key` values that satisfy it. */
const KEY_ALIASES = {
  Space: ["' '"],
  Home: ["'Home'"],
  End: ["'End'"],
  "←": ["'ArrowLeft'"],
  "→": ["'ArrowRight'"],
  M: ["'m'", "'M'"],
  I: ["'i'", "'I'"],
  L: ["'l'", "'L'"],
};

const claimedKeys = async () => {
  const source = await readFile(controlsPath, "utf8");
  const claims = [...source.matchAll(/title="[^"]*\(([^)]+)\)"/g)].map((m) => m[1]);
  return [...new Set(claims)];
};

test("every shortcut the transport advertises is one this file knows", async () => {
  const keys = await claimedKeys();

  // A guard on the guard: a label may not invent a key the test cannot check.
  for (const key of keys) {
    assert.ok(
      key in KEY_ALIASES,
      `PlaybackControls advertises "(${key})" but this test has no mapping for it — ` +
        `add it to KEY_ALIASES and bind it in useTransportShortcuts.ts`,
    );
  }

  // And the transport is expected to keep offering a keyboard at all.
  assert.ok(keys.length >= 8, `expected the eight transport keys, found ${keys.length}`);
});

test("every advertised shortcut is bound in useTransportShortcuts", async () => {
  const [keys, hook] = await Promise.all([claimedKeys(), readFile(hookPath, "utf8")]);

  for (const key of keys) {
    for (const alias of KEY_ALIASES[key]) {
      assert.match(
        hook,
        new RegExp(`case ${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
        `"(${key})" is advertised by a transport button but ${alias} is not handled`,
      );
    }
  }
});

test("the hook is mounted, and scoped to the editor pane", async () => {
  const pane = await readFile(panePath, "utf8");

  assert.match(pane, /import \{ useTransportShortcuts \}/);
  // Bound to the pane's own element, so focus outside the editor is ignored.
  assert.match(pane, /useTransportShortcuts\(paneRef\)/);
});

test("the shortcuts stand down for typing, dialogs and modifier keys", async () => {
  const hook = await readFile(hookPath, "utf8");

  // A `<select>` counts as a typing target — that is what leaves the rate
  // picker's own arrow-key handling alone.
  assert.match(hook, /TYPING_TAGS\s*=\s*\/\^\(input\|textarea\|select\)\$\/i/);
  assert.match(hook, /isContentEditable/);
  assert.match(hook, /querySelector\('\[role="dialog"\]'\)/);
  assert.match(hook, /event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey/);
  // Focus outside the pane belongs to whatever holds it.
  assert.match(hook, /!root\.contains\(target\)/);
});

test("the keyboard and the buttons run the same frame step", async () => {
  const [controls, hook] = await Promise.all([
    readFile(controlsPath, "utf8"),
    readFile(hookPath, "utf8"),
  ]);

  assert.match(hook, /export function stepPlayheadByFrames/);
  // The buttons import it rather than keeping a second copy that can drift.
  assert.match(controls, /import \{ stepPlayheadByFrames \}/);
  assert.match(controls, /stepPlayheadByFrames\(-1\)/);
  assert.match(controls, /stepPlayheadByFrames\(1\)/);
  assert.doesNotMatch(controls, /const stepFrame =/);
});
