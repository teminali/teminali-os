import React, { useState, useEffect, useMemo } from "react";
import {
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  FileCode,
  Code2,
  ArrowUpRight,
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { highlightCode } from "../../utils/syntaxHighlight";
import { useStickyScroll } from "../../hooks/useStickyScroll";

export interface CodeSnippetProps {
  content: string;
  lang?: string;
  filename?: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}

export const CodeSnippet: React.FC<CodeSnippetProps> = ({
  content,
  lang = "code",
  filename,
  isStreaming = false,
  defaultExpanded,
  className = "",
}) => {
  let detectedFilename = filename;
  let cleanLang = lang.trim();

  const matchPath = cleanLang.match(/path=["']([^"']+)["']/i);
  if (matchPath) {
    detectedFilename = matchPath[1];
    cleanLang = cleanLang.split(" ")[0];
  } else if (!detectedFilename) {
    // Check first line for comment path pattern (e.g. `// src/App.tsx` or `# index.html`)
    const firstLine = content.split("\n")[0]?.trim() || "";
    const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*|<!--)\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/);
    if (commentMatch) {
      detectedFilename = commentMatch[1];
    } else if (cleanLang === "html" || cleanLang === "htm") {
      detectedFilename = "index.html";
    } else if (cleanLang === "css") {
      detectedFilename = "styles.css";
    } else if (cleanLang === "javascript" || cleanLang === "js") {
      detectedFilename = "scripts.js";
    } else if (cleanLang === "typescript" || cleanLang === "ts") {
      detectedFilename = "app.ts";
    } else if (cleanLang === "json") {
      detectedFilename = "package.json";
    }
  }

  // When streaming, stay expanded. Once streaming finishes, minimize to compact card.
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    if (defaultExpanded !== undefined) return defaultExpanded;
    return isStreaming;
  });

  const [hasManuallyToggled, setHasManuallyToggled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [jumping, setJumping] = useState(false);

  const { openFileAtSnippet } = useStudioStore();

  // Follows the code as it is written, but stops the moment the reader scrolls
  // up so they can read earlier lines while generation continues.
  const codeScroll = useStickyScroll<HTMLDivElement>(content, { enabled: isStreaming });

  useEffect(() => {
    if (!isStreaming && !hasManuallyToggled) {
      setIsExpanded(false);
    } else if (isStreaming && !hasManuallyToggled) {
      setIsExpanded(true);
    }
  }, [isStreaming, hasManuallyToggled]);

  const handleToggle = () => {
    setHasManuallyToggled(true);
    setIsExpanded((prev) => !prev);
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleJumpToFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!detectedFilename) return;
    setJumping(true);
    try {
      await openFileAtSnippet(detectedFilename, content);
    } finally {
      setTimeout(() => setJumping(false), 600);
    }
  };

  const lines = useMemo(() => content.split("\n"), [content]);
  const lineCount = lines.length;

  // Pre-render highlighted lines with Prism
  const highlightedLines = useMemo(() => {
    return lines.map((line) => highlightCode(line, cleanLang || "javascript"));
  }, [lines, cleanLang]);

  return (
    <div
      className={`lit lit-inner my-3 bg-surface-sunken rounded-xl overflow-hidden shadow-lg font-mono text-xs transition-all duration-150 ${className}`}
    >
      {/* ── Header Strip (Clickable to Expand/Collapse) ────────────────── */}
      <header
        onClick={handleToggle}
        className={`px-3 py-2 bg-surface border-b border-edge-chrome flex items-center justify-between gap-2 cursor-pointer hover:bg-surface-active transition-colors select-none ${
          !isExpanded ? "border-b-0" : ""
        }`}
      >
        {/* Left: Chevron + File/Lang Icon + Title + Line Count */}
        <div className="flex items-center gap-2 truncate">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleToggle();
            }}
            className="p-0.5 text-ink-muted hover:text-ink-high rounded"
            title={isExpanded ? "Minimize code snippet" : "Expand code snippet"}
          >
            {isExpanded ? (
              <ChevronDown size={14} className="text-ink-dim" />
            ) : (
              <ChevronRight size={14} className="text-accent" />
            )}
          </button>

          {detectedFilename ? (
            <FileCode size={13} className="text-accent flex-shrink-0" />
          ) : (
            <Code2 size={13} className="text-accent flex-shrink-0" />
          )}

          <span
            onClick={detectedFilename ? handleJumpToFile : undefined}
            className={`font-semibold text-ink-high text-2xs truncate ${
              detectedFilename
                ? "hover:text-accent hover:underline cursor-pointer"
                : ""
            }`}
            title={detectedFilename ? `Click to jump to ${detectedFilename} in Editor` : undefined}
          >
            {detectedFilename || cleanLang || "Code snippet"}
          </span>

          <span className="text-4xs font-mono text-ink-muted bg-surface-chip px-1.5 py-0.2 rounded border border-edge-chrome flex-shrink-0">
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>

          {isStreaming && (
            <span className="flex items-center gap-1 text-4xs font-mono text-accent bg-accent/10 px-1.5 py-0.2 rounded border border-accent/25">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              generating...
            </span>
          )}
        </div>

        {/* Right: Actions (Jump to File in Editor, Copy, Expand / Collapse Pill) */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {detectedFilename && (
            <button
              type="button"
              onClick={handleJumpToFile}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-3xs border transition-all ${
                jumping
                  ? "bg-accent/20 border-accent text-accent"
                  : "bg-surface-chip border-edge text-ink-dim hover:text-ink-high hover:border-accent/40 hover:bg-accent/10"
              }`}
              title={`Open ${detectedFilename} and jump directly to this code range`}
            >
              <ArrowUpRight size={11} className="text-accent" />
              <span className="hidden sm:inline">Jump to File</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-3xs text-ink-muted hover:text-ink-high hover:bg-surface-chip transition-colors"
            title="Copy code"
          >
            {copied ? (
              <>
                <Check size={11} className="text-success" />
                <span className="text-success">Copied</span>
              </>
            ) : (
              <>
                <Copy size={11} />
                <span>Copy</span>
              </>
            )}
          </button>

          <span className="text-4xs text-ink-muted px-1.5 py-0.5 rounded bg-surface-chip border border-edge-chrome font-mono hover:text-ink-high">
            {isExpanded ? "Minimize" : "Expand"}
          </span>
        </div>
      </header>

      {/* ── Expanded Code Block (Deep Obsidian Matte Background) ────────── */}
      {isExpanded && (
        <div
          ref={codeScroll.ref}
          className="relative p-3 bg-frame-bot overflow-auto text-ink-high leading-relaxed max-h-[200px] code-highlight-container"
        >
          <pre className="font-mono text-xs whitespace-pre">
            {highlightedLines.map((lineHtml, lIdx) => (
              <div key={lIdx} className="table-row">
                <span className="table-cell pr-3.5 text-right text-ink-ghost select-none text-3xs w-8">
                  {lIdx + 1}
                </span>
                <span
                  className="table-cell whitespace-pre"
                  dangerouslySetInnerHTML={{ __html: lineHtml || "&nbsp;" }}
                />
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
};
