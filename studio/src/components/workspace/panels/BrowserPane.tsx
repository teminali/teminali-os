import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Camera,
  Cookie,
  ExternalLink,
  EyeOff,
  Globe,
  HardDrive,
  House,
  Import,
  KeyRound,
  MoreHorizontal,
  RotateCw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { IconButton, Menu } from "../../ui";
import { BrowserHome, Mark } from "./BrowserHome";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { addressLabel, normaliseAddress } from "../../../utils/address";
import { isBookmarked, useBrowserStore } from "../../../store/browserStore";
import { useBrowserPrefsStore } from "../../../store/browserPrefsStore";
import { BrowserImportModal } from "../../modals/BrowserImportModal";
import { BrowserPasskeyModal } from "../../modals/BrowserPasskeyModal";
import { useSearchEngine } from "../../../store/searchStore";
import {
  boundsEqual,
  browserViewBridge,
  isOverlayOpen,
  measureBrowserViewBounds,
  type BrowserClearKind,
  type BrowserViewBounds,
  type BrowserViewState,
} from "../../../services/browserView";

/**
 * The browser panel.
 *
 * The omnibox accepts a URL, a bare host, a port, or a workspace path, because
 * in practice what gets typed here is "5173" far more often than a full URL.
 *
 * Only http(s) is loaded. A file:// or javascript: address typed into a panel
 * that sits inside the app shell is a real hazard, so those are refused before
 * they reach the page.
 *
 * In the desktop app the page is a `WebContentsView` layered over the window,
 * not a frame in this document: its own session, its own process, web security
 * on, and — the visible difference — its own navigation history, so Back and
 * Forward are the page's rather than a list this pane keeps beside it. What
 * that costs is position: the view cannot be placed by CSS and nothing can be
 * drawn over it, so the viewport below is an empty box whose measurements are
 * reported to main, and the view is hidden whenever a menu or a modal opens.
 * A browser build has no such view and keeps the iframe.
 * See services/browserView.ts and electron/browserView.cjs.
 *
 * ## Private tabs
 *
 * A private tab is a tab on another session — unprefixed, therefore in memory
 * — and that is the whole of the mechanism; everything else follows from it.
 * The flag travels to main only when the view is *made*, because a view cannot
 * change session: privacy is decided when the tab opens and a later navigation
 * cannot revoke it. What comes back is `state.private`, which is what stops
 * the visit being written down (utils/browserRecording.ts) — read from main
 * rather than from `panel.private`, because main owns the session and the tab
 * is only what asked for it.
 *
 * Home is a state rather than an address. Because the view is an OS layer that
 * nothing can be drawn over, showing a home page means hiding the view — and
 * hiding it is all it means: the page behind stays loaded, at its scroll, with
 * its history, and leaving home does not reload it. Navigating to a blank page
 * instead would have thrown all of that away every time the operator glanced
 * at their bookmarks.
 */

const SUGGESTIONS = [
  { id: "vite", label: "localhost:5173", icon: <Globe size={13} />, value: "http://localhost:5173" },
  { id: "next", label: "localhost:3000", icon: <Globe size={13} />, value: "http://localhost:3000" },
  { id: "gateway", label: "127.0.0.1:4310/api/health", icon: <Globe size={13} />, value: "http://127.0.0.1:4310/api/health" },
];

export const BrowserPane: React.FC<{ panel: PanelTab }> = ({ panel }) => {
  const update = usePanelStore((state) => state.update);
  const openPanel = usePanelStore((state) => state.open);
  const isPrivate = panel.private === true;
  // Where words go. The home page's field and this bar are the same choice.
  const engine = useSearchEngine();
  const bridge = useMemo(() => browserViewBridge(), []);
  const [draft, setDraft] = useState(panel.url ?? "");
  const [omniOpen, setOmniOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // A tab opened without an address opens onto home; one opened at a page does not.
  const [home, setHome] = useState(!panel.url);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The passkey notice, once read, is not news any more. Kept per page: main
  // clears `state.passkey` on the next navigation, and that resets this too.
  const [passkeyRead, setPasskeyRead] = useState(false);
  /*
    Something happened where the operator cannot see it.

    A screenshot is written outside the app, and a session emptied leaves the
    page it was emptied under looking exactly as it did. Both need saying, and
    neither is an error, so they get their own strip rather than the red one.
    Dismissed rather than timed out: a path is worth reading twice, and it is
    what the reveal button acts on.
  */
  const [notice, setNotice] = useState<{ text: string; path?: string } | null>(null);

  /*
    History.

    With a view, the page keeps its own and reports it: `state.canGoBack` is
    the real answer, including the redirects and in-page steps a list kept out
    here would miss. With an iframe there is no answer to have — its history is
    cross-origin and unreadable — so the pane keeps a list of what it was told
    to load. Both are needed: the fallback is the browser build.
  */
  const [history, setHistory] = useState<string[]>(panel.url ? [panel.url] : []);
  const [cursor, setCursor] = useState(panel.url ? 0 : -1);
  const [viewState, setViewState] = useState<BrowserViewState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // The gateway owns what the browser remembers; this is the renderer's copy of
  // it, shared by every pane and by home. See store/browserStore.ts.
  const bookmarks = useBrowserStore((state) => state.bookmarks);
  const loaded = useBrowserStore((state) => state.loaded);
  const loadBrowserData = useBrowserStore((state) => state.load);
  const addBookmark = useBrowserStore((state) => state.bookmark);
  const removeBookmark = useBrowserStore((state) => state.unbookmark);
  const clearHistory = useBrowserStore((state) => state.clearHistory);

  // The bar is one choice for every tab, and it survives a restart — which is
  // why it is not in `browserStore`. See store/browserPrefsStore.ts.
  const bookmarkBar = useBrowserPrefsStore((state) => state.bookmarkBar);
  const toggleBookmarkBar = useBrowserPrefsStore((state) => state.toggleBookmarkBar);

  useEffect(() => {
    // The star has to know before it is first drawn, and a pane opened straight
    // onto a page never renders home, which is the other thing that would read.
    if (!loaded) void loadBrowserData();
  }, [loaded, loadBrowserData]);

  const current = cursor >= 0 ? history[cursor] : null;
  const canGoBack = bridge ? Boolean(viewState?.canGoBack) : cursor > 0;
  const canGoForward = bridge ? Boolean(viewState?.canGoForward) : cursor < history.length - 1;
  // What the page says it is, once it has said anything; otherwise what it was asked to be.
  const shown = (bridge && viewState?.url) || current;

  useEffect(() => {
    // Another part of the app navigated this panel (an artifact preview, say).
    if (panel.url && panel.url !== current) {
      setHistory((previous) => [...previous.slice(0, cursor + 1), panel.url as string]);
      setCursor((previous) => previous + 1);
      setDraft(panel.url);
      // Something outside asked for a page — an artifact preview, the agent.
      // Leaving home showing would hide the page it just opened.
      setHome(false);
    }
    // Intentionally keyed on the incoming url only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.url]);

  // State comes back per view; this pane is one of possibly several.
  useEffect(() => {
    if (!bridge) return;
    return bridge.onState((state) => {
      if (state.id !== panel.id) return;
      if (state.error) {
        setError(state.error);
        return;
      }
      setError(null);
      // Merged, not replaced: main sends partial updates — a passkey notice, a
      // page falling silent — and a whole toolbar rebuilt from one of those
      // would forget whether Back is available.
      setViewState((previous) => ({ ...(previous ?? { id: panel.id }), ...state }));
      if (state.passkey === false) setPasskeyRead(false);
      if (state.url) {
        setDraft((previous) => (previous === state.url ? previous : (state.url as string)));
        update(panel.id, { url: state.url, label: addressLabel(state.url) });
      }
    });
    // `update` is a stable store action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, panel.id]);

  /*
    Where the page is, and whether it may be seen.

    The view is an OS layer above the document, so this is the only thing that
    positions it — and the only thing that stops it painting over a menu, a
    modal, or the tab the operator switched to. Measured in a layout effect and
    on every resize of the container or the window, and hidden on unmount,
    because unmount is what switching tabs looks like from in here.
  */
  const lastBounds = useRef<BrowserViewBounds | null>(null);
  const report = useCallback(
    (visible: boolean) => {
      if (!bridge) return;
      const bounds = measureBrowserViewBounds(viewportRef.current);
      // Bounds are sent on every observer tick; skipping the unchanged ones
      // keeps a resize drag from crossing the process boundary 60 times a
      // second. Visibility is cheap and always sent — it is the safety.
      if (!boundsEqual(lastBounds.current, bounds)) {
        lastBounds.current = bounds;
        bridge.setBounds(panel.id, bounds, visible);
        return;
      }
      bridge.setBounds(panel.id, bounds, visible);
    },
    [bridge, panel.id]
  );

  // The omnibox suggestions drop over the viewport, so the page has to get out
  // of their way as much as any modal does — and so does home, which is drawn
  // in the box the view would otherwise cover.
  const visible = Boolean(shown) && !omniOpen && !home;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const show = useCallback(() => report(visibleRef.current && !isOverlayOpen()), [report]);

  // Observers, armed once per mount. Kept apart from the visibility effect
  // below so that toggling visibility does not tear down and rebuild them —
  // and, worse, run the cleanup that hides the page on the way through.
  useLayoutEffect(() => {
    if (!bridge) return;
    show();
    const observer = new ResizeObserver(show);
    if (viewportRef.current) observer.observe(viewportRef.current);
    // The panel can move without resizing — the sidebar collapses, the splitter
    // is dragged — and an overlay can open without either.
    const overlays = new MutationObserver(show);
    overlays.observe(document.body, { childList: true, subtree: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", show);
    return () => {
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", show);
      // Unmount is a tab switch as often as it is a close, and in both cases
      // the page must stop being drawn. Ending it is the store's decision, not
      // this component's. See reapClosedBrowserViews.
      bridge.setBounds(panel.id, { x: 0, y: 0, width: 0, height: 0 }, false);
    };
  }, [bridge, panel.id, show]);

  useLayoutEffect(() => {
    if (bridge) show();
  }, [bridge, show, visible]);

  const go = (raw: string) => {
    const { url, error: failure } = normaliseAddress(raw, engine.id);
    if (!url) {
      setError(failure ?? null);
      return;
    }
    setError(null);
    setOmniOpen(false);
    setHome(false);
    setHistory((previous) => [...previous.slice(0, cursor + 1), url]);
    setCursor((previous) => previous + 1);
    setDraft(url);
    update(panel.id, { url, label: addressLabel(url) });
    if (bridge) {
      void bridge.navigate(panel.id, url, { private: isPrivate }).then((result) => {
        if (!result?.ok) setError("Only http and https addresses can be opened in a panel.");
      });
    }
  };

  /*
    The page this panel was already on when the pane mounted.

    `ensure`, not `navigate`: the pane unmounts on every tab switch while the
    view goes on existing behind the tab that replaced it. Navigating here
    would reload the page each time the operator came back, at the address the
    tab was opened with rather than the one they had reached — losing the
    scroll, the form, and the history. An existing view is left alone and only
    reports itself.
  */
  useEffect(() => {
    if (!bridge || !current) return;
    void bridge.ensure(panel.id, current, { private: isPrivate });
    // Only on mount: afterwards `go` and the toolbar drive the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const step = (delta: number) => {
    if (bridge) {
      bridge.command(panel.id, delta < 0 ? "back" : "forward");
      return;
    }
    const next = cursor + delta;
    if (next < 0 || next >= history.length) return;
    setCursor(next);
    setDraft(history[next]);
    update(panel.id, { url: history[next], label: addressLabel(history[next]) });
  };

  const reload = () => {
    if (bridge) bridge.command(panel.id, "reload");
    else setReloadKey((key) => key + 1);
  };

  /*
    The operator's screenshot, which is not the agent's.

    `page_screenshot` gives a model a jpeg of the viewport; this is the whole
    page, lossless, in a file somebody will open at 200% to read the small
    print. Main takes it and main saves it — through Electron's own save dialog,
    so the app never invents a path in the operator's home — and all that comes
    back here is where it went. A dismissed dialog is `cancelled`, and the right
    response to a cancelled dialog is to say nothing at all.
  */
  const takeScreenshot = async () => {
    if (!bridge) return;
    const answer = await bridge.screenshot(panel.id);
    if (answer?.cancelled) return;
    if (!answer?.ok || !answer.path) {
      setError(answer?.error ?? "The screenshot could not be saved.");
      return;
    }
    setNotice({ text: `Screenshot saved to ${answer.path}`, path: answer.path });
  };

  /*
    Clearing cookies or the cache.

    Said out loud afterwards, because neither changes anything on screen: an
    operator who clears cookies and sees the page they are signed in to still
    sitting there has no reason to believe it worked. What each word covers is
    main's `clearDataPlan`, not this component's to decide.
  */
  const clear = async (kind: BrowserClearKind) => {
    if (!bridge) return;
    const answer = await bridge.clearData(kind);
    if (!answer?.ok) {
      setError(answer?.error ?? "That could not be cleared.");
      return;
    }
    setNotice({
      text:
        kind === "cookies"
          ? "Cookies cleared on both browser sessions — sites you were signed in to will ask again."
          : "Cached files cleared on both browser sessions.",
    });
  };

  const display = useMemo(() => shown ?? "Open any file, URL, …", [shown]);
  const starred = isBookmarked(bookmarks, shown);

  /*
    What the omnibox offers.

    `normaliseAddress` already treats words as a search, so the first row is
    not a second behaviour — it is that behaviour, said out loud before the
    operator presses Enter. Without it a typed sentence looks like an address
    the panel is about to fail to load.
  */
  const suggestions = useMemo(() => {
    const rows = SUGGESTIONS.map((suggestion) => ({
      id: suggestion.id,
      label: suggestion.label,
      icon: suggestion.icon,
      onSelect: () => go(suggestion.value),
    }));
    const typed = draft.trim();
    if (typed && normaliseAddress(typed, engine.id).search) {
      rows.unshift({
        id: "search",
        label: `Search ${engine.name} for “${typed}”`,
        icon: <Search size={13} />,
        onSelect: () => go(typed),
      });
    }
    return rows;
    // `go` closes over the cursor, which is what the next navigation appends to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, cursor, history, engine]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="h-11 flex-shrink-0 flex items-center gap-2 px-3 border-b border-edge-chrome">
        <IconButton onClick={() => step(-1)} disabled={!canGoBack} title="Back" size={24}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton onClick={() => step(1)} disabled={!canGoForward} title="Forward" size={24}>
          <ArrowRight size={14} />
        </IconButton>
        {bridge && viewState?.loading ? (
          <IconButton onClick={() => bridge.command(panel.id, "stop")} title="Stop" size={24}>
            <X size={14} />
          </IconButton>
        ) : (
          <IconButton onClick={reload} disabled={!shown} title="Reload" size={24}>
            <RotateCw size={14} />
          </IconButton>
        )}
        <IconButton
          title={starred ? "Remove bookmark" : "Bookmark"}
          size={24}
          disabled={!shown}
          active={starred}
          onClick={() => {
            if (!shown) return;
            // The title is what the page calls itself; the address is the
            // fallback, because a page that has not finished loading has none.
            if (starred) void removeBookmark(shown);
            else void addBookmark(shown, viewState?.title || addressLabel(shown));
          }}
        >
          <Star size={14} fill={starred ? "currentColor" : "none"} />
        </IconButton>
        <IconButton title="Home" size={24} disabled={home} onClick={() => setHome(true)}>
          <House size={14} />
        </IconButton>

        <div className="relative flex-1 min-w-0">
          <div
            role="textbox"
            tabIndex={0}
            onClick={() => {
              setOmniOpen(true);
              window.setTimeout(() => inputRef.current?.select(), 0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") setOmniOpen(true);
            }}
            // `lit-focus` for the same reason the home field has it: the ring
            // belongs on the bar, not on the input inside it.
            className="lit lit-inner lit-focus h-7 rounded-md bg-surface-raised flex items-center gap-2.5 px-3 cursor-text"
          >
            <Search size={12} className="text-ink-faint flex-shrink-0" />
            {omniOpen ? (
              <input
                ref={inputRef}
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") go(draft);
                  if (event.key === "Escape") setOmniOpen(false);
                }}
                placeholder="Address, port, or path"
                className="flex-1 bg-transparent outline-none text-xs text-ink-high font-mono min-w-0"
              />
            ) : (
              <span className={`text-xs truncate ${shown ? "text-ink-dim font-mono" : "text-ink-placeholder"}`}>
                {display}
              </span>
            )}
          </div>

          <Menu
            open={omniOpen}
            onClose={() => setOmniOpen(false)}
            title="Suggestions"
            anchor="top-9 left-0"
            width="100%"
            items={suggestions}
          />
        </div>

        {/* Which session this tab is on, said where the operator is already
            looking. A private tab that looks like every other tab is one whose
            page ends up in the wrong place. */}
        {isPrivate && (
          <span
            className="flex-shrink-0 h-6 pl-1.5 pr-2 rounded-md bg-surface-chip border border-edge-chrome flex items-center gap-1.5 text-2xs text-ink-muted"
            title="Nothing from this tab is written to your history or downloads"
          >
            <EyeOff size={11} />
            Private
          </span>
        )}

        <div className="relative flex-shrink-0">
          <IconButton title="More" size={24} active={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
            <MoreHorizontal size={15} />
          </IconButton>
          <Menu
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            anchor="top-8 right-0"
            width={210}
            items={[
              { id: "home", label: "Home", icon: <House size={13} />, onSelect: () => setHome(true), disabled: home },
              {
                id: "bookmark-bar",
                label: bookmarkBar ? "Hide bookmark bar" : "Show bookmark bar",
                icon: <Bookmark size={13} />,
                // Not offered on a private tab, for the reason its home page
                // shows no bookmarks either: a strip of the shared list across
                // the top of a tab labelled private says the opposite of what
                // the label does. The choice itself is app-wide, so the bar is
                // back the moment an ordinary tab is in front.
                disabled: isPrivate,
                onSelect: toggleBookmarkBar,
              },
              {
                id: "screenshot",
                label: "Take screenshot",
                icon: <Camera size={13} />,
                // Nothing to photograph while home is up: the page is still
                // loaded behind it, and a picture of a page the operator is not
                // looking at is not what this button appears to promise.
                disabled: !shown || !bridge || home,
                onSelect: () => void takeScreenshot(),
              },
              {
                id: "external",
                label: "Open in default browser",
                icon: <ExternalLink size={13} />,
                disabled: !shown || !bridge,
                // Main draws the same http(s) line it draws for the view, so a
                // page that could not be opened here cannot be handed out either.
                onSelect: () => {
                  if (shown && bridge) void bridge.openExternal(shown);
                },
              },
              {
                id: "private",
                label: "New private tab",
                icon: <EyeOff size={13} />,
                // A new tab rather than a switch: a view cannot change session,
                // so "make this one private" would mean discarding the page the
                // operator is looking at without being asked.
                onSelect: () => openPanel({ kind: "browser", label: "Private", private: true }),
              },
              {
                id: "import",
                label: "Import from another browser\u2026",
                icon: <Import size={13} />,
                // Opens a Modal, so the native view hides itself on
                // `role="dialog"` exactly as it does for every other dialog.
                onSelect: () => setImportOpen(true),
              },
              /*
                Three clears, and they are three different things.

                History is a gateway file the assistant reads
                (`browserStore.clearHistory`); cookies and the cache are session
                state in main, on both partitions. Kept as three plain items
                rather than one "Clear browsing data…" dialog because each is
                one sentence long and a dialog with three checkboxes would be
                more chrome than the choice deserves.
              */
              {
                id: "clear",
                label: "Clear history",
                icon: <Trash2 size={13} />,
                onSelect: () => void clearHistory().then(() => setNotice({ text: "Browsing history cleared." })),
              },
              {
                id: "cookies",
                label: "Clear cookies",
                icon: <Cookie size={13} />,
                disabled: !bridge,
                onSelect: () => void clear("cookies"),
              },
              {
                id: "cache",
                label: "Clear cache",
                icon: <HardDrive size={13} />,
                disabled: !bridge,
                onSelect: () => void clear("cache"),
              },
            ]}
          />
        </div>
      </div>

      {error && <div className="px-3 py-2 text-2xs text-danger border-b border-edge-chrome">{error}</div>}

      {/* Something done, rather than something wrong. See `notice` above. */}
      {notice && (
        <div className="px-3 py-2 flex items-center gap-2 border-b border-edge-chrome text-2xs text-ink-dim">
          <span className="min-w-0 truncate" title={notice.text}>
            {notice.text}
          </span>
          {notice.path && bridge && (
            <button
              type="button"
              // The same reveal the downloads list uses, and it works for the
              // same reason: main watched this exact file being written, which
              // is the only thing that makes a path revealable.
              onClick={() => void bridge.revealDownload(notice.path as string)}
              className="flex-shrink-0 ml-auto text-accent hover:underline"
            >
              Show in Finder
            </button>
          )}
          <IconButton size={20} title="Dismiss" onClick={() => setNotice(null)}>
            <X size={11} />
          </IconButton>
        </div>
      )}

      {/*
        The bookmark bar.

        Drawn above the viewport rather than over the page, because nothing can
        be drawn over the page: the strip takes height from the box whose
        rectangle is reported to main, and the resize observer below moves the
        view down to match. Hidden on a private tab — see the menu item.
      */}
      {bookmarkBar && !isPrivate && (
        <div className="h-8 flex-shrink-0 flex items-center gap-1 px-2 border-b border-edge-chrome overflow-x-auto no-scrollbar">
          {bookmarks.length === 0 ? (
            <span className="px-1.5 text-2xs text-ink-faint">Star a page and it appears here.</span>
          ) : (
            bookmarks.map((bookmark) => (
              <button
                key={bookmark.url}
                type="button"
                onClick={() => go(bookmark.url)}
                title={bookmark.url}
                className="flex-shrink-0 h-6 max-w-[180px] pl-1 pr-2 rounded-md flex items-center gap-1.5 text-2xs text-ink-dim hover:bg-surface-raised hover:text-ink-high"
              >
                {/* The home page's mark, so a site is the same colour on both. */}
                <Mark url={bookmark.url} size={14} round icon />
                <span className="truncate">{bookmark.title || addressLabel(bookmark.url)}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/*
        The page asked for a passkey and nothing answered.

        On a signed macOS build this no longer appears: Touch ID answers, and
        the probe that raises this goes quiet (see electron/webauthn.cjs).
        Windows and Linux have no platform authenticator here at all, and
        neither does an unsigned build, so the notice is still the honest
        answer there — and the silence it replaced, an operator pressing a
        button and being told nothing, read as a bug rather than as a limit.
      */}
      {viewState?.passkey && !passkeyRead && (
        <div className="px-3 py-2 flex items-center gap-2 border-b border-edge-chrome text-2xs text-ink-dim">
          <KeyRound size={12} className="text-ink-faint flex-shrink-0" />
          <span className="min-w-0">
            This page asked for a passkey and no authenticator on this machine answered — choose
            another sign-in method on the page, or open it in your browser.
          </span>
          {shown && bridge && (
            <button
              type="button"
              onClick={() => void bridge.openExternal(shown)}
              className="flex-shrink-0 ml-auto text-accent hover:underline"
            >
              Open in browser
            </button>
          )}
          <IconButton size={20} title="Dismiss" onClick={() => setPasskeyRead(true)}>
            <X size={11} />
          </IconButton>
        </div>
      )}

      {/* ── Viewport ───────────────────────────────────────────────────── */}
      <div ref={viewportRef} className="flex-1 min-h-0 relative flex flex-col bg-frame-bot">
        {home || !shown ? (
          // Drawn in the box the view would cover — which is exactly why the
          // view is hidden while this is up. See `visible` above.
          <BrowserHome onOpen={go} private={isPrivate} />
        ) : bridge ? (
          // Deliberately empty: the page is a view above this box, and main is
          // told where the box is. Anything drawn here would be hidden by it.
          // See services/browserView.ts.
          <div className="w-full h-full" aria-label={`Browser: ${shown}`} />
        ) : (
          <iframe
            key={`${shown}-${reloadKey}`}
            src={shown}
            title={panel.label}
            // The browser build's fallback. Scripts and same-origin are needed
            // for local dev servers; top-level navigation is not, and letting a
            // previewed page navigate the shell would be a way out of the sandbox.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            className="w-full h-full border-0 bg-white"
          />
        )}
      </div>

      {/*
        Kept inside the panel because it is the panel's own action, and safe
        there only because it is a `Modal`: the native view hides itself
        whenever a `[role="dialog"]` is in the document, so this draws over the
        page rather than under it. See services/browserView.ts.
      */}
      <BrowserImportModal isOpen={importOpen} onClose={() => setImportOpen(false)} />

      {/*
        A page is blocked on this one: main holds its promise open until the
        answer comes back, so it is drawn from view state rather than from
        anything this pane decides. See electron/browserView.cjs.
      */}
      <BrowserPasskeyModal
        request={viewState?.webauthn ?? null}
        onChoose={(credentialId) => {
          const request = viewState?.webauthn;
          if (request && bridge) bridge.chooseWebauthnAccount(request.requestId, credentialId);
        }}
      />
    </div>
  );
};
