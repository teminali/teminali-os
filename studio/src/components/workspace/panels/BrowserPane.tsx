import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  House,
  MoreHorizontal,
  RotateCw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { IconButton, Menu } from "../../ui";
import { BrowserHome } from "./BrowserHome";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { addressLabel, normaliseAddress } from "../../../utils/address";
import { isBookmarked, useBrowserStore } from "../../../store/browserStore";
import {
  boundsEqual,
  browserViewBridge,
  isOverlayOpen,
  measureBrowserViewBounds,
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
  const bridge = useMemo(() => browserViewBridge(), []);
  const [draft, setDraft] = useState(panel.url ?? "");
  const [omniOpen, setOmniOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // A tab opened without an address opens onto home; one opened at a page does not.
  const [home, setHome] = useState(!panel.url);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
      setViewState(state);
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
    const { url, error: failure } = normaliseAddress(raw);
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
      void bridge.navigate(panel.id, url).then((result) => {
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
    void bridge.ensure(panel.id, current);
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
    if (typed && normaliseAddress(typed).search) {
      rows.unshift({
        id: "search",
        label: `Search Google for “${typed}”`,
        icon: <Search size={13} />,
        onSelect: () => go(typed),
      });
    }
    return rows;
    // `go` closes over the cursor, which is what the next navigation appends to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, cursor, history]);

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
            className="lit lit-inner h-7 rounded-md bg-surface-raised flex items-center gap-2.5 px-3 cursor-text"
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
                id: "clear",
                label: "Clear history",
                icon: <Trash2 size={13} />,
                onSelect: () => void clearHistory(),
              },
            ]}
          />
        </div>
      </div>

      {error && <div className="px-3 py-2 text-2xs text-danger border-b border-edge-chrome">{error}</div>}

      {/* ── Viewport ───────────────────────────────────────────────────── */}
      <div ref={viewportRef} className="flex-1 min-h-0 relative flex flex-col bg-frame-bot">
        {home || !shown ? (
          // Drawn in the box the view would cover — which is exactly why the
          // view is hidden while this is up. See `visible` above.
          <BrowserHome onOpen={go} />
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
    </div>
  );
};
