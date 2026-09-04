import React, { useMemo, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  FileCode,
  FileSearch,
  Flame,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import type { ToolCall } from "../../types";

export interface ProcessWatcherProps {
  engine?: string;
  mode?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  charCount?: number;
  tokensCount?: number;
  durationSec?: number;
  onJumpToFile?: (path: string, code: string) => void;
  compact?: boolean;
}

interface PersonaConfig {
  name: string;
  badge: string;
  avatar: string;
  tagline: string;
  themeColor: string;
  glowClass: string;
  borderClass: string;
  bgGradient: string;
  quips: {
    planning: string[];
    runningCommand: (cmd: string) => string;
    readingFile: (path: string) => string;
    writingFile: (path: string) => string;
    streaming: (tokens: number) => string;
    completed: string[];
  };
}

const PERSONAS: Record<string, PersonaConfig> = {
  "frontier-auto": {
    name: "Frontier Auto",
    badge: "Autonomous Strategist",
    avatar: "🦉",
    tagline: "Multi-Agent Neural Orchestration",
    themeColor: "#38bdf8",
    glowClass: "shadow-[0_0_15px_rgba(56,189,248,0.25)]",
    borderClass: "border-sky-500/30",
    bgGradient: "from-sky-950/30 via-purple-950/20 to-slate-900/40",
    quips: {
      planning: [
        "Frontier Auto put on reading glasses... formulating 3-step battle plan.",
        "Summoning the code spirits and sipping virtual espresso.",
        "Analyzing AST structure. Sniffing for bugs... none detected yet!",
        "Multi-agent loop initiated: Planner is conferring with Reviewer.",
      ],
      runningCommand: (cmd) => `Running \`${cmd}\`. Terminal gods, grant us a clean exit code 0!`,
      readingFile: (path) => `Scouting \`${path}\` — ooh, that architecture is spicy!`,
      writingFile: (path) => `Applying precision surgery on \`${path}\`. Zero semicolons harmed.`,
      streaming: (tokens) => `Drafting pure poetry disguised as code... ${tokens.toLocaleString()} tokens in flight.`,
      completed: [
        "Mission executed with surgical precision and 100% swagger. We cooked!",
        "0 crashes, 42 opportunities for perfection seized. Ready for your next move!",
        "All changes verified clean. Code is ship-ready, captain!",
      ],
    },
  },
  "frontier-flash": {
    name: "Frontier Flash",
    badge: "Hyper-Velocity",
    avatar: "⚡",
    tagline: "Sub-Second Inference Engine",
    themeColor: "#f59e0b",
    glowClass: "shadow-[0_0_15px_rgba(245,158,11,0.25)]",
    borderClass: "border-amber-500/30",
    bgGradient: "from-amber-950/30 via-orange-950/20 to-slate-900/40",
    quips: {
      planning: [
        "Thinking at 99.8% the speed of light... hold onto your chair!",
        "Hyper-drive active. Caching ideas before they even finish forming.",
        "Flash mode engaged: who needs coffee when you have tensor cores?",
      ],
      runningCommand: (cmd) => `Executing \`${cmd}\` faster than you can blink!`,
      readingFile: (path) => `Speed-reading \`${path}\` at Mach 3.`,
      writingFile: (path) => `Keyboard smoking while generating \`${path}\`!`,
      streaming: (tokens) => `Blazing through ${tokens.toLocaleString()} tokens with zero friction.`,
      completed: [
        "Done in the blink of an eye. Faster than light, cooler than ice!",
        "Boom! Flash finished before the second hand ticked.",
      ],
    },
  },
  claude: {
    name: "Claude Code",
    badge: "CLI Architect",
    avatar: "☕",
    tagline: "Deep Reasoning & System Design",
    themeColor: "#f97316",
    glowClass: "shadow-[0_0_15px_rgba(249,115,22,0.25)]",
    borderClass: "border-orange-500/30",
    bgGradient: "from-orange-950/30 via-rose-950/20 to-slate-900/40",
    quips: {
      planning: [
        "Claude Code took a sip of Earl Grey and started mapping the architectural multiverse.",
        "Consulting the sacred scrolls of clean code and functional purity.",
        "Refactoring ideas in mind before touching a single line.",
      ],
      runningCommand: (cmd) => `Running system utility: \`${cmd}\`. Measuring twice, cutting once.`,
      readingFile: (path) => `Delicately inspecting \`${path}\` for harmonic design balance.`,
      writingFile: (path) => `Writing code so clean you could display it in a gallery.`,
      streaming: (tokens) => `Orchestrating ${tokens.toLocaleString()} tokens with meticulous precision.`,
      completed: [
        "Elegant, robust, and verified. A masterclass in software craftsmanship.",
        "Everything in its right place. Ready for review, architect!",
      ],
    },
  },
  codex: {
    name: "Codex",
    badge: "Syntax Ninja",
    avatar: "🌌",
    tagline: "Precision Code Generation",
    themeColor: "#10b981",
    glowClass: "shadow-[0_0_15px_rgba(16,185,129,0.25)]",
    borderClass: "border-emerald-500/30",
    bgGradient: "from-emerald-950/30 via-teal-950/20 to-slate-900/40",
    quips: {
      planning: [
        "Codex entered stealth mode. Gathering symbols and imports...",
        "Zero fluff, maximum throughput. Target acquired.",
      ],
      runningCommand: (cmd) => `Firing \`${cmd}\` directly into the bash runtime.`,
      readingFile: (path) => `Scanning index signatures in \`${path}\`.`,
      writingFile: (path) => `Slicing out technical debt in \`${path}\`.`,
      streaming: (tokens) => `Injecting ${tokens.toLocaleString()} tokens of pure syntax.`,
      completed: [
        "Target eliminated. Solution delivered. Flawless victory.",
        "Code compiled and sealed. Ready for action.",
      ],
    },
  },
};

function getFileExtension(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? parts.pop()?.toUpperCase() ?? "FILE" : "FILE";
}

function getExtensionBadgeColor(ext: string): string {
  switch (ext) {
    case "TS":
    case "TSX":
      return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    case "JS":
    case "JSX":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    case "CSS":
    case "HTML":
      return "bg-rose-500/20 text-rose-400 border-rose-500/30";
    case "JSON":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    case "PY":
      return "bg-indigo-500/20 text-indigo-400 border-indigo-500/30";
    case "SH":
    case "BASH":
      return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    default:
      return "bg-slate-500/20 text-slate-400 border-slate-500/30";
  }
}

export const ProcessWatcher: React.FC<ProcessWatcherProps> = ({
  engine = "frontier",
  mode = "auto",
  toolCalls = [],
  isStreaming = false,
  charCount = 0,
  tokensCount,
  durationSec,
  onJumpToFile,
  compact = false,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [quipIndex, setQuipIndex] = useState(0);

  const personaKey =
    engine === "claude"
      ? "claude"
      : engine === "codex"
      ? "codex"
      : mode === "flash"
      ? "frontier-flash"
      : "frontier-auto";

  const persona = PERSONAS[personaKey] ?? PERSONAS["frontier-auto"];

  // Compute live step metrics
  const runningCall = toolCalls.find((call) => call.status === "running");
  const completedCalls = toolCalls.filter((call) => call.status === "completed");
  const failedCalls = toolCalls.filter((call) => call.status === "error");

  const filesRead = useMemo(() => {
    return toolCalls.filter((c) => {
      const name = c.name.toLowerCase();
      return name.includes("read") || name.includes("file") || name.includes("inspect");
    });
  }, [toolCalls]);

  const searches = useMemo(() => {
    return toolCalls.filter((c) => c.name.toLowerCase().includes("search") || c.arguments?.query);
  }, [toolCalls]);

  const commands = useMemo(() => {
    return toolCalls.filter(
      (c) => c.name.toLowerCase().includes("run") || c.name.toLowerCase().includes("terminal") || c.arguments?.command,
    );
  }, [toolCalls]);

  const approxTokens = tokensCount ?? Math.max(0, Math.round(charCount / 4));

  // Determine the active witty quip
  const currentQuip = useMemo(() => {
    if (runningCall) {
      const args = runningCall.arguments ?? {};
      const cmd = (args.command || args.cmd || args.script) as string | undefined;
      if (cmd) return persona.quips.runningCommand(cmd.length > 50 ? `${cmd.slice(0, 50)}…` : cmd);
      const filePath = (args.path || args.file || args.filePath) as string | undefined;
      if (filePath) {
        if (runningCall.name.includes("write")) return persona.quips.writingFile(filePath);
        return persona.quips.readingFile(filePath);
      }
    }

    if (isStreaming) {
      if (approxTokens > 20) {
        return persona.quips.streaming(approxTokens);
      }
      return persona.quips.planning[quipIndex % persona.quips.planning.length];
    }

    return persona.quips.completed[quipIndex % persona.quips.completed.length];
  }, [runningCall, isStreaming, approxTokens, quipIndex, persona]);

  const totalSteps = toolCalls.length;
  const isFinished = !isStreaming && totalSteps > 0;

  // Don't render empty box if there is no streaming and no tool calls
  if (!isStreaming && toolCalls.length === 0) return null;

  return (
    <div
      className={`my-2 rounded-xl border ${persona.borderClass} ${persona.glowClass} bg-gradient-to-br ${persona.bgGradient} backdrop-blur-md overflow-hidden transition-all duration-300`}
    >
      {/* ── Watcher Header / Persona Bar ──────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setQuipIndex((i) => i + 1)}
            title="Poke The Watcher for another quip"
            className="w-6 h-6 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-sm transform active:scale-95 transition-all"
          >
            {persona.avatar}
          </button>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-white tracking-wide truncate">{persona.name}</span>
              <span className="text-3xs font-mono px-1.5 py-0.2 rounded-full bg-white/10 text-white/70 border border-white/10">
                {persona.badge}
              </span>
              {isStreaming && (
                <span className="inline-flex items-center gap-1 text-3xs font-mono text-cyan-400 animate-pulse">
                  <Sparkles size={10} />
                  <span>active</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {totalSteps > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-3xs font-mono text-white/60 hover:text-white bg-white/5 hover:bg-white/10 px-2 py-1 rounded-md border border-white/10 transition-colors"
            >
              <span>
                {filesRead.length > 0 ? `${filesRead.length} files` : `${totalSteps} steps`}
                {searches.length > 0 ? `, ${searches.length} searches` : ""}
              </span>
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          )}
        </div>
      </div>

      {/* ── Witty Stepwise Watcher Commentary Pill ───────────────────────── */}
      <div className="px-3 py-1.5 bg-black/20 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0 text-white/80">
          <span className="text-3xs font-mono uppercase tracking-wider text-cyan-400 flex-shrink-0 font-bold">
            Watcher:
          </span>
          <span className="text-xs italic text-white/90 truncate">{currentQuip}</span>
        </div>
        <button
          type="button"
          onClick={() => setQuipIndex((i) => i + 1)}
          title="Shuffle funny remark"
          className="text-white/40 hover:text-white p-1 rounded transition-colors flex-shrink-0"
        >
          <RefreshCw size={10} />
        </button>
      </div>

      {/* ── Stepwise Action Timeline (Antigravity Style) ─────────────────── */}
      {expanded && (
        <div className="px-3 py-2 space-y-1.5 border-t border-white/5">
          {/* Reasoning / Thought row */}
          <div className="flex items-center gap-2 text-2xs font-mono text-white/50">
            <Brain size={12} className="text-purple-400 flex-shrink-0" />
            <span>
              {isStreaming ? "Thinking & formulating strategy..." : `Thought completed`}
            </span>
            {durationSec ? (
              <span className="text-3xs text-white/40 tabular-nums">({durationSec.toFixed(1)}s)</span>
            ) : null}
          </div>

          {/* Individual tool call / action items */}
          {toolCalls.map((call, idx) => {
            const args = call.arguments ?? {};
            const filePath = (args.path || args.file || args.filePath || args.filename) as string | undefined;
            const command = (args.command || args.cmd || args.script) as string | undefined;
            const query = (args.query || args.pattern || args.search) as string | undefined;
            const isCallRunning = call.status === "running";
            const isCallError = call.status === "error";

            const ext = filePath ? getFileExtension(filePath) : command ? "CMD" : query ? "FIND" : "TOOL";
            const badgeClass = getExtensionBadgeColor(ext);

            return (
              <div
                key={call.id || idx}
                className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-white/[0.03] hover:bg-white/[0.07] border border-white/5 text-xs transition-colors group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isCallRunning ? (
                    <Loader2 size={12} className="animate-spin text-cyan-400 flex-shrink-0" />
                  ) : isCallError ? (
                    <span className="w-3 h-3 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center text-3xs font-bold">
                      !
                    </span>
                  ) : (
                    <Check size={12} className="text-emerald-400 flex-shrink-0" strokeWidth={2.5} />
                  )}

                  <span className={`text-3xs font-mono font-bold px-1 py-0.5 rounded border ${badgeClass} flex-shrink-0`}>
                    {ext}
                  </span>

                  <span className="font-mono text-2xs text-white/80 truncate">
                    {filePath ? (
                      <button
                        type="button"
                        onClick={() => onJumpToFile?.(filePath, "")}
                        className="hover:underline text-left"
                      >
                        {filePath}
                      </button>
                    ) : command ? (
                      `$ ${command}`
                    ) : query ? (
                      `search "${query}"`
                    ) : (
                      call.name
                    )}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {call.result && (
                    <span className="text-3xs font-mono text-white/40 max-w-[120px] truncate">
                      {call.result}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Active "Working.." indicator while streaming */}
          {isStreaming && (
            <div className="flex items-center gap-2 px-2 py-1 text-2xs font-mono text-cyan-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
              </span>
              <span className="animate-pulse">Working...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
