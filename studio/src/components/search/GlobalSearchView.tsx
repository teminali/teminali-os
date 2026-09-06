import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search as SearchIcon,
  ChevronRight,
  ChevronDown,
  Replace,
  CaseSensitive,
  Regex,
  WholeWord,
  Bookmark,
  Boxes,
  Clock,
  Download,
  FileText,
  FolderGit2,
  Globe,
  HardDrive,
  MessageSquare,
} from "lucide-react";
import { SKILLS_LIST, useStudioStore } from "../../store/studioStore";
import { usePanelStore, PANEL_DEFAULTS, type PanelKind } from "../../store/panelStore";
import { useBrowserStore } from "../../store/browserStore";
import { useProjectLibrary } from "../../hooks/useProjectLibrary";
import { WorkspaceService, type MachineSearchResult } from "../../services/workspaceService";
import { containingFolder, workspaceRelative } from "../../services/workspaceDrop";
import { PlatformService } from "../../services/platformService";
import { openBrowserAt } from "../../services/browserNavigation";
import { browserViewBridge } from "../../services/browserView";
import { PanelGlyph } from "../workspace/PanelGlyph";
import { SegmentedTabs } from "../ui";
import { addressLabel, searchUrl } from "../../utils/address";
import { useSearchEngine } from "../../store/searchStore";
import {
  inScope,
  rankHits,
  scoreFields,
  scoreKind,
  sectionsOf,
  type ResultKind,
  type SearchHit,
  type SearchScope,
} from "../../utils/globalSearch";
import type { FileItem } from "../../types";

/**
 * Search, meaning search — not grep wearing search's name.
 *
 * The operator: *"now we have to make our real search mega — able to cover all
 * things that could be searched on the platform."* It said "Search across all"
 * and answered only with lines inside text files, so a chat they had, a page
 * they kept, a file by its name, a panel, a skill and a project were all
 * unreachable from the one box in the app that is called search.
 *
 * Nine sources, one field. The ranking is in `utils/globalSearch.ts` and is
 * deliberately predictable rather than fuzzy — equal, prefix, word start,
 * contains — because a search box is only worth typing into twice if the first
 * answer is where you expect it.
 *
 * **Only the code lane costs anything.** Eight of the nine sources are already
 * in memory: the panel list is a constant, the skills are a constant, the
 * chats, bookmarks, history and downloads are stores this app already keeps,
 * and the file *names* are one tree fetched once. Matching them is a pass over
 * arrays and needs no debounce. Content search walks the workspace on the
 * gateway, so it keeps the 220ms debounce and the abort it always had.
 *
 * The scope tabs narrow rather than search again: everything is matched every
 * time, and the tabs decide what is drawn. That is what makes them instant, and
 * it is why the counts on them are true rather than a promise about what a
 * different search might find.
 */

interface SearchMatch {
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchLength: number;
}

interface FileSearchResult {
  filePath: string;
  fileName: string;
  matches: SearchMatch[];
}

/** Panels the tab strip hides for everyone but an administrator. */
const ADMIN_ONLY = new Set<PanelKind>(["release", "arena"]);

/**
 * Kinds reached by clicking the thing they show, not by name. The gallery is
 * a folder's contents: offering it as a bare row would give the operator a
 * panel and no answer to "which folder?", when the tree beside it is already
 * the way in.
 */
const PATH_ONLY = new Set<PanelKind>(["gallery"]);

/** How many rows a section shows before it stops. */
const PER_SECTION = 6;
/** How many a scoped tab shows, where the section is the whole answer. */
const PER_SECTION_SCOPED = 24;

/** The tree, flattened to the files in it. Directories are not results. */
function flatten(items: FileItem[], into: FileItem[] = []): FileItem[] {
  for (const item of items) {
    if (item.type === "file") into.push(item);
    if (item.children?.length) flatten(item.children, into);
  }
  return into;
}

const KIND_ICON: Record<ResultKind, React.ReactNode> = {
  panel: <Boxes className="w-3 h-3" />,
  skill: <Boxes className="w-3 h-3" />,
  project: <FolderGit2 className="w-3 h-3" />,
  file: <FileText className="w-3 h-3" />,
  machine: <HardDrive className="w-3 h-3" />,
  code: <FileText className="w-3 h-3" />,
  chat: <MessageSquare className="w-3 h-3" />,
  bookmark: <Bookmark className="w-3 h-3" />,
  history: <Clock className="w-3 h-3" />,
  download: <Download className="w-3 h-3" />,
  web: <Globe className="w-3 h-3" />,
};

export const GlobalSearchView: React.FC = () => {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [isReplaceOpen, setIsReplaceOpen] = useState(false);
  const [isCaseSensitive, setIsCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [isWholeWord, setIsWholeWord] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  const openFile = useStudioStore((state) => state.openFile);
  const chatSessions = useStudioStore((state) => state.chatSessions);
  const switchSession = useStudioStore((state) => state.switchSession);
  const setSkill = useStudioStore((state) => state.setSkill);

  const openPanel = usePanelStore((state) => state.open);
  const focusOrOpenPanel = usePanelStore((state) => state.focusOrOpen);

  const bookmarks = useBrowserStore((state) => state.bookmarks);
  const history = useBrowserStore((state) => state.history);
  const downloads = useBrowserStore((state) => state.downloads);
  const browserLoaded = useBrowserStore((state) => state.loaded);
  const loadBrowserData = useBrowserStore((state) => state.load);

  const { recent: projects, openEntry } = useProjectLibrary();
  const engine = useSearchEngine();

  const [searchResults, setSearchResults] = useState<FileSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [fileIndex, setFileIndex] = useState<FileItem[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [machine, setMachine] = useState<MachineSearchResult[]>([]);
  /** Why the machine lane answered nothing, when the platform has no index. */
  const [machineNote, setMachineNote] = useState<string | null>(null);

  useEffect(() => {
    // The same check the tab strip's add menu makes: an administrator-only
    // panel is omitted rather than offered and then refused.
    const controller = new AbortController();
    void PlatformService.me(controller.signal).then((identity) => {
      if (!controller.signal.aborted) setIsAdmin(Boolean(identity?.isAdmin));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    // The lists this searches over are the ones other panes already read; asking
    // for them here costs nothing when they are loaded and fills them when the
    // operator opened search before opening anything else.
    if (!browserLoaded) void loadBrowserData();
  }, [browserLoaded, loadBrowserData]);

  useEffect(() => {
    const controller = new AbortController();
    WorkspaceService.listFiles(controller.signal)
      .then((tree) => {
        if (!controller.signal.aborted) setFileIndex(flatten(tree.files));
      })
      .catch(() => {
        // No tree is a search without filenames in it, not a broken panel.
      });
    return () => controller.abort();
  }, []);

  /**
   * Files and folders on the machine, outside the project.
   *
   * Debounced and aborted like the content search and for the same reason: it
   * spawns a process. Spotlight only, so a machine without one answers
   * `available: false` and the panel says so once rather than looking empty.
   */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setMachine([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      WorkspaceService.searchMachine(trimmed, controller.signal)
        .then((answer) => {
          if (controller.signal.aborted) return;
          setMachine(answer.results);
          setMachineNote(answer.available ? null : answer.reason);
        })
        .catch(() => {
          // A gateway that is restarting is not a reason to blank the eight
          // sources that answered from memory.
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  /**
   * Open something that is not in the project.
   *
   * The same policy a file dropped from Finder follows, and deliberately the
   * same code: nothing outside the workspace root is read across the boundary,
   * so the project moves to the folder holding it first and the file is opened
   * from inside the new root. See services/workspaceDrop.ts.
   */
  const openOutside = useCallback(
    async (result: MachineSearchResult) => {
      const folder = result.directory ? result.path : containingFolder(result.path);
      const name = folder.split("/").filter(Boolean).pop() ?? folder;
      try {
        await openEntry({ path: folder, name });
        if (result.directory) return;
        const relative = workspaceRelative(result.path, folder);
        if (relative) openFile(await WorkspaceService.readFile(relative));
      } catch {
        // The folder is gone, or the operator declined the switch. The index
        // is a snapshot; this is an ordinary outcome.
      }
    },
    [openEntry, openFile],
  );

  const openWorkspaceFile = useCallback(
    async (path: string) => {
      try {
        openFile(await WorkspaceService.readFile(path));
      } catch {
        // The file moved or is unreadable since the search ran; a result list
        // is a snapshot, so this is an ordinary outcome rather than a fault.
      }
    },
    [openFile],
  );

  /**
   * Content search runs on the gateway, over the workspace on disk.
   *
   * Debounced because every keystroke would otherwise walk the tree, and
   * aborted on the next keystroke so a slow search cannot land after a newer
   * one and overwrite it with stale results.
   */
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setError(null);
      setTruncated(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      WorkspaceService.search(trimmed, {
        caseSensitive: isCaseSensitive,
        regex: isRegex,
        wholeWord: isWholeWord,
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted) return;
          setSearchResults(
            response.files.map((file) => ({
              filePath: file.path,
              fileName: file.name,
              matches: file.matches.map((match) => ({
                lineNumber: match.line,
                lineContent: match.text,
                matchStart: match.column - 1,
                matchLength: match.match.length,
              })),
            })),
          );
          setTruncated(response.truncated);
          setScanned(response.filesScanned);
          setError(null);
        })
        .catch((failure) => {
          if (controller.signal.aborted) return;
          // An invalid regex is the operator mid-typing, so it is reported in
          // place rather than as an empty result set that looks like "no hits".
          setError(failure instanceof Error ? failure.message : "The search failed.");
          setSearchResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, isCaseSensitive, isRegex, isWholeWord]);

  /**
   * Everything except file contents, matched in memory.
   *
   * Rebuilt on every keystroke, which is affordable because it is a pass over
   * arrays the app already holds — and correct, because a store that changed
   * under a stale result list would otherwise open the wrong thing.
   */
  const hits = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const found: SearchHit[] = [];
    const add = (hit: Omit<SearchHit, "score">, score: number) => {
      // A group answers for its members: "skill" lists the skills even though
      // no skill is called one. Never above a real name match — see scoreKind.
      const total = Math.max(score, scoreKind(trimmed, hit.kind));
      if (total > 0) found.push({ ...hit, score: total });
    };

    for (const kind of Object.keys(PANEL_DEFAULTS) as PanelKind[]) {
      if (ADMIN_ONLY.has(kind) && !isAdmin) continue;
      if (PATH_ONLY.has(kind)) continue;
      const panel = PANEL_DEFAULTS[kind];
      add(
        {
          id: `panel:${kind}`,
          kind: "panel",
          title: panel.label,
          detail: panel.shortcut,
          glyph: <PanelGlyph kind={kind} size={12} />,
          // The same rule the add menu follows: several of the cheap kinds,
          // one of the kinds that hold a live session.
          open: () =>
            kind === "terminal" || kind === "side" || kind === "browser"
              ? openPanel({ kind })
              : focusOrOpenPanel({ kind }),
        },
        scoreFields(trimmed, panel.label, kind),
      );
    }

    for (const skill of SKILLS_LIST) {
      add(
        { id: `skill:${skill.id}`, kind: "skill", title: skill.name, detail: skill.tagline, open: () => setSkill(skill) },
        // The category too, so "video" finds the video skills — it is the word
        // the catalogue itself groups them under.
        scoreFields(trimmed, skill.name, skill.tagline, skill.description, skill.category),
      );
    }

    for (const project of projects) {
      add(
        {
          id: `project:${project.path}`,
          kind: "project",
          title: project.name,
          detail: project.path,
          open: () => void openEntry(project),
        },
        scoreFields(trimmed, project.name, project.path),
      );
    }

    for (const file of fileIndex) {
      add(
        {
          id: `file:${file.path}`,
          kind: "file",
          title: file.name,
          detail: file.path,
          open: () => void openWorkspaceFile(file.path),
        },
        scoreFields(trimmed, file.name, file.path),
      );
    }

    for (const found of machine) {
      add(
        {
          id: `machine:${found.path}`,
          kind: "machine",
          title: found.name,
          detail: found.path,
          open: () => void openOutside(found),
        },
        // Spotlight already decided these match; the ranking only orders them
        // against each other, and against the project's own files, which win.
        scoreFields(trimmed, found.name, found.path),
      );
    }

    for (const session of chatSessions) {
      // The title first, then what was actually said in it: a chat is usually
      // remembered by a phrase from inside it rather than by its name.
      const spoken = session.messages.find((message) => contains(message.content, trimmed));
      add(
        {
          id: `chat:${session.id}`,
          kind: "chat",
          title: session.title,
          detail: spoken ? snippet(spoken.content, trimmed) : session.workspace,
          open: () => switchSession(session.id),
        },
        Math.max(scoreFields(trimmed, session.title), spoken ? 400 : 0),
      );
    }

    for (const mark of bookmarks) {
      add(
        {
          id: `bookmark:${mark.url}`,
          kind: "bookmark",
          title: mark.title || addressLabel(mark.url),
          detail: addressLabel(mark.url),
          open: () => openBrowserAt(mark.url),
        },
        scoreFields(trimmed, mark.title, mark.url),
      );
    }

    for (const entry of history) {
      add(
        {
          id: `history:${entry.url}:${entry.visitedAt}`,
          kind: "history",
          title: entry.title || addressLabel(entry.url),
          detail: addressLabel(entry.url),
          open: () => openBrowserAt(entry.url),
        },
        scoreFields(trimmed, entry.title, entry.url),
      );
    }

    for (const file of downloads) {
      add(
        {
          id: `download:${file.path || file.url}:${file.savedAt}`,
          kind: "download",
          title: file.filename,
          detail: file.path || file.url,
          // Reveal, never open: main refuses any path it did not watch a save
          // dialog write, so this is not a way to launch an arbitrary file.
          open: () => {
            if (file.path) void browserViewBridge()?.revealDownload(file.path);
            else openBrowserAt(file.url);
          },
        },
        scoreFields(trimmed, file.filename, file.url),
      );
    }

    // Always last, always offered: the answer to "it is not in here" that does
    // not require retyping the words somewhere else.
    found.push({
      id: "web",
      kind: "web",
      title: `Search ${engine.name} for “${trimmed}”`,
      detail: "Opens in the browser panel",
      open: () => openBrowserAt(searchUrl(trimmed, engine.id)),
      score: 1,
    });

    return found;
  }, [
    query,
    isAdmin,
    fileIndex,
    machine,
    openOutside,
    chatSessions,
    bookmarks,
    history,
    downloads,
    projects,
    engine,
    openPanel,
    focusOrOpenPanel,
    setSkill,
    switchSession,
    openEntry,
    openWorkspaceFile,
  ]);

  const visible = useMemo(
    () => rankHits(hits.filter((hit) => inScope(hit.kind, scope)), 400),
    [hits, scope],
  );
  const sections = useMemo(
    () => sectionsOf(visible, scope === "all" ? PER_SECTION : PER_SECTION_SCOPED),
    [visible, scope],
  );

  const codeMatches = searchResults.reduce((count, file) => count + file.matches.length, 0);
  const showCode = inScope("code", scope);
  // Every source's answer, including the one that came from the gateway. The
  // web row is a way out rather than a result, so it is not counted as one.
  const totalResults = visible.filter((hit) => hit.kind !== "web").length + (showCode ? codeMatches : 0);

  const counts: Record<SearchScope, number> = {
    all: totalResults,
    files: hits.filter((hit) => inScope(hit.kind, "files")).length + codeMatches,
    chats: hits.filter((hit) => inScope(hit.kind, "chats")).length,
    web: hits.filter((hit) => hit.kind !== "web" && inScope(hit.kind, "web")).length,
    actions: hits.filter((hit) => inScope(hit.kind, "actions")).length,
  };

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  return (
    <aside className="w-full min-w-0 flex flex-col select-none h-full text-ink-muted font-sans text-xs">
      {/* Header */}
      <div className="h-9 pl-4 pr-2 border-b border-edge-chrome flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-3xs uppercase tracking-wider text-ink-faint">Search</span>
        </div>
        {query && (
          <span className="text-[10px] font-mono text-accent bg-accent/10 px-2 py-0.5 rounded-full border border-accent/20">
            {totalResults} results
          </span>
        )}
      </div>

      {/* Input Controls */}
      <div className="p-3 border-b border-edge space-y-2 bg-frame-bot flex-shrink-0">
        <div className="lit lit-inner lit-focus relative flex items-center bg-surface-sunken rounded-xl px-2.5 py-1.5 transition-all">
          <SearchIcon className="w-3.5 h-3.5 text-ink-placeholder mr-2 flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything (⌘⇧F)…"
            className="w-full bg-transparent text-xs text-ink-bright placeholder-ink-placeholder outline-none font-mono"
            autoFocus
          />
          <div className="flex items-center gap-1 ml-1 flex-shrink-0">
            {/* The three toggles belong to file contents and say so, rather than
                sitting over a field that now searches nine things. */}
            <button
              onClick={() => setIsCaseSensitive(!isCaseSensitive)}
              className={`p-1 rounded transition-colors ${
                isCaseSensitive ? "bg-accent/20 text-accent font-bold" : "text-ink-placeholder hover:text-ink-prose"
              }`}
              title="Match case, when searching in files"
            >
              <CaseSensitive className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsWholeWord(!isWholeWord)}
              className={`p-1 rounded transition-colors ${
                isWholeWord ? "bg-accent/20 text-accent font-bold" : "text-ink-placeholder hover:text-ink-prose"
              }`}
              title="Match whole word, when searching in files"
            >
              <WholeWord className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsRegex(!isRegex)}
              disabled
              className={`p-1 rounded transition-colors ${
                isRegex ? "bg-accent/20 text-accent font-bold" : "text-ink-placeholder hover:text-ink-prose"
              }`}
              title="Regex search is unavailable in the read-only browser build"
            >
              <Regex className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <SegmentedTabs
          variant="underline"
          activeTab={scope}
          onChange={setScope}
          tabs={[
            { id: "all", label: "All", badge: query ? counts.all : undefined },
            { id: "files", label: "Files", badge: query ? counts.files : undefined },
            { id: "chats", label: "Chats", badge: query ? counts.chats : undefined },
            { id: "web", label: "Web", badge: query ? counts.web : undefined },
            { id: "actions", label: "Actions", badge: query ? counts.actions : undefined },
          ]}
        />

        {/* Replace belongs to the file lane; it stays where it was. */}
        {showCode && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-ink-placeholder pt-0.5">
            <button
              onClick={() => setIsReplaceOpen(!isReplaceOpen)}
              className="flex items-center gap-1 flex-shrink-0 hover:text-ink-prose cursor-pointer transition-colors"
            >
              <Replace className="w-3 h-3" />
              <span>{isReplaceOpen ? "Hide Replace" : "Replace in files"}</span>
            </button>
            <span className="font-mono text-[10px] truncate">
              {searching ? "Searching the workspace…" : truncated ? `First ${scanned} files` : ""}
            </span>
          </div>
        )}

        {isReplaceOpen && showCode && (
          <div className="lit lit-inner lit-focus relative flex items-center bg-surface-sunken rounded-xl px-2.5 py-1.5 animate-in fade-in duration-100">
            <Replace className="w-3.5 h-3.5 text-ink-placeholder mr-2 flex-shrink-0" />
            <input
              type="text"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              placeholder="Replace unavailable (read only)"
              disabled
              className="w-full bg-transparent text-xs text-ink-bright placeholder-ink-placeholder outline-none font-mono"
            />
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-2 gap-2 text-xs">
        {error && <p className="px-2 py-1 text-[11px] text-danger font-mono">{error}</p>}
        {query && machineNote && inScope("machine", scope) && (
          <p className="px-2 py-1 text-[10px] text-ink-ghost">{machineNote}</p>
        )}

        {!query && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-ink-placeholder px-4">
            <SearchIcon className="w-6 h-6 text-accent/40" />
            <p className="text-ink-muted font-medium text-xs">One box for the whole app</p>
            {/* Named, not promised: every one of these is a source this view
                actually reads. */}
            <p className="text-[11px] text-ink-ghost leading-relaxed">
              Files by name and by what is in them, files and folders elsewhere
              on this machine, chats and what was said in them, bookmarks,
              history, downloads, panels, skills and projects.
            </p>
          </div>
        )}

        {query && totalResults === 0 && !searching && (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center text-ink-placeholder">
            <p>Nothing here matches “{query}”</p>
            <p className="text-[10px] text-ink-ghost">The last row still takes it to the web.</p>
          </div>
        )}

        {sections.map((section) => (
          <React.Fragment key={section.kind}>
            {section.kind === "code" ? null : (
              <section className="flex flex-col">
                <SectionHeading>{section.label}</SectionHeading>
                {section.hits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={hit.open}
                    title={hit.detail}
                    className="group flex items-center gap-2 px-2 h-7 rounded-lg text-left hover:bg-surface-hover transition-colors duration-ds ease-ds"
                  >
                    <span className="text-ink-faint flex-shrink-0 flex group-hover:text-accent">
                      {hit.glyph ?? KIND_ICON[hit.kind]}
                    </span>
                    <span className="text-[11px] text-ink-high truncate">{hit.title}</span>
                    <span className="text-[10px] text-ink-faint truncate">{hit.detail}</span>
                  </button>
                ))}
              </section>
            )}
          </React.Fragment>
        ))}

        {/* In files: its own shape, because a match has a line number and a
            line, and folding that into a one-line row loses the reason to look. */}
        {showCode && searchResults.length > 0 && (
          <section className="flex flex-col gap-0.5 font-mono">
            <SectionHeading>In files</SectionHeading>
            {searchResults.map((result) => {
              const isCollapsed = collapsedFiles[result.filePath];
              return (
                <div key={result.filePath} className="space-y-0.5 flex-shrink-0">
                  <div
                    onClick={() => toggleFileCollapse(result.filePath)}
                    className="flex items-center justify-between px-2 py-1.5 hover:bg-surface-chip rounded-lg cursor-pointer text-ink-high transition-colors"
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      {isCollapsed ? <ChevronRight className="w-3 h-3 text-ink-placeholder" /> : <ChevronDown className="w-3 h-3 text-ink-placeholder" />}
                      <span className="font-semibold text-ink-bright text-[11px] truncate">{result.fileName}</span>
                      <span className="text-[10px] text-ink-placeholder truncate">{result.filePath}</span>
                    </div>
                    <span className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 py-0.2 rounded border border-accent/20 flex-shrink-0 ml-1">
                      {result.matches.length}
                    </span>
                  </div>

                  {!isCollapsed && (
                    <div className="pl-5 space-y-0.5">
                      {result.matches.map((match, i) => (
                        <div
                          key={i}
                          onClick={() => void openWorkspaceFile(result.filePath)}
                          className="group flex items-start gap-2 px-2 py-1 hover:bg-surface rounded-lg cursor-pointer transition-colors text-ink-muted hover:text-ink-high"
                        >
                          <span className="text-[10px] text-ink-placeholder font-mono w-6 text-right flex-shrink-0 group-hover:text-accent">
                            {match.lineNumber}
                          </span>
                          <p className="text-[11px] font-mono truncate leading-tight">
                            <span>{match.lineContent.slice(0, match.matchStart)}</span>
                            <span className="bg-accent/30 text-accent font-bold px-0.5 rounded">
                              {match.lineContent.slice(match.matchStart, match.matchStart + match.matchLength)}
                            </span>
                            <span>{match.lineContent.slice(match.matchStart + match.matchLength)}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}
      </div>
    </aside>
  );
};

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="px-2 pb-1 text-3xs uppercase tracking-wider text-ink-disabled">{children}</span>
);

/** Does `text` contain `needle`, case-insensitively? */
function contains(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The words around the hit, so a chat result shows why it matched.
 *
 * A message can be thousands of characters and the match can be anywhere in
 * it; the first line of a long reply almost never contains the phrase the
 * operator remembered.
 */
function snippet(text: string, needle: string, width = 60): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return text.slice(0, width);
  const from = Math.max(0, at - Math.floor(width / 3));
  return `${from > 0 ? "…" : ""}${text.slice(from, from + width).replace(/\s+/g, " ").trim()}`;
}
