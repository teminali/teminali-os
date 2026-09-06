import React, { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, Globe, Search, X } from "lucide-react";
import { EmptyState, IconButton } from "../../ui";
import { addressLabel, searchUrl } from "../../../utils/address";
import { relativeAge, siteHue, siteInitial } from "../../../utils/siteMark";
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
 *
 * ## Why the three sections are shaped differently
 *
 * They were the same undifferentiated list of 28-pixel rows, and each row put
 * its host at the far right with `ml-auto` — so a page called "hello world -
 * Google Search" had the words "hello world" floating a hand's width away from
 * it, attached to nothing. Three lists of that, stacked, in a narrow centred
 * column, is a form rather than a home page.
 *
 * They are different because they are used differently:
 *
 * - **Bookmarks are a target grid.** They are the reason to open this page at
 *   all, and they are aimed at rather than read: a tile is a bigger target
 *   than a row and the eye finds a colour before it finds a word.
 * - **History is a list**, because it is scanned in order and its useful
 *   fields — where, and how long ago — belong beside the title, not across the
 *   page from it.
 * - **Downloads are a status**, so an unfinished one shows how far it has got.
 *
 * The mark on every row is derived from the hostname rather than fetched
 * (`utils/siteMark.ts`), which keeps this page from telling anyone what is on
 * it.
 */

/** How much of the trail is worth showing. Older than this is a question for the assistant. */
const RECENT_LIMIT = 12;

/** The quick-dial grid, which stops being quick when it needs scrolling. */
const BOOKMARK_LIMIT = 12;

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
  const kept = useMemo(() => bookmarks.slice(0, BOOKMARK_LIMIT), [bookmarks]);
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
      <div className="max-w-3xl mx-auto px-8 pt-16 pb-12 flex flex-col gap-10">
        {/* The one thing a home page is certainly for. Given the width and the
            height to be the first thing found, rather than a field the size of
            a row above three lists of rows. */}
        <form onSubmit={search} className="flex flex-col items-center gap-4">
          <Globe size={30} strokeWidth={1.4} className="text-ink-disabled" />
          <div className="lit lit-inner w-full max-w-xl h-11 rounded-xl bg-surface-raised flex items-center gap-3 px-4 focus-within:bg-surface-popover transition-colors duration-ds ease-ds">
            <Search size={15} className="text-ink-faint flex-shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Google"
              aria-label="Search the web"
              className="flex-1 bg-transparent outline-none text-sm text-ink-high placeholder:text-ink-disabled min-w-0"
            />
          </div>
        </form>

        {empty ? (
          <EmptyState
            icon={<Globe size={26} strokeWidth={1.6} />}
            title="Nothing here yet"
            detail="Search above, or type an address in the bar. Pages you star and files you download show up here."
          />
        ) : (
          <>
            {kept.length > 0 && (
              <section className="flex flex-col gap-3">
                <Heading count={bookmarks.length}>Bookmarks</Heading>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {kept.map((mark) => (
                    <Tile
                      key={mark.url}
                      url={mark.url}
                      title={mark.title || addressLabel(mark.url)}
                      onOpen={() => onOpen(mark.url)}
                      onRemove={() => void unbookmark(mark.url)}
                    />
                  ))}
                </div>
              </section>
            )}

            {recent.length > 0 && (
              <section className="flex flex-col gap-3">
                <Heading count={history.length}>Recent</Heading>
                <div className="flex flex-col">
                  {recent.map((entry) => (
                    <Row
                      key={`${entry.url}-${entry.visitedAt}`}
                      url={entry.url}
                      title={entry.title || addressLabel(entry.url)}
                      meta={addressLabel(entry.url)}
                      trailing={<span className="text-2xs text-ink-disabled tabular-nums">{relativeAge(entry.visitedAt)}</span>}
                      onOpen={() => onOpen(entry.url)}
                    />
                  ))}
                </div>
              </section>
            )}

            {(inFlight.length > 0 || downloads.length > 0) && (
              <section className="flex flex-col gap-3">
                <Heading count={downloads.length + inFlight.length}>Downloads</Heading>
                <div className="flex flex-col">
                  {inFlight.map(([id, download]) => (
                    <Progress key={id} download={download} />
                  ))}
                  {downloads.map((entry) => (
                    <Row
                      key={`${entry.path || entry.url}-${entry.savedAt}`}
                      icon={<Download size={13} className="text-ink-faint" />}
                      title={entry.filename}
                      meta={
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

/** A section heading with how many there are, since each list is truncated. */
const Heading: React.FC<{ children: React.ReactNode; count: number }> = ({ children, count }) => (
  <div className="flex items-baseline gap-2 px-1">
    <h2 className="text-xs font-medium text-ink-muted tracking-wide">{children}</h2>
    <span className="text-2xs text-ink-disabled tabular-nums">{count}</span>
  </div>
);

/**
 * The site's own initial on a hue hashed from its hostname.
 *
 * Derived rather than fetched — see `utils/siteMark.ts` for why a favicon
 * service is not worth what it would cost.
 */
const Mark: React.FC<{ url: string; size: number }> = ({ url, size }) => {
  const hue = siteHue(url);
  return (
    <span
      aria-hidden="true"
      className="flex items-center justify-center rounded-lg font-semibold flex-shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.44,
        color: `hsl(${hue} 70% 72%)`,
        background: `hsl(${hue} 45% 22%)`,
        border: `1px solid hsl(${hue} 45% 32%)`,
      }}
    >
      {siteInitial(url)}
    </span>
  );
};

/** A bookmark: a target, not a line of text. */
const Tile: React.FC<{ url: string; title: string; onOpen: () => void; onRemove: () => void }> = ({
  url,
  title,
  onOpen,
  onRemove,
}) => (
  <div className="group relative">
    <button
      type="button"
      onClick={onOpen}
      title={url}
      className="w-full h-[62px] px-3 flex items-center gap-3 rounded-xl bg-surface-chip border border-edge-chrome hover:border-edge-popover hover:bg-surface-hover text-left transition-colors duration-ds ease-ds"
    >
      <Mark url={url} size={30} />
      <span className="min-w-0 flex flex-col">
        <span className="text-xs text-ink-high truncate">{title}</span>
        <span className="text-2xs text-ink-faint truncate">{addressLabel(url)}</span>
      </span>
    </button>
    <IconButton
      size={20}
      title="Remove bookmark"
      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-ds ease-ds"
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
    >
      <X size={11} />
    </IconButton>
  </div>
);

/**
 * One line of a list.
 *
 * The host sits directly after the title rather than at the far right of the
 * page, which is where it used to be: a detail a hand's width from the thing
 * it describes is attached to nothing. What does go right is the one field
 * that is genuinely a column — the age, or an action.
 */
const Row: React.FC<{
  url?: string;
  icon?: React.ReactNode;
  title: string;
  meta: string;
  tone?: "danger";
  onOpen?: () => void;
  trailing?: React.ReactNode;
}> = ({ url, icon, title, meta, tone, onOpen, trailing }) => {
  const body = (
    <>
      {url ? <Mark url={url} size={20} /> : <span className="w-5 flex justify-center flex-shrink-0">{icon}</span>}
      <span className="text-xs text-ink-high truncate">{title}</span>
      <span className={`text-2xs truncate ${tone === "danger" ? "text-danger" : "text-ink-faint"}`}>{meta}</span>
    </>
  );
  return (
    <div className="group flex items-center gap-1">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={url}
          className="flex-1 min-w-0 h-8 flex items-baseline gap-2.5 px-2 rounded-lg text-left hover:bg-surface-hover transition-colors duration-ds ease-ds"
        >
          {body}
        </button>
      ) : (
        <div className="flex-1 min-w-0 h-8 flex items-baseline gap-2.5 px-2">{body}</div>
      )}
      <span className="flex-shrink-0 pr-1">{trailing}</span>
    </div>
  );
};

/** A download still arriving: a status, so it says how far it has got. */
const Progress: React.FC<{ download: { filename: string; received: number; total: number } }> = ({ download }) => {
  const fraction = download.total > 0 ? Math.min(1, download.received / download.total) : 0;
  return (
    <div className="px-2 py-1.5 flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2.5 min-w-0">
        <Download size={13} className="text-ink-faint flex-shrink-0" />
        <span className="text-xs text-ink-high truncate">{download.filename}</span>
        <span className="text-2xs text-ink-faint truncate ml-auto tabular-nums">
          {download.total > 0
            ? `${formatBytes(download.received)} of ${formatBytes(download.total)}`
            : formatBytes(download.received)}
        </span>
      </div>
      {/* A determinate bar only when the size is known. A bar that fakes
          progress against an unknown total is a lie the operator would use to
          decide whether to wait. */}
      {download.total > 0 && (
        <div className="h-[3px] rounded-full bg-surface-raised overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
};
