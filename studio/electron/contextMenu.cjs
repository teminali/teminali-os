/* ─────────────────────────────────────────────────────────────────────────────
   The right-click menu.

   Electron ships **no** context menu. Not a reduced one — none: right-clicking
   a text field in an Electron app does nothing at all unless the application
   builds the menu itself. So the editor had no Copy, and neither did the
   composer, the terminal, the file tree or a page in the browser panel. It
   read as the editor being unfinished; it was the whole app missing a feature
   nobody had noticed was ours to provide.

   One handler, attached to every `webContents` this app owns, rather than a
   React menu per surface. Three reasons, in order of weight:

   - **Roles, not handlers.** `{ role: "copy" }` is the operating system's own
     copy: it respects the focused element, the platform shortcut, and the
     clipboard permissions that a `document.execCommand` shim does not. A menu
     drawn in the renderer would have to reimplement each one and would get
     `paste` wrong, because a renderer cannot read the clipboard unprompted.
   - **The browser panel is not in our document.** Its pages are separate
     `webContents`, so a React menu could never appear over one. This attaches
     to those too.
   - **Spelling comes free.** Chromium already knows which word is misspelled
     and what it should be; `params.dictionarySuggestions` is that knowledge,
     and it cannot be reached from the renderer at all.

   The menu is built per invocation from `params`, because what is under the
   cursor is what decides it: a link is not a selection is not an image.
   ───────────────────────────────────────────────────────────────────────── */

const { Menu, MenuItem, clipboard, shell } = require("electron");

/*
  Which engine "Search … for" means.

  Module state, and set from one place: the renderer owns the preference and
  publishes it to main (see browserView.cjs, `browser-view:search-engine`).
  Held here rather than passed through every `attachContextMenu` call so that
  the shell's own menu and the browser page's menu cannot disagree — they are
  the same offer, and the operator picked once.

  Google is the default because it is the default in `utils/searchEngines.ts`;
  the two would only differ in the moment before the renderer has spoken.
*/
let searchEngine = { name: "Google", query: "https://www.google.com/search?q=" };

/**
 * Point the search item at another engine.
 *
 * Validated rather than trusted: this arrives over IPC, and a query prefix
 * that is not an https URL would turn a menu item into a way to make main open
 * an arbitrary scheme.
 */
function setSearchEngine(engine) {
  const name = typeof engine?.name === "string" ? engine.name.trim() : "";
  const query = typeof engine?.query === "string" ? engine.query : "";
  if (!name || !/^https:\/\/[^\s]+$/.test(query)) return false;
  searchEngine = { name, query };
  return true;
}

/** Trim a phrase down to something that fits in a menu label. */
function ellipsis(text, max = 32) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Build the menu for one right-click.
 *
 * Exported for its own sake: the shape of this menu is a decision, and a
 * decision that can only be checked by right-clicking in a running app is one
 * nobody checks. Takes plain `params` and returns a plain template.
 */
function contextMenuTemplate(params, { canGoBack = false, canGoForward = false, isBrowserPage = false } = {}) {
  const template = [];
  const push = (item) => template.push(item);
  const separate = () => {
    if (template.length > 0 && template[template.length - 1].type !== "separator") push({ type: "separator" });
  };

  const selection = String(params.selectionText ?? "").trim();
  const editable = Boolean(params.isEditable);

  /*
    Spelling first, and above everything.

    A misspelling is the one thing the operator right-clicked *at* rather than
    near — putting the suggestions under Cut and Copy would mean scanning past
    the generic half of the menu to reach the reason they opened it.
  */
  if (editable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions ?? []).slice(0, 5);
    if (suggestions.length === 0) {
      push({ label: "No guesses found", enabled: false });
    } else {
      for (const word of suggestions) push({ label: word, spellingSuggestion: word });
    }
    separate();
    push({ label: "Add to Dictionary", addToDictionary: params.misspelledWord });
    separate();
  }

  if (editable) {
    push({ role: "undo" });
    push({ role: "redo" });
    separate();
    push({ role: "cut" });
    push({ role: "copy" });
    push({ role: "paste" });
    // The one paste worth having twice: pasting a styled fragment into a code
    // editor should not carry the styling, and on macOS this is the shortcut
    // people already reach for.
    push({ role: "pasteAndMatchStyle", label: "Paste and Match Style" });
    push({ role: "selectAll" });
  } else if (selection) {
    push({ role: "copy" });
    push({ role: "selectAll" });
  } else if (!params.linkURL && !params.hasImageContents) {
    // Nothing under the cursor and nothing selected. Select All is still true
    // and still useful; an empty menu is not.
    push({ role: "selectAll" });
  }

  if (params.linkURL) {
    separate();
    push({ label: "Open Link in Browser", openExternal: params.linkURL });
    push({ label: "Copy Link Address", copyText: params.linkURL });
  }

  if (params.hasImageContents) {
    separate();
    push({ role: "copyImage", label: "Copy Image" });
    if (params.srcURL) push({ label: "Copy Image Address", copyText: params.srcURL });
  }

  /*
    Navigation, only on a page that has any.

    The application's own window has no "back" that means anything — its
    history is one document — so offering it there would be a control that
    does nothing, which §2 forbids. A page in the browser panel genuinely has
    one, and reaching it by right-click is how people navigate.
  */
  if (isBrowserPage) {
    separate();
    push({ label: "Back", enabled: canGoBack, navigate: "back" });
    push({ label: "Forward", enabled: canGoForward, navigate: "forward" });
    push({ label: "Reload", navigate: "reload" });
  }

  if (selection && !editable) {
    separate();
    push({ label: `Search ${searchEngine.name} for “${ellipsis(selection)}”`, search: selection });
  }

  return template;
}

/**
 * Attach the menu to one `webContents`.
 *
 * `openInPanel` is how a search or a link becomes a page in the operator's own
 * browser panel rather than in Safari — passed in rather than imported, so
 * this module stays a menu and knows nothing about panels.
 */
function attachContextMenu(contents, { isBrowserPage = false, openInPanel = null, allowInspect = false } = {}) {
  if (!contents || contents.isDestroyed()) return;

  contents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params, {
      isBrowserPage,
      canGoBack: contents.navigationHistory?.canGoBack?.() ?? false,
      canGoForward: contents.navigationHistory?.canGoForward?.() ?? false,
    });

    const menu = new Menu();
    for (const item of template) {
      if (item.spellingSuggestion) {
        menu.append(new MenuItem({
          label: item.label,
          click: () => contents.replaceMisspelling(item.spellingSuggestion),
        }));
        continue;
      }
      if (item.addToDictionary) {
        menu.append(new MenuItem({
          label: item.label,
          click: () => contents.session.addWordToSpellCheckerDictionary(item.addToDictionary),
        }));
        continue;
      }
      if (item.copyText) {
        menu.append(new MenuItem({ label: item.label, click: () => clipboard.writeText(item.copyText) }));
        continue;
      }
      if (item.openExternal) {
        menu.append(new MenuItem({ label: item.label, click: () => void shell.openExternal(item.openExternal) }));
        continue;
      }
      if (item.navigate) {
        menu.append(new MenuItem({
          label: item.label,
          enabled: item.enabled !== false,
          click: () => {
            if (item.navigate === "back") contents.navigationHistory?.goBack?.();
            else if (item.navigate === "forward") contents.navigationHistory?.goForward?.();
            else contents.reload();
          },
        }));
        continue;
      }
      if (item.search) {
        const url = `${searchEngine.query}${encodeURIComponent(item.search)}`;
        menu.append(new MenuItem({
          label: item.label,
          click: () => (openInPanel ? openInPanel(url) : void shell.openExternal(url)),
        }));
        continue;
      }
      menu.append(new MenuItem(item));
    }

    // Only in a build the operator did not install: an Inspect Element in a
    // shipped app is a door into a window that was never meant to have one.
    if (allowInspect) {
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(new MenuItem({
        label: "Inspect Element",
        click: () => contents.inspectElement(params.x, params.y),
      }));
    }

    if (menu.items.length > 0) menu.popup();
  });
}

module.exports = { attachContextMenu, contextMenuTemplate, setSearchEngine };
