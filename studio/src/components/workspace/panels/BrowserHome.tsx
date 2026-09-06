import React, { useEffect, useMemo, useState } from "react";
import { Download, EyeOff, FolderOpen, Plus, Search, X } from "lucide-react";
import { BrandGlyph, Button, IconButton, Input, Menu, Modal } from "../../ui";
import { addressLabel, normaliseAddress, searchUrl } from "../../../utils/address";
import { faviconUrl, relativeAge, siteHue, siteInitial } from "../../../utils/siteMark";
import { SEARCH_ENGINES } from "../../../utils/searchEngines";
import { useSearchEngine, useSearchStore } from "../../../store/searchStore";
import { formatBytes } from "../../../services/guardianService";
import { browserViewBridge } from "../../../services/browserView";
import { useBrowserStore } from "../../../store/browserStore";
import { foldRecent, visitDay, type RecentVisit } from "../../../utils/browserRecording";

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
 * ## The shape: a new-tab page, not a form
 *
 * The top of it is deliberately Chrome's: a mark, one wide search field, and a
 * grid of round shortcuts under it. Not for the resemblance — that shape is
 * what a person opening a browser already knows how to use, and a home page
 * whose layout has to be learned is a home page that gets skipped in favour of
 * typing in the bar. The tokens, type scale and hover states are this app's
 * (see studio/DESIGN.md); only the arrangement is borrowed.
 *
 * The search box always searches, and says so. The omnibox above it is the one
 * that guesses between an address and a query; a field in the middle of a home
 * page that sometimes navigated instead would be one whose behaviour depended
 * on whether the operator happened to type a word with a dot in it.
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
 * - **Bookmarks are the shortcut grid.** They are the reason to open this page
 *   at all, and they are aimed at rather than read: a round tile is a bigger
 *   target than a row and the eye finds a colour before it finds a word. The
 *   last cell adds one, so a shortcut can be made here rather than only by
 *   visiting a page and starring it.
 * - **History is a list**, because it is scanned in order and its useful
 *   fields — where, and how long ago — belong beside the title, not across the
 *   page from it.
 * - **Downloads are a status**, so an unfinished one shows how far it has got.
 *
 * The mark on every tile and row is derived from the hostname rather than
 * fetched (`utils/siteMark.ts`), which keeps this page from telling anyone
 * what is on it — a favicon service would be told every address the operator
 * has kept, which is the one thing a home page must not leak.
 *
 * ## Private tabs get a different page
 *
 * They have no history and no downloads to show, and showing the *shared*
 * bookmarks and trail on a page titled private would be the exact opposite of
 * what it says. What is left is the search field and a plain statement of what
 * this mode does and does not do — measured against the code, not the wish.
 */

/**
 * How much of the trail is worth showing, after folding.
 *
 * Counted in *pages* rather than in visits: twelve rows of the same sign-in
 * page is not twelve things to look at. Anything older than this is a question
 * for the assistant, which reads the whole file.
 */
const RECENT_LIMIT = 10;

/** The shortcut grid, which stops being quick when it needs scrolling. Two rows of five. */
const BOOKMARK_LIMIT = 10;

export const BrowserHome: React.FC<{ onOpen: (url: string) => void; private?: boolean }> = ({
  onOpen,
  // `private` is a reserved word as a binding, which is why the prop is
  // renamed on the way in rather than used under its own name.
  private: isPrivate = false,
}) => {
  const bookmarks = useBrowserStore((state) => state.bookmarks);
  const history = useBrowserStore((state) => state.history);
  const downloads = useBrowserStore((state) => state.downloads);
  const active = useBrowserStore((state) => state.active);
  const loaded = useBrowserStore((state) => state.loaded);
  const load = useBrowserStore((state) => state.load);
  const unbookmark = useBrowserStore((state) => state.unbookmark);
  const bookmark = useBrowserStore((state) => state.bookmark);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const engine = useSearchEngine();
  const setEngine = useSearchStore((state) => state.setEngine);

  useEffect(() => {
    // Cheap when another pane already read it: the store keeps the answer, and
    // a private tab has no business asking for the shared lists at all.
    if (!loaded && !isPrivate) void load();
  }, [loaded, load, isPrivate]);

  // Folded by address, newest kept, then cut into Today / Yesterday / Earlier.
  const recent = useMemo(() => foldRecent(history, RECENT_LIMIT), [history]);
  const grouped = useMemo(() => {
    const groups: { day: string; rows: RecentVisit[] }[] = [];
    for (const visit of recent) {
      const day = visitDay(visit.visitedAt);
      const last = groups[groups.length - 1];
      if (last?.day === day) last.rows.push(visit);
      else groups.push({ day, rows: [visit] });
    }
    return groups;
  }, [recent]);
  const kept = useMemo(() => bookmarks.slice(0, BOOKMARK_LIMIT), [bookmarks]);
  const inFlight = useMemo(() => Object.entries(active), [active]);
  const bridge = useMemo(() => browserViewBridge(), []);

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    onOpen(searchUrl(trimmed, engine.id));
    setQuery("");
  };

  return (
    <div className="w-full h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 pt-16 pb-12 flex flex-col gap-10">
        {/* The one thing a home page is certainly for. Given the width and the
            height to be the first thing found, rather than a field the size of
            a row above three lists of rows. */}
        <form onSubmit={search} className="flex flex-col items-center gap-5">
          {isPrivate ? (
            <span className="w-12 h-12 rounded-full bg-surface-chip border border-edge-chrome flex items-center justify-center">
              <EyeOff size={22} strokeWidth={1.5} className="text-ink-muted" />
            </span>
          ) : (
            // The mark, not the app icon: `blend` drops the black tile it
            // wears in the Dock, which on a home page reads as a badge sitting
            // on the page rather than as the page's own mark.
            <BrandGlyph brand="teminali" size={40} blend />
          )}
          <div className="relative w-full max-w-md">
            {/* `lit-focus`, so focus lands on the pill's own edge. Without it
                the input draws its own flush ring and the field reads as a
                box inside a box — see index.css, "Text fields carry their
                focus on the container's lit edge". */}
            <div className="lit lit-inner lit-focus h-9 rounded-full bg-surface-raised flex items-center gap-1.5 pl-1.5 pr-4 focus-within:bg-surface-popover transition-colors duration-ds ease-ds">
              {/* The engine's own mark, and the way to change it. A search box
                  whose icon is a magnifying glass says a search is coming; one
                  whose icon is the engine says where it is going, which is the
                  thing the operator might want to change. */}
              <button
                type="button"
                onClick={() => setEnginesOpen((open) => !open)}
                title={`Searching with ${engine.name}`}
                aria-label={`Search engine: ${engine.name}. Change it.`}
                className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors duration-ds ease-ds"
              >
                <Mark url={engine.home} size={22} icon plain iconScale={1} />
              </button>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${engine.name}`}
                aria-label="Search the web"
                className="flex-1 bg-transparent outline-none text-xs text-ink-high placeholder:text-ink-disabled min-w-0"
              />
            </div>
            <Menu
              open={enginesOpen}
              onClose={() => setEnginesOpen(false)}
              title="Search with"
              anchor="top-11 left-0"
              width={200}
              items={SEARCH_ENGINES.map((candidate) => ({
                id: candidate.id,
                label: candidate.name,
                icon: <Mark url={candidate.home} size={16} icon plain iconScale={1} />,
                onSelect: () => setEngine(candidate.id),
              }))}
            />
          </div>
        </form>

        {/* A private tab stops here. What follows is the shared lists, and a
            page that showed them under the word "private" would be lying. */}
        {isPrivate ? (
          <PrivateNote />
        ) : (
          <>
            {/* Always drawn, even with nothing kept: the empty grid is one
                "Add shortcut" cell, which is how the first one gets made. */}
            <section className="flex flex-col gap-3">
              {/* Centred and wrapped rather than a grid: with two shortcuts
                  kept, a five-column grid leaves them huddled at the left of an
                  empty row under a centred search field. */}
              <div className="flex flex-wrap justify-center gap-1">
                {kept.map((mark) => (
                  <Tile
                    key={mark.url}
                    url={mark.url}
                    title={mark.title || addressLabel(mark.url)}
                    onOpen={() => onOpen(mark.url)}
                    onRemove={() => void unbookmark(mark.url)}
                  />
                ))}
                {bookmarks.length <= BOOKMARK_LIMIT && (
                  <AddTile onClick={() => setAdding(true)} />
                )}
              </div>
            </section>

            {recent.length > 0 && (
              <section className="flex flex-col gap-3">
                <Heading count={history.length}>Recent</Heading>
                {/* Narrower than the page. The age is the one field that is
                    genuinely a column, and a column at the far edge of a wide
                    panel is a number attached to nothing. */}
                <div className="flex flex-col gap-3 max-w-xl w-full">
                  {grouped.map((group) => (
                    <div key={group.day} className="flex flex-col">
                      <span className="px-2 pb-1 text-3xs uppercase tracking-wider text-ink-disabled">
                        {group.day}
                      </span>
                      {group.rows.map((entry) => (
                        <Row
                          key={entry.url}
                          url={entry.url}
                          title={entry.title || addressLabel(entry.url)}
                          meta={
                            entry.visits > 1
                              ? `${addressLabel(entry.url)} · ${entry.visits} visits`
                              : addressLabel(entry.url)
                          }
                          trailing={
                            <span className="text-2xs text-ink-disabled tabular-nums">
                              {relativeAge(entry.visitedAt)}
                            </span>
                          }
                          onOpen={() => onOpen(entry.url)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(inFlight.length > 0 || downloads.length > 0) && (
              <section className="flex flex-col gap-3">
                <Heading count={downloads.length + inFlight.length}>Downloads</Heading>
                <div className="flex flex-col max-w-xl w-full">
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

      <AddShortcut
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={(url, title) => {
          void bookmark(url, title);
          setAdding(false);
        }}
      />
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
 * The site's icon: its own, if it has one, and otherwise its initial on a hue
 * hashed from its hostname.
 *
 * The favicon is asked of the site itself — never of a favicon service, which
 * would be a third party told the whole list at once. See `utils/siteMark.ts`.
 * A site that answers with nothing, or with something that is not an image,
 * falls back to the letter, so the grid never has a hole in it.
 */
const Mark: React.FC<{
  url: string;
  size: number;
  round?: boolean;
  icon?: boolean;
  /**
   * How much of the mark the icon fills.
   *
   * A shortcut's favicon sits inside its circle with the site's colour showing
   * around it, which is what keeps a grid of them looking like one grid. A
   * search engine's logo is the control itself rather than a tile in a set, so
   * it is drawn edge to edge.
   */
  iconScale?: number;
  /**
   * No chip behind it: the logo alone.
   *
   * A shortcut is a *tile*, and the coloured disc is what makes a grid of them
   * read as one grid. A search engine's mark is not a tile — it is the icon of
   * the field it sits in — and putting a second circle behind Google's own
   * round logo draws a ring around a ring.
   */
  plain?: boolean;
  /**
   * One container for every tile, rather than one per site.
   *
   * The grid holds sites and it holds "Add shortcut", and that last cell has no
   * hostname to hash a colour from. While each tile wore its own hue the odd
   * one out was the *button* — the one cell that is always there. So the disc
   * is the neutral chip everywhere and the hue survives where it is still
   * doing work: the letter, for a site whose icon did not load.
   */
  neutral?: boolean;
}> = ({ url, size, round = false, icon = false, iconScale = 0.62, plain = false, neutral = false }) => {
  const hue = siteHue(url);
  const favicon = icon ? faviconUrl(url) : null;
  // Keyed on the address: a tile whose bookmark is replaced must try again
  // rather than inherit the last site's failure.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [favicon]);

  return (
    <span
      aria-hidden="true"
      className={`flex items-center justify-center font-semibold flex-shrink-0 overflow-hidden ${round ? "rounded-full" : "rounded-lg"}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.44,
        color: `hsl(${hue} 70% 72%)`,
        // Bare: no disc, no hairline. The letter keeps its hue, so a site
        // whose icon fails is still the same colour it is everywhere else.
        background: plain ? "transparent" : neutral ? "var(--surface-chip)" : `hsl(${hue} 45% 22%)`,
        border: plain ? "none" : neutral ? "1px solid var(--border-chrome)" : `1px solid hsl(${hue} 45% 32%)`,
      }}
    >
      {favicon && !failed ? (
        <img
          src={favicon}
          alt=""
          // Inside the mark rather than instead of it: most favicons are 16 or
          // 32 pixels, and one stretched to fill a 44-pixel circle is a blur.
          // The circle stays the site's colour, so a slow icon does not pop.
          style={{ width: Math.round(size * iconScale), height: Math.round(size * iconScale) }}
          className="object-contain"
          onError={() => setFailed(true)}
          draggable={false}
        />
      ) : (
        siteInitial(url)
      )}
    </span>
  );
};

/**
 * One shortcut: a target, not a line of text.
 *
 * A round mark over a single line of label, in a cell that lights up as a
 * whole. The address is in the tooltip rather than under the name, because two
 * lines of text under a circle is a caption and this is a button — the name is
 * what is aimed at, and at this size the colour finds it before the word does.
 */
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
      title={`${title} — ${url}`}
      className="w-[104px] h-[104px] px-2 flex flex-col items-center justify-center gap-2.5 rounded-xl hover:bg-surface-hover transition-colors duration-ds ease-ds"
    >
      {/* The same disc the Add shortcut cell wears — see `neutral`. */}
      <Mark url={url} size={44} round icon neutral iconScale={0.55} />
      <span className="w-full text-2xs text-ink-dim truncate text-center">{title}</span>
    </button>
    <IconButton
      size={20}
      title="Remove shortcut"
      className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-ds ease-ds"
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
    >
      <X size={11} />
    </IconButton>
  </div>
);

/** The cell that makes the first shortcut, and every one after it. */
const AddTile: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-[104px] h-[104px] px-2 flex flex-col items-center justify-center gap-2.5 rounded-xl hover:bg-surface-hover transition-colors duration-ds ease-ds"
  >
    <span className="w-11 h-11 rounded-full bg-surface-chip border border-edge-chrome flex items-center justify-center text-ink-muted">
      <Plus size={18} />
    </span>
    <span className="w-full text-2xs text-ink-faint truncate text-center">Add shortcut</span>
  </button>
);

/**
 * Naming and addressing a shortcut.
 *
 * The address goes through `normaliseAddress`, the same function the omnibox
 * uses, so "5173" and "example.com" become shortcuts here exactly as they
 * would become pages there — and a word that is only a search is refused,
 * because a shortcut to a search is not what the operator meant to keep.
 */
const AddShortcut: React.FC<{
  open: boolean;
  onClose: () => void;
  onAdd: (url: string, title: string) => void;
}> = ({ open, onClose, onAdd }) => {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setAddress("");
    setProblem(null);
  }, [open]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const { url, search, error } = normaliseAddress(address);
    if (!url || search) {
      setProblem(error ?? "That is a search, not an address. A shortcut needs a page.");
      return;
    }
    onAdd(url, name.trim() || addressLabel(url));
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Add shortcut" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name (optional)"
          aria-label="Shortcut name"
        />
        <Input
          value={address}
          variant="mono"
          onChange={(event) => {
            setAddress(event.target.value);
            setProblem(null);
          }}
          placeholder="Address, port, or path"
          aria-label="Shortcut address"
        />
        {problem && <p className="text-2xs text-danger">{problem}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!address.trim()}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
};

/**
 * What a private tab actually does.
 *
 * Every line is a fact about the code rather than a reassurance: the session is
 * `teminali-browser-private`, unprefixed and therefore in memory
 * (electron/browserView.cjs); `visitOf` refuses a private state and
 * `downloadAction` drops a private download (utils/browserRecording.ts); the
 * tab is dropped on the way to storage (utils/privateBrowsing.ts). The last
 * two lines are the limits, said out loud, because a privacy notice that only
 * lists what it protects is the kind nobody should believe.
 */
const PrivateNote: React.FC = () => (
  <section className="max-w-xl mx-auto w-full flex flex-col gap-3">
    <h2 className="text-xs font-medium text-ink-muted tracking-wide">This tab is private</h2>
    <ul className="flex flex-col gap-1.5 text-2xs text-ink-faint leading-relaxed">
      <li>Cookies and site data stay in memory and are cleared when the last private tab closes.</li>
      <li>Pages are not added to your history, and downloads are not added to the list.</li>
      <li>The tab is not reopened after a reload or a restart.</li>
      <li className="text-ink-disabled">Files you download are still saved where you put them.</li>
      <li className="text-ink-disabled">
        Your network, the sites you visit, and anyone running them can still see the traffic.
      </li>
    </ul>
  </section>
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
      {/* The same disc the shortcuts wear, at row size: one container for
          every site mark in the panel, whichever list it is in. */}
      {url ? <Mark url={url} size={20} round icon neutral iconScale={0.6} /> : <span className="w-5 flex justify-center flex-shrink-0">{icon}</span>}
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
          // Centred, not baseline-aligned: an image has no baseline, so a row
          // whose mark is a favicon and whose neighbours are text sat a pixel
          // or two off from everything beside it.
          className="flex-1 min-w-0 h-8 flex items-center gap-2.5 px-2 rounded-lg text-left hover:bg-surface-hover transition-colors duration-ds ease-ds"
        >
          {body}
        </button>
      ) : (
        <div className="flex-1 min-w-0 h-8 flex items-center gap-2.5 px-2">{body}</div>
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
      <div className="flex items-center gap-2.5 min-w-0">
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
