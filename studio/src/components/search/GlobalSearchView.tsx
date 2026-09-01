import React, { useState, useMemo } from "react";
import { 
  Search as SearchIcon, 
  ChevronRight, 
  ChevronDown, 
  Replace, 
  CaseSensitive, 
  Regex, 
  WholeWord, 
  Sparkles
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";

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

  const { tabs, setActiveTab } = useStudioStore();

  // Search Engine across in-memory files + store files
  const searchResults = useMemo<FileSearchResult[]>(() => {
    if (!query.trim()) return [];

    const results: FileSearchResult[] = [];
    const allFiles: Record<string, string> = {};

    // Also include open tabs
    tabs.forEach((tab) => {
      if (tab.path && tab.content && tab.encoding !== "base64") {
        allFiles[tab.path] = tab.content;
      }
    });

    // Run Ripgrep-style in-memory scanner
    Object.entries(allFiles).forEach(([filePath, content]) => {
      const lines = content.split("\n");
      const matches: SearchMatch[] = [];

      lines.forEach((line, lineIndex) => {
        let matchIndex = -1;

        if (isRegex) {
          try {
            const regex = new RegExp(query, isCaseSensitive ? "g" : "gi");
            let match;
            while ((match = regex.exec(line)) !== null) {
              matches.push({
                lineNumber: lineIndex + 1,
                lineContent: line,
                matchStart: match.index,
                matchLength: match[0].length,
              });
            }
          } catch (e) {
            // Invalid regex, skip
          }
        } else {
          const searchIn = isCaseSensitive ? line : line.toLowerCase();
          const searchFor = isCaseSensitive ? query : query.toLowerCase();

          let startIndex = 0;
          while ((matchIndex = searchIn.indexOf(searchFor, startIndex)) !== -1) {
            if (isWholeWord) {
              const prevChar = matchIndex > 0 ? searchIn[matchIndex - 1] : " ";
              const nextChar = matchIndex + searchFor.length < searchIn.length ? searchIn[matchIndex + searchFor.length] : " ";
              const isWordBoundary = /[^a-zA-Z0-9_]/.test(prevChar) && /[^a-zA-Z0-9_]/.test(nextChar);
              if (isWordBoundary) {
                matches.push({
                  lineNumber: lineIndex + 1,
                  lineContent: line,
                  matchStart: matchIndex,
                  matchLength: query.length,
                });
              }
            } else {
              matches.push({
                lineNumber: lineIndex + 1,
                lineContent: line,
                matchStart: matchIndex,
                matchLength: query.length,
              });
            }
            startIndex = matchIndex + Math.max(1, query.length);
          }
        }
      });

      if (matches.length > 0) {
        const fileName = filePath.split("/").pop() || filePath;
        results.push({
          filePath,
          fileName,
          matches,
        });
      }
    });

    return results;
  }, [query, isCaseSensitive, isRegex, isWholeWord, tabs]);

  const totalMatches = useMemo(() => {
    return searchResults.reduce((acc, r) => acc + r.matches.length, 0);
  }, [searchResults]);

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  const handleSelectMatch = (filePath: string) => {
    const existing = tabs.find((t) => t.path === filePath || t.name === filePath.split("/").pop());
    if (existing) {
      setActiveTab(existing.id);
    }
  };

  return (
    <aside className="w-full bg-[#0e1117] border-r border-white/[0.08] flex flex-col select-none h-full text-slate-400 font-sans text-xs">
      {/* Header */}
      <div className="h-12 px-4 border-b border-white/[0.08] flex items-center justify-between bg-[#090b10] flex-shrink-0">
        <div className="flex items-center gap-2">
          <SearchIcon className="w-4 h-4 text-cyan-400" />
          <span className="font-semibold text-white text-sm tracking-tight">Search</span>
        </div>
        {query && (
          <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/20">
            {totalMatches} results
          </span>
        )}
      </div>

      {/* Input Controls */}
      <div className="p-3 border-b border-white/[0.08] space-y-2 bg-[#0a0d13] flex-shrink-0">
        {/* Search Input Box */}
        <div className="relative flex items-center bg-[#141720] border border-white/[0.10] rounded-xl px-2.5 py-1.5 focus-within:border-cyan-500/50 transition-all">
          <SearchIcon className="w-3.5 h-3.5 text-slate-500 mr-2 flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all files (⌘⇧F)..."
            className="w-full bg-transparent text-xs text-white placeholder-slate-500 outline-none font-mono"
            autoFocus
          />
          <div className="flex items-center gap-1 ml-1 flex-shrink-0">
            <button
              onClick={() => setIsCaseSensitive(!isCaseSensitive)}
              className={`p-1 rounded transition-colors ${
                isCaseSensitive ? "bg-cyan-500/20 text-cyan-400 font-bold" : "text-slate-500 hover:text-slate-300"
              }`}
              title="Match Case (Aa)"
            >
              <CaseSensitive className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsWholeWord(!isWholeWord)}
              className={`p-1 rounded transition-colors ${
                isWholeWord ? "bg-cyan-500/20 text-cyan-400 font-bold" : "text-slate-500 hover:text-slate-300"
              }`}
              title="Match Whole Word (\\b)"
            >
              <WholeWord className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsRegex(!isRegex)}
              disabled
              className={`p-1 rounded transition-colors ${
                isRegex ? "bg-cyan-500/20 text-cyan-400 font-bold" : "text-slate-500 hover:text-slate-300"
              }`}
              title="Regex search is unavailable in the read-only browser build"
            >
              <Regex className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Toggle Replace */}
        <div className="flex items-center justify-between text-[11px] text-slate-500 pt-0.5">
          <button
            onClick={() => setIsReplaceOpen(!isReplaceOpen)}
            className="flex items-center gap-1 hover:text-slate-300 cursor-pointer transition-colors"
          >
            <Replace className="w-3 h-3" />
            <span>{isReplaceOpen ? "Hide Replace" : "Replace in files"}</span>
          </button>
          <span className="font-mono text-[10px]">Searches open text files</span>
        </div>

        {/* Replace Input Box */}
        {isReplaceOpen && (
          <div className="relative flex items-center bg-[#141720] border border-white/[0.10] rounded-xl px-2.5 py-1.5 focus-within:border-cyan-500/50 transition-all animate-in fade-in duration-100">
            <Replace className="w-3.5 h-3.5 text-slate-500 mr-2 flex-shrink-0" />
            <input
              type="text"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              placeholder="Replace unavailable (read only)"
              disabled
              className="w-full bg-transparent text-xs text-white placeholder-slate-500 outline-none font-mono"
            />
          </div>
        )}
      </div>

      {/* Results Tree */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-xs">
        {query && searchResults.length === 0 && (
          <div className="text-center py-12 text-slate-500 space-y-1">
            <p>No results found for "{query}"</p>
            <p className="text-[10px] text-slate-600">Try changing case sensitivity or regex toggles</p>
          </div>
        )}

        {!query && (
          <div className="text-center py-12 text-slate-500 space-y-2">
            <Sparkles className="w-6 h-6 text-cyan-500/40 mx-auto" />
            <p className="text-slate-400 font-sans font-medium text-xs">Multi-File Code Discovery</p>
            <p className="text-[11px] text-slate-600 max-w-[200px] mx-auto font-sans leading-relaxed">
              Instantly index, grep, and locate symbols across the entire repository.
            </p>
          </div>
        )}

        {searchResults.map((result) => {
          const isCollapsed = collapsedFiles[result.filePath];
          return (
            <div key={result.filePath} className="space-y-0.5">
              {/* File Row */}
              <div
                onClick={() => toggleFileCollapse(result.filePath)}
                className="flex items-center justify-between px-2 py-1.5 hover:bg-white/[0.04] rounded-lg cursor-pointer text-slate-200 transition-colors"
              >
                <div className="flex items-center gap-1.5 truncate">
                  {isCollapsed ? <ChevronRight className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
                  <span className="font-semibold text-white text-[11px] truncate">{result.fileName}</span>
                  <span className="text-[10px] text-slate-500 truncate">{result.filePath}</span>
                </div>
                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-1.5 py-0.2 rounded border border-cyan-500/20 flex-shrink-0 ml-1">
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
                      className="group flex items-start gap-2 px-2 py-1 hover:bg-[#1c2230] rounded-lg cursor-pointer transition-colors text-slate-400 hover:text-slate-200"
                    >
                      <span className="text-[10px] text-slate-500 font-mono w-6 text-right flex-shrink-0 group-hover:text-cyan-400">
                        {match.lineNumber}
                      </span>
                      <p className="text-[11px] font-mono truncate leading-tight">
                        <span>{match.lineContent.slice(0, match.matchStart)}</span>
                        <span className="bg-cyan-500/30 text-cyan-200 font-bold px-0.5 rounded">
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
