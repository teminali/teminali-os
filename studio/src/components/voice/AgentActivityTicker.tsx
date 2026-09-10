/**
 * The live process line under Temi's orb.
 *
 * The Teminali OS assistant has no chat surface: it reads, edits, searches and
 * runs entirely behind the scenes, and this strip is the only place a person
 * sees it happen. That constraint is what makes it small — one line, one verb,
 * one target — because a panel would become a second chat, which is the thing
 * the design is getting rid of.
 *
 * Split in two on purpose. `AgentActivityTicker` is presentational and takes a
 * phrase; it can be dropped beside any orb, in a status bar, or in a future
 * compact window without dragging a store behind it. `ConnectedAgentActivity`
 * is the one-line wiring to this application's store. Anything that needs the
 * strip somewhere new uses the first and supplies its own source.
 */

import React from "react";
import { FileText, FilePen, Terminal, FlaskConical, Sparkles } from "lucide-react";

import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import { currentActivityPhrase, type ActivityPhrase } from "../../services/voice/activityPhrase";

const ICONS = {
  read: FileText,
  edit: FilePen,
  run: Terminal,
  test: FlaskConical,
  think: Sparkles,
} as const;

export interface AgentActivityTickerProps {
  /** What to show. `null` renders nothing at all — see the note on absence. */
  phrase: ActivityPhrase | null;
  /** Optional click-through, for surfaces that can open the full activity log. */
  onClick?: () => void;
  className?: string;
}

/**
 * Renders nothing when there is no phrase.
 *
 * Deliberate: an idle placeholder ("no activity") occupies the same space as
 * real news and trains the eye to ignore the strip, which costs exactly when it
 * finally has something to say.
 */
export const AgentActivityTicker: React.FC<AgentActivityTickerProps> = ({ phrase, onClick, className = "" }) => {
  if (!phrase) return null;

  const Icon = ICONS[phrase.icon] || Sparkles;
  const failed = phrase.state === "failed";
  const running = phrase.state === "running";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-live="polite"
      aria-label={`${phrase.verb} ${phrase.target}`.trim()}
      className={`group mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
        failed
          ? "border-rose-900/50 bg-rose-950/40"
          : "border-[#2a2a2a] bg-[#141414] hover:border-[#3a3a3a]"
      } ${onClick ? "cursor-pointer" : "cursor-default"} ${className}`}
    >
      <Icon
        size={11}
        className={`shrink-0 ${failed ? "text-rose-400" : running ? "text-emerald-400" : "text-[#737373]"} ${
          running && !failed ? "animate-pulse" : ""
        }`}
      />
      <span className={`text-[10px] font-medium tracking-wide ${failed ? "text-rose-300" : "text-[#a3a3a3]"}`}>
        {phrase.verb}
      </span>
      {phrase.target ? (
        <span className="truncate font-mono text-[10px] text-[#737373]" title={phrase.target}>
          {phrase.target}
        </span>
      ) : null}
    </button>
  );
};

/** The same strip, reading this application's assistant activity. */
export const ConnectedAgentActivity: React.FC<{ onClick?: () => void; className?: string }> = ({ onClick, className }) => {
  const items = useAssistantActivityStore((state) => state.items);
  const isRunning = useAssistantActivityStore((state) => state.isTaskRunning);
  const latestProgress = useAssistantActivityStore((state) => state.latestProgress);
  return <AgentActivityTicker phrase={currentActivityPhrase(items, isRunning, latestProgress)} onClick={onClick} className={className} />;
};
