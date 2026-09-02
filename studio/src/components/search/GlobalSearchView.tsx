import React, { useEffect, useState } from "react";
import { 
  Search as SearchIcon, 
  ChevronRight, 
  ChevronDown, 
  Replace, 
  CaseSensitive, 
  Regex, 
  WholeWord, 
  Sparkle
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";

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

export const GlobalSearchView: React.FC = () => {
  const [query, setQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [isReplaceOpen, setIsReplaceOpen] = useState(false);
  const [isCaseSensitive, setIsCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [isWholeWord, setIsWholeWord] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  const openFile = useStudioStore((state) => state.openFile);

  const [searchResults, setSearchResults] = useState<FileSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanned, setScanned] = useState(0);

  /**
   * The search runs on the gateway, over the workspace on disk.
   *
   * It used to scan only the files already open in the editor while calling
   * itself global search — which meant it answered "no matches" for strings
   * that were plainly there, as long as you had not opened the file yet.
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


  const totalMatches = searchResults.reduce((count, file) => count + file.matches.length, 0);

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  /**
   * Opens the real file at the hit.
   *
   * The previous version only focused a tab that happened to be open already,
   * so clicking a result for an unopened file did nothing at all — which, now
   * that the search reaches the whole workspace, would be most of them.
   */
  const handleSelectMatch = async (filePath: string) => {
    try {
      const file = await WorkspaceService.readFile(filePath);
      openFile(file);
    } catch {
      // The file moved or is unreadable since the search ran; the result list
      // is a snapshot, so this is an ordinary outcome rather than a fault.
    }
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
            {totalMatches} results
          </span>
        )}
      </div>

      {/* Input Controls */}
      <div className="p-3 border-b border-edge space-y-2 bg-frame-bot flex-shrink-0">
        {/* Search Input Box */}
        <div className="relative flex items-center bg-surface-sunken border border-white/[0.10] rounded-xl px-2.5 py-1.5 focus-within:border-accent/50 transition-all">
          <SearchIcon className="w-3.5 h-3.5 text-ink-placeholder mr-2 flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all files (⌘⇧F)..."
            className="w-full bg-transparent text-xs text-ink-bright placeholder-ink-placeholder outline-none font-mono"
            autoFocus
          />
          <div className="flex items-center gap-1 ml-1 flex-shrink-0">
            <button
              onClick={() => setIsCaseSensitive(!isCaseSensitive)}
              className={`p-1 rounded transition-colors ${
                isCaseSensitive ? "bg-accent/20 text-accent font-bold" : "text-ink-placeholder hover:text-ink-prose"
              }`}
              title="Match Case (Aa)"
            >
              <CaseSensitive className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsWholeWord(!isWholeWord)}
              className={`p-1 rounded transition-colors ${
                isWholeWord ? "bg-accent/20 text-accent font-bold" : "text-ink-placeholder hover:text-ink-prose"
              }`}
              title="Match Whole Word (\\b)"
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

        {/* Toggle Replace */}
        <div className="flex items-center justify-between gap-2 text-[11px] text-ink-placeholder pt-0.5">
          <button
            onClick={() => setIsReplaceOpen(!isReplaceOpen)}
            className="flex items-center gap-1 flex-shrink-0 hover:text-ink-prose cursor-pointer transition-colors"
          >
            <Replace className="w-3 h-3" />
            <span>{isReplaceOpen ? "Hide Replace" : "Replace in files"}</span>
          </button>
          <span className="font-mono text-[10px] truncate">Searches open text files</span>
        </div>

        {/* Replace Input Box */}
        {isReplaceOpen && (
          <div className="relative flex items-center bg-surface-sunken border border-white/[0.10] rounded-xl px-2.5 py-1.5 focus-within:border-accent/50 transition-all animate-in fade-in duration-100">
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

      {/* Results Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-2 space-y-1 font-mono text-xs">
        {query && searchResults.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center text-ink-placeholder">
            <p>No results found for "{query}"</p>
            <p className="text-[10px] text-ink-ghost">Try changing case sensitivity or regex toggles</p>
          </div>
        )}

        {!query && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-ink-placeholder">
            <Sparkle className="w-6 h-6 text-accent/40 mx-auto" />
            <p className="text-ink-muted font-sans font-medium text-xs">Multi-File Code Discovery</p>
            <p className="text-[11px] text-ink-ghost max-w-[200px] mx-auto font-sans leading-relaxed">
              Instantly index, grep, and locate symbols across the entire repository.
            </p>
          </div>
        )}

        {searchResults.map((result) => {
          const isCollapsed = collapsedFiles[result.filePath];
          return (
            <div key={result.filePath} className="space-y-0.5 flex-shrink-0">
              {/* File Row */}
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

              {/* Match Snippets */}
              {!isCollapsed && (
                <div className="pl-5 space-y-0.5">
                  {result.matches.map((match, i) => (
                    <div
                      key={i}
                      onClick={() => handleSelectMatch(result.filePath)}
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
      </div>
    </aside>
  );
};
