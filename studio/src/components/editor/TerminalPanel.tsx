import React, { useState, useRef, useEffect } from "react";
import { X, Trash2, Plus, ChevronDown, Terminal as TerminalIcon, Copy, Check, CornerDownLeft } from "lucide-react";

interface TerminalPanelProps {
  isOpen: boolean;
  height?: number;
  onClose: () => void;
  onResizeStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ 
  isOpen, 
  height = 240, 
  onClose,
  onResizeStart 
}) => {
  const [logs, setLogs] = useState<string[]>([
    "Teminali Autonomous Studio ⚡ v1.0.0 [Apple Silicon arm64]",
    "Type any shell command or 'help' for quick tools.",
    "",
    "teminali@macbook-pro teminali % git status",
    "On branch master (up to date with origin/master)",
    "nothing to commit, working tree clean",
  ]);

  const [inputVal, setInputVal] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [copied, setCopied] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const handleCommand = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = inputVal.trim();
    if (!cmd) return;

    setLogs((prev) => [...prev, `teminali@macbook-pro teminali % ${cmd}`]);
    setCommandHistory((prev) => [cmd, ...prev]);
    setHistoryIndex(-1);
    setInputVal("");

    const lower = cmd.toLowerCase();
    if (lower === "clear" || lower === "cls") {
      setLogs([]);
      return;
    }

    if (lower === "help") {
      setLogs((prev) => [
        ...prev,
        "Available Quick Commands:",
        "  npm run dev          Start local Vite dev server",
        "  npm run build        Compile TypeScript and production bundle",
        "  git status           Check current git repository state",
        "  ls -la               List current workspace files",
        "  clear                Clear terminal screen buffer",
        "  node -v / ollama -v  Check local runtime versions",
      ]);
      return;
    }

    if (lower === "ls" || lower === "ls -la" || lower === "dir") {
      setLogs((prev) => [
        ...prev,
        "drwxr-xr-x   src/",
        "drwxr-xr-x   server/",
        "drwxr-xr-x   public/",
        "-rw-r--r--   package.json",
        "-rw-r--r--   index.html",
        "-rw-r--r--   vite.config.ts",
        "-rw-r--r--   README.md",
      ]);
      return;
    }

    if (lower === "npm run dev") {
      setLogs((prev) => [
        ...prev,
        "> @teminali/studio@1.0.0 dev",
        "> vite",
        "",
        "  VITE v6.4.3  ready in 184 ms",
        "  ➜  Local:   http://localhost:3000/",
        "  ➜  Network: use --host to expose",
      ]);
      return;
    }

    if (lower === "git status") {
      setLogs((prev) => [
        ...prev,
        "On branch master",
        "Your branch is up to date with 'origin/master'.",
        "nothing to commit, working tree clean",
      ]);
      return;
    }

    if (lower === "node -v") {
      setLogs((prev) => [...prev, "v22.14.0"]);
      return;
    }

    // Default response
    setLogs((prev) => [
      ...prev,
      `[zsh] executed: ${cmd}`,
      "status: exit code 0",
    ]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const nextIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(nextIndex);
        setInputVal(commandHistory[nextIndex]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setInputVal(commandHistory[nextIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputVal("");
      }
    }
  };

  const copyAll = () => {
    navigator.clipboard.writeText(logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!isOpen) return null;

  return (
    <div 
      style={{ height: `${height}px`, minHeight: 140, maxHeight: "calc(100% - 100px)" }} 
      className="border-t border-white/5 bg-[#08090E] flex flex-col select-none z-20 text-gray-300 font-mono relative flex-shrink-0"
    >
      {/* ── Title Strip ──────────────────────────────────────────────── */}
      <div className="h-8 border-b border-white/5 bg-[#0c0e14] flex items-center justify-between px-3 flex-shrink-0">
        <div className="flex items-center gap-2 text-3xs text-gray-200 font-bold">
          <TerminalIcon size={12} className="text-[#38bdf8]" />
          <span className="text-gray-300">zsh · local terminal</span>
          <span className="px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-4xs font-mono">
            active
          </span>
        </div>

        <div className="flex items-center gap-1 text-gray-400">
          <button
            onClick={copyAll}
            className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
            title="Copy terminal buffer"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
          <button
            onClick={() => setLogs([])}
            className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
            title="Clear buffer"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors ml-1"
            title="Close terminal"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* ── Terminal Output Stream ────────────────────────────────────── */}
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex-1 p-3 text-xs text-gray-300 overflow-y-auto space-y-1 select-text leading-relaxed bg-[#08090E] cursor-text"
      >
        {logs.map((log, idx) => (
          <div
            key={idx}
            className={
              log.includes("teminali@")
                ? "text-[#38bdf8] font-bold"
                : log.includes("Error") || log.includes("denied")
                ? "text-rose-400"
                : log.includes("ready") || log.includes("clean") || log.includes("Local:")
                ? "text-emerald-400"
                : "text-gray-400"
            }
          >
            {log}
          </div>
        ))}

        {/* Active Command Prompt Line */}
        <form onSubmit={handleCommand} className="flex items-center gap-2 pt-1">
          <span className="text-[#38bdf8] font-bold flex-shrink-0">
            teminali@macbook-pro teminali %
          </span>
          <input
            ref={inputRef}
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent border-0 outline-none text-white text-xs font-mono caret-[#38bdf8]"
            autoFocus
            spellCheck={false}
          />
        </form>

        <div ref={terminalEndRef} />
      </div>
    </div>
  );
};
