import React, { useEffect, useMemo, useState } from "react";
import { Bookmark, Clock, Download, FolderOpen, Globe, Search, X } from "lucide-react";
import { EmptyState, IconButton, SectionLabel } from "../../ui";
import { addressLabel, searchUrl } from "../../../utils/address";
import { formatBytes } from "../../../services/guardianService";
import { browserViewBridge } from "../../../services/browserView";
import { useBrowserStore } from "../../../store/browserStore";

/**
 * The browser panel's home page.
 *
 * A real browser opens onto something rather than onto nothing, and the three
 * things it opens onto are what the operator kept, where they have been, and
 * what they saved. All three are read from the gateway rather than from this
 * document, because the assistant answers questions about them too and a list
 * that lived only in the renderer would be one it could not see.
 *
 * It is drawn *instead of* the page, not over it: the view is an OS layer
 * above this document and nothing can be painted on top of it, so the pane
 * hides the view while home is showing. The page stays alive behind it — Home
 * is a state, not a navigation, and leaving it does not reload anything.
 *
 * The search box always searches. The omnibox above it is the one that guesses
 * between an address and a query; a box in the middle of a home page that
 * sometimes navigated instead would be a box whose behaviour depended on
 * whether the operator happened to type a word with a dot in it.
 */

/** How much of the trail is worth showing. Older than this is a question for the assistant. */
const RECENT_LIMIT = 20;

export const BrowserHome: React.FC<{ onOpen: (url: string) => void }> = ({ onOpen }) => {
  const bookmarks = useBrowserStore((state) => state.bookmarks);
  const history = useBrowserStore((state) => state.history);
  const downloads = useBrowserStore((state) => state.downloads);
  const active = useBrowserStore((state) => state.active);
  const loaded = useBrowserStore((state) => state.loaded);
  const load = useBrowserStore((state) => state.load);
  const unbookmark = useBrowserStore((state) => state.unbookmark);
  const [query, setQuery] = useState("");

  useEffect(() => {
    // Cheap when another pane already read it: the store keeps the answer.
    if (!loaded) void load();
  }, [loaded, load]);

  const recent = useMemo(() => history.slice(0, RECENT_LIMIT), [history]);
  const inFlight = useMemo(() => Object.entries(active), [active]);
  const bridge = useMemo(() => browserViewBridge(), []);
  const empty = loaded && !bookmarks.length && !recent.length && !downloads.length && !inFlight.length;

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    onOpen(searchUrl(trimmed));
    setQuery("");
  };

  return (
    <div className="w-full h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-8">
        <form onSubmit={search} className="flex flex-col items-center gap-3">
          <Globe size={26} strokeWidth={1.6} className="text-ink-disabled" />
          <div className="lit lit-inner w-full h-9 rounded-lg bg-surface-raised flex items-center gap-2.5 px-3.5">
            <Search size={13} className="text-ink-faint flex-shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Google"
              aria-label="Search the web"
              className="flex-1 bg-transparent outline-none text-xs text-ink-high min-w-0"
            />
          </div>
        </form>

        {empty ? (
          <EmptyState
            icon={<Clock size={26} strokeWidth={1.6} />}
            title="Nothing here yet"
            detail="Search above, or type an address in the bar. Pages you star and files you download show up here."
          />
        ) : (
          <>
            {bookmarks.length > 0 && (
              <section>
                <SectionLabel>Bookmarks</SectionLabel>
                <div className="mt-1 flex flex-col">
                  {bookmarks.map((mark) => (
                    <Row
                      key={mark.url}
                      icon={<Bookmark size={12} />}
                      title={mark.title || addressLabel(mark.url)}
                      detail={addressLabel(mark.url)}
                      onOpen={() => onOpen(mark.url)}
                      trailing={
                        <IconButton
                          size={22}
                          title="Remove bookmark"
                          onClick={(event) => {
                            event.stopPropagation();
                            void unbookmark(mark.url);
                          }}
                        >
                          <X size={12} />
                        </IconButton>
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {recent.length > 0 && (
              <section>
                <SectionLabel>Recent</SectionLabel>
                <div className="mt-1 flex flex-col">
                  {recent.map((entry) => (
                    <Row
                      key={`${entry.url}-${entry.visitedAt}`}
                      icon={<Clock size={12} />}
                      title={entry.title || addressLabel(entry.url)}
                      detail={addressLabel(entry.url)}
                      onOpen={() => onOpen(entry.url)}
                    />
                  ))}
                </div>
              </section>
            )}

            {(inFlight.length > 0 || downloads.length > 0) && (
              <section>
                <SectionLabel>Downloads</SectionLabel>
                <div className="mt-1 flex flex-col">
                  {inFlight.map(([id, download]) => (
                    <Row
                      key={id}
                      icon={<Download size={12} />}
                      title={download.filename}
                      detail={
                        download.total > 0
                          ? `${formatBytes(download.received)} of ${formatBytes(download.total)}`
                          : formatBytes(download.received)
                      }
                    />
                  ))}
                  {downloads.map((entry) => (
                    <Row
                      key={`${entry.path || entry.url}-${entry.savedAt}`}
                      icon={<Download size={12} />}
                      title={entry.filename}
                      detail={
                        entry.state === "completed"
                          ? formatBytes(entry.bytes)
                          : `${formatBytes(entry.bytes)} · ${entry.state}`
                      }
                      tone={entry.state === "completed" ? undefined : "danger"}
                      trailing={
                        entry.state === "completed" && entry.path && bridge ? (
                          <IconButton
                            size={22}
                            title="Show in Finder"
                            onClick={(event) => {
                              event.stopPropagation();
                              void bridge.revealDownload(entry.path);
                            }}
                          >
                            <FolderOpen size={12} />
                          </IconButton>
                        ) : undefined
                      }
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/**
 * One line of a section.
 *
 * A button when it opens something and a plain row when it does not — a
 * download in flight is information, and making it look clickable would
 * promise something this page cannot do.
 */
const Row: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone?: "danger";
  onOpen?: () => void;
  trailing?: React.ReactNode;
}> = ({ icon, title, detail, tone, onOpen, trailing }) => {
  const body = (
    <>
      <span className="text-ink-faint flex-shrink-0">{icon}</span>
      <span className="text-xs text-ink-high truncate">{title}</span>
      <span className={`text-2xs truncate ml-auto pl-3 ${tone === "danger" ? "text-danger" : "text-ink-faint"}`}>
        {detail}
      </span>
    </>
  );
  return (
    <div className="group flex items-center gap-1">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 min-w-0 h-7 flex items-center gap-2.5 px-2 rounded-md text-left hover:bg-surface-hover transition-colors duration-ds ease-ds"
        >
          {body}
        </button>
      ) : (
        <div className="flex-1 min-w-0 h-7 flex items-center gap-2.5 px-2">{body}</div>
      )}
      <span className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-ds ease-ds">
        {trailing}
      </span>
    </div>
  );
};
