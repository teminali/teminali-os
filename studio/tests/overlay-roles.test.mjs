import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { OVERLAY_ROLES } from "../src/services/browserView.ts";

/*
  A modal that carries no role is a modal the browser panel cannot see.

  The panel's page is a `WebContentsView`: it is composited above the whole
  document, so nothing in the DOM can be drawn on top of it. `isOverlayOpen`
  is what hides it, and it asks the document for a role rather than taking a
  flag from every store that can open an overlay. That is the cheaper design
  and it has one failure mode — an overlay that forgets the role is simply not
  seen, and the operator gets a web page over their settings.

  It has happened twice for two different reasons. `SettingsPage` (then `CursorSettingsModal`) and
  `DiffInspectorModal` carried no role at all. `MediaConsentModal` carried the
  right one, `alertdialog`, and the selector only looked for `dialog` — so the
  one prompt where being covered actually matters, the camera and microphone
  request, was covered.

  Neither is reachable from a suite with no DOM, so this reads the source. A
  dimming backdrop — `fixed inset-0` with a `bg-black/` wash — is the shape of
  something drawn over the whole app, and every one of them must name a role
  the selector matches.
*/

const COMPONENTS = new URL("../src/components/", import.meta.url).pathname;

function tsxFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** A full-screen dimming backdrop: what an app-modal overlay looks like. */
const BACKDROP = /className="[^"]*\bfixed inset-0\b[^"]*\bbg-black\/[^"]*"/;

test("every app-modal overlay names a role the browser panel watches for", () => {
  const roles = OVERLAY_ROLES.map((role) => `role="${role}"`);
  const naked = [];

  for (const path of tsxFiles(COMPONENTS)) {
    const source = readFileSync(path, "utf8");
    if (!BACKDROP.test(source)) continue;
    if (!roles.some((role) => source.includes(role))) {
      naked.push(path.slice(COMPONENTS.length));
    }
  }

  assert.deepEqual(
    naked,
    [],
    `These draw a dimming backdrop over the whole app but name no overlay role, ` +
      `so the browser panel's page stays on top of them: ${naked.join(", ")}`
  );
});

test("the overlay roles cover both spellings of a modal, and menus", () => {
  // `alertdialog` is not matched by `[role="dialog"]`. Dropping it from this
  // list silently uncovers every prompt that uses it.
  for (const role of ["dialog", "alertdialog", "menu"]) {
    assert.ok(OVERLAY_ROLES.includes(role), `${role} must be treated as an overlay`);
  }
});

test("the selector is built from the role list rather than written out again", () => {
  // A second hardcoded selector is how `alertdialog` went missing the first
  // time: the list said one thing and the query did another.
  const source = readFileSync(new URL("../src/services/browserView.ts", import.meta.url), "utf8");
  const query = source.match(/document\.querySelector\(([^)]*)\)/);
  assert.ok(query, "isOverlayOpen must still ask the document");
  assert.equal(query[1].trim(), "OVERLAY_SELECTOR", "the query must use the derived selector");
});
