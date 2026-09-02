import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, MoreHorizontal, RotateCw, Search, Star, FileText } from "lucide-react";
import { IconButton, Menu, EmptyState } from "../../ui";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { normaliseAddress } from "../../../utils/address";

/**
 * The browser panel.
 *
 * The omnibox accepts a URL, a bare host, a port, or a workspace path, because
 * in practice what gets typed here is "5173" far more often than a full URL.
 * Navigation history is kept per panel so back and forward behave.
 *
 * Only http(s) is loaded. A file:// or javascript: address typed into a panel
 * that sits inside the app shell is a real hazard, so those are refused rather
 * than passed through to the frame.
 */

const SUGGESTIONS = [
  { id: "vite", label: "localhost:5173", icon: <Globe size={13} />, value: "http://localhost:5173" },
  { id: "next", label: "localhost:3000", icon: <Globe size={13} />, value: "http://localhost:3000" },
  { id: "gateway", label: "127.0.0.1:4310/api/health", icon: <Globe size={13} />, value: "http://127.0.0.1:4310/api/health" },
];

export const BrowserPane: React.FC<{ panel: PanelTab }> = ({ panel }) => {
  const update = usePanelStore((state) => state.update);
  const [draft, setDraft] = useState(panel.url ?? "");
  const [omniOpen, setOmniOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Per-panel history. The iframe's own history is cross-origin and unreadable,
  // so we keep our own rather than pretend to drive the frame's.
  const [history, setHistory] = useState<string[]>(panel.url ? [panel.url] : []);
  const [cursor, setCursor] = useState(panel.url ? 0 : -1);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = cursor >= 0 ? history[cursor] : null;

  useEffect(() => {
    // Another part of the app navigated this panel (an artifact preview, say).
    if (panel.url && panel.url !== current) {
      setHistory((previous) => [...previous.slice(0, cursor + 1), panel.url as string]);
      setCursor((previous) => previous + 1);
      setDraft(panel.url);
    }
    // Intentionally keyed on the incoming url only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.url]);

  const go = (raw: string) => {
    const { url, error: failure } = normaliseAddress(raw);
    if (!url) {
      setError(failure ?? null);
      return;
    }
    setError(null);
    setOmniOpen(false);
    setHistory((previous) => [...previous.slice(0, cursor + 1), url]);
    setCursor((previous) => previous + 1);
    setDraft(url);
    update(panel.id, { url, label: labelFor(url) });
  };

  const step = (delta: number) => {
    const next = cursor + delta;
    if (next < 0 || next >= history.length) return;
    setCursor(next);
    setDraft(history[next]);
    update(panel.id, { url: history[next], label: labelFor(history[next]) });
  };

  const display = useMemo(() => current ?? "Open any file, URL, …", [current]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="h-11 flex-shrink-0 flex items-center gap-2 px-3 border-b border-edge-chrome">
        <IconButton onClick={() => step(-1)} disabled={cursor <= 0} title="Back" size={24}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton onClick={() => step(1)} disabled={cursor >= history.length - 1} title="Forward" size={24}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton onClick={() => setReloadKey((key) => key + 1)} disabled={!current} title="Reload" size={24}>
          <RotateCw size={14} />
        </IconButton>
        <IconButton title="Bookmark" size={24} disabled={!current}>
          <Star size={14} />
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
              <span className={`text-xs truncate ${current ? "text-ink-dim font-mono" : "text-ink-placeholder"}`}>
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
            items={SUGGESTIONS.map((suggestion) => ({
              id: suggestion.id,
              label: suggestion.label,
              icon: suggestion.icon,
              onSelect: () => go(suggestion.value),
            }))}
          />
        </div>

        <IconButton title="More" size={24}>
          <MoreHorizontal size={15} />
        </IconButton>
      </div>

      {error && <div className="px-3 py-2 text-2xs text-danger border-b border-edge-chrome">{error}</div>}

      {/* ── Viewport ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative flex flex-col bg-frame-bot">
        {current ? (
          <iframe
            key={`${current}-${reloadKey}`}
            src={current}
            title={panel.label}
            // The panel loads local dev servers, so scripts and same-origin are
            // needed; top-level navigation is not, and letting a previewed page
            // navigate the shell would be a way out of the sandbox.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            className="w-full h-full border-0 bg-white"
          />
        ) : (
          <EmptyState
            icon={<Globe size={30} strokeWidth={1.6} />}
            title="Nothing loaded yet"
            detail="Type a port like 5173, a host, or a full URL."
            action={{ label: "Open localhost:5173", onClick: () => go("5173") }}
          />
        )}
      </div>
    </div>
  );
};

function labelFor(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return "Browser";
  }
}
