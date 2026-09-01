import React, { useState, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  FileCode,
  ExternalLink,
  Code2,
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";

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
    if (cleanLang === "html" || cleanLang === "htm") detectedFilename = "index.html";
    else if (cleanLang === "css") detectedFilename = "styles.css";
    else if (cleanLang === "javascript" || cleanLang === "js") detectedFilename = "scripts.js";
    else if (cleanLang === "typescript" || cleanLang === "ts") detectedFilename = "app.ts";
    else if (cleanLang === "json") detectedFilename = "package.json";
  }

  // When actively streaming, stay expanded. Once streaming finishes, minimize to compact card.
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    if (defaultExpanded !== undefined) return defaultExpanded;
    return isStreaming;
  });

  const [hasManuallyToggled, setHasManuallyToggled] = useState(false);
  const [copied, setCopied] = useState(false);

  const { openFile, setSplitTab, setSplitOpen } = useStudioStore();

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

  const handleOpenInEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!detectedFilename) return;
    openFile({
      name: detectedFilename,
      path: detectedFilename,
      content,
      language: cleanLang || "plaintext",
    });
    setSplitTab("editor");
    setSplitOpen(true);
  };

  const lines = content.split("\n");
  const lineCount = lines.length;

  return (
    <div
      className={`my-3 bg-[#0d0f17] border border-white/10 rounded-xl overflow-hidden shadow-lg font-mono text-xs transition-all duration-150 ${className}`}
    >
      {/* ── Header Strip (Clickable to Expand/Collapse) ────────────────── */}
      <header
        onClick={handleToggle}
        className={`px-3 py-2 bg-[#121520] border-b border-white/5 flex items-center justify-between gap-2 cursor-pointer hover:bg-[#161a28] transition-colors select-none ${
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
            className="p-0.5 text-gray-400 hover:text-white rounded"
            title={isExpanded ? "Minimize code snippet" : "Expand code snippet"}
          >
            {isExpanded ? (
              <ChevronDown size={14} className="text-gray-300" />
            ) : (
              <ChevronRight size={14} className="text-[#FF6C37]" />
            )}
          </button>

          {detectedFilename ? (
            <FileCode size={13} className="text-[#FF6C37] flex-shrink-0" />
          ) : (
            <Code2 size={13} className="text-[#FF6C37] flex-shrink-0" />
          )}

          <span className="font-semibold text-gray-200 text-2xs truncate">
            {detectedFilename || cleanLang || "Code snippet"}
          </span>

          <span className="text-4xs font-mono text-gray-400 bg-white/5 px-1.5 py-0.2 rounded border border-white/5 flex-shrink-0">
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>

          {isStreaming && (
            <span className="flex items-center gap-1 text-4xs font-mono text-[#FF6C37] bg-[#FF6C37]/10 px-1.5 py-0.2 rounded border border-[#FF6C37]/25">
              <span className="w-1.5 h-1.5 rounded-full bg-[#FF6C37] animate-pulse" />
              generating...
            </span>
          )}
        </div>

        {/* Right: Actions (Copy, Open in Editor, Expand / Collapse Pill) */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {detectedFilename && (
            <button
              type="button"
              onClick={handleOpenInEditor}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-3xs text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
              title="Open file in Studio Editor"
            >
              <ExternalLink size={11} />
              <span className="hidden sm:inline">Editor</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-3xs text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            title="Copy code"
          >
            {copied ? (
              <>
                <Check size={11} className="text-emerald-400" />
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <Copy size={11} />
                <span>Copy</span>
              </>
            )}
          </button>

          <span className="text-4xs text-gray-400 px-1.5 py-0.5 rounded bg-white/5 border border-white/5 font-mono hover:text-white">
            {isExpanded ? "Minimize" : "Expand"}
          </span>
        </div>
      </header>

      {/* ── Expanded Code Block ────────────────────────────────────────── */}
      {isExpanded && (
        <div className="p-3 bg-[#080a10] overflow-x-auto text-gray-300 leading-relaxed max-h-[500px] overflow-y-auto">
          <pre className="font-mono text-xs whitespace-pre">
            {lines.map((line, lIdx) => (
              <div key={lIdx} className="table-row">
                <span className="table-cell pr-3 text-right text-gray-600 select-none text-3xs w-8">
                  {lIdx + 1}
                </span>
                <span className="table-cell whitespace-pre">
                  {line.trim().startsWith("#") || line.trim().startsWith("//") ? (
                    <span className="text-gray-500 italic">{line}</span>
                  ) : line.includes("import ") || line.includes("export ") ? (
                    <span className="text-[#FF6C37]">{line}</span>
                  ) : line.includes("function") || line.includes("const ") || line.includes("let ") ? (
                    <span className="text-purple-300">{line}</span>
                  ) : (
                    line
                  )}
                </span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
};
