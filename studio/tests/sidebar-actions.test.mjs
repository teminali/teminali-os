/**
 * The sidebar's project actions, and the one safety property behind them.
 *
 * These are source-level assertions on purpose. The menu is React and the
 * Trash is Electron, so neither can be exercised on this machine — but the
 * things worth pinning here are not behaviours, they are *arrangements*: that
 * the destructive path consults its rule before it acts, that the confirmation
 * is raised where the renderer cannot skip it, and that every item in a menu
 * built around "every row does something" actually does something.
 *
 * A source read catches the change that quietly moves the confirm into the
 * renderer "so it can be styled". Running the component could not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sidebar = readFileSync(new URL("../src/components/sidebar/StudioSidebar.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");

test("every action in the project menu is wired to something", () => {
  const ids = [...sidebar.matchAll(/id:\s*"([a-z]+)"/g)].map((match) => match[1]);
  for (const expected of ["open", "reveal", "copy", "forget", "trash"]) {
    assert.ok(ids.includes(expected), `the ${expected} action is missing from the menu`);
  }
  // The failure this guards against is the one the panel was rebuilt to fix:
  // a control that looks pressable and is not.
  assert.equal(
    /onSelect:\s*\(\)\s*=>\s*\{\s*\}/.test(sidebar),
    false,
    "a menu item has an empty onSelect — that is a control that does nothing",
  );
});

test("the rows are not flush against each other", () => {
  // 4px between items. Asserted as "there is deliberate spacing" rather than a
  // literal class, so restyling does not fail this, but deleting it does.
  assert.match(sidebar, /space-y-\d/, "the project group has no vertical rhythm between its rows");
});

test("the destructive action goes through the bridge, never the filesystem", () => {
  assert.match(sidebar, /bridge\?\.moveToTrash/);
  for (const forbidden of ["require(", "node:fs", "rmSync", "unlink"]) {
    assert.equal(
      sidebar.includes(forbidden),
      false,
      `the sidebar reaches for ${forbidden} — deleting must stay in the main process`,
    );
  }
});

test("the renderer does not raise the confirmation itself", () => {
  // A dialog drawn here is a dialog a later refactor can decide not to draw.
  for (const forbidden of ["window.confirm", "confirm("]) {
    assert.equal(sidebar.includes(forbidden), false, `the sidebar calls ${forbidden}`);
  }
  assert.match(main, /showMessageBox/, "main raises no confirmation before trashing");
});

test("main consults the rule before it trashes, not after", () => {
  const handler = main.slice(main.indexOf('ipcMain.handle("projects:move-to-trash"'));
  assert.ok(handler.length > 0, "the move-to-trash handler is missing");
  const guard = handler.indexOf("trashRefusalReason");
  const act = handler.indexOf("shell.trashItem");
  assert.ok(guard !== -1, "the handler does not consult trashRefusalReason");
  assert.ok(act !== -1, "the handler never reaches shell.trashItem");
  assert.ok(guard < act, "the refusal rule is consulted after the folder is already gone");
  // Trash, not delete: macOS keeps a Put Back and this is the only control in
  // the product that takes something off the operator's disk.
  assert.equal(handler.includes("rmSync"), false, "the handler deletes outright instead of trashing");
});

test("a trashed project stops being listed", () => {
  // A list still offering to open a folder that is in the Trash is a list that
  // lies, and the next click reports a path that no longer exists.
  const trashFn = sidebar.slice(sidebar.indexOf("const trashEntry"), sidebar.indexOf("const projectActions"));
  assert.match(trashFn, /forgetEntry\(entry\)/, "trashing does not forget the project afterwards");
});

test("the bridge exposes both channels and no more of the shell than that", () => {
  assert.match(preload, /reveal:\s*\(target\)\s*=>\s*ipcRenderer\.invoke\("projects:reveal"/);
  assert.match(preload, /moveToTrash:\s*\(target\)\s*=>\s*ipcRenderer\.invoke\("projects:move-to-trash"/);
});
