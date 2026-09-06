import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/*
  The module requires `electron` for `Menu`/`MenuItem`, which is not loadable
  under plain node. Only the template builder is under test and it touches
  none of them, so a stub is enough — and keeping the builder free of Electron
  is exactly what makes the shape of this menu checkable at all.
*/
require.cache[require.resolve("electron")] = {
  id: "electron", filename: "electron", loaded: true,
  exports: { Menu: class {}, MenuItem: class {}, clipboard: {}, shell: {} },
};
const { contextMenuTemplate } = require(path.join(here, "..", "electron", "contextMenu.cjs"));

const labels = (template) => template.map((item) => item.label ?? item.role ?? item.type);

/**
 * Electron ships no context menu, so right-clicking the editor did nothing at
 * all. What is pinned here is that every kind of right-click produces a menu
 * with something true in it — an empty menu is the bug this replaced.
 */

test("a text field offers the editing roles", () => {
  const template = contextMenuTemplate({ isEditable: true, selectionText: "" });
  const roles = template.map((item) => item.role).filter(Boolean);
  for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
    assert.ok(roles.includes(role), `${role} is missing`);
  }
});

test("a misspelling puts its guesses first, above the generic half", () => {
  const template = contextMenuTemplate({
    isEditable: true,
    misspelledWord: "recieve",
    dictionarySuggestions: ["receive", "relieve"],
  });
  assert.equal(template[0].label, "receive");
  assert.ok(labels(template).includes("Add to Dictionary"));
  // The reason they right-clicked comes before Cut and Copy.
  assert.ok(template.findIndex((i) => i.label === "receive") < template.findIndex((i) => i.role === "cut"));
});

test("a misspelling with no guesses says so rather than showing nothing", () => {
  const template = contextMenuTemplate({ isEditable: true, misspelledWord: "qqqq", dictionarySuggestions: [] });
  assert.equal(template[0].label, "No guesses found");
  assert.equal(template[0].enabled, false);
});

test("a selection can be copied and searched; a read-only pane cannot be pasted into", () => {
  const template = contextMenuTemplate({ isEditable: false, selectionText: "  ripgrep  " });
  const roles = template.map((item) => item.role).filter(Boolean);
  assert.ok(roles.includes("copy"));
  assert.equal(roles.includes("paste"), false);
  assert.ok(labels(template).some((label) => String(label).includes("Search Google for")));
});

test("a long selection is trimmed so the label stays a label", () => {
  const template = contextMenuTemplate({ isEditable: false, selectionText: "x".repeat(200) });
  const search = template.find((item) => String(item.label).startsWith("Search Google"));
  assert.ok(search.label.length < 60, search.label);
  assert.ok(search.label.includes("…"));
});

test("links and images offer what is under the cursor", () => {
  const link = contextMenuTemplate({ linkURL: "https://example.com/a" });
  assert.ok(labels(link).includes("Open Link in Browser"));
  assert.ok(labels(link).includes("Copy Link Address"));

  const image = contextMenuTemplate({ hasImageContents: true, srcURL: "https://example.com/a.png" });
  assert.ok(labels(image).includes("Copy Image"));
  assert.ok(labels(image).includes("Copy Image Address"));
});

test("navigation is offered on a browser page and nowhere else", () => {
  const page = contextMenuTemplate({ selectionText: "" }, { isBrowserPage: true, canGoBack: true });
  const back = page.find((item) => item.label === "Back");
  assert.equal(back.enabled, true);
  assert.equal(page.find((item) => item.label === "Forward").enabled, false);

  // The shell's own window has one document; a Back there would do nothing,
  // and a control that does nothing is not offered.
  const shellWindow = contextMenuTemplate({ selectionText: "" });
  assert.equal(labels(shellWindow).includes("Back"), false);
});

test("a right-click on nothing still offers something true", () => {
  const template = contextMenuTemplate({});
  assert.ok(template.length > 0, "an empty menu is the bug this replaced");
  assert.ok(template.some((item) => item.role === "selectAll"));
});

test("no two separators ever sit together, and none leads the menu", () => {
  for (const params of [
    { isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the"] },
    { isEditable: false, selectionText: "x", linkURL: "https://a.test", hasImageContents: true, srcURL: "https://a.test/i.png" },
    {},
  ]) {
    const template = contextMenuTemplate(params, { isBrowserPage: true });
    assert.notEqual(template[0]?.type, "separator");
    for (let i = 1; i < template.length; i += 1) {
      assert.ok(!(template[i].type === "separator" && template[i - 1].type === "separator"), "double separator");
    }
  }
});
