/**
 * The live process line, riding in the composer's project bar.
 *
 * The Teminali OS assistant has no chat surface: it reads, edits, searches and
 * runs entirely behind the scenes, and this strip is the only place a person
 * sees it happen. That constraint is what makes it small — one line, one verb,
 * one target — because a panel would become a second chat, which is the thing
 * the design is getting rid of.
 *
 * It used to be a bordered pill floating between the orb and the box, which
 * bought its own row of vertical space to say one short sentence and read as a
 * third object on a screen that already has two. It now sits in the tab above
 * the composer, after the project name and a hairline: **where** the work is
 * happening, then **what** is happening, on one strip.
 *
 * Renders as a **fragment into that flex row**, not as a self-contained block:
 * the hairline is part of what appears and disappears, so it belongs to the
 * thing that may be absent. A separator drawn by the bar would be left hanging
 * with nothing after it every time the assistant went quiet.
 *
 * Split in two on purpose. `AgentActivityTicker` is presentational and takes a
 * phrase; it can be dropped into any horizontal strip without dragging a store
 * behind it. `ConnectedAgentActivity` is the one-line wiring to this
 * application's store.
 */

import React from "react";
import { FileText, FilePen, Terminal, FlaskConical } from "lucide-react";

import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import { currentActivityPhrase, type ActivityPhrase } from "../../services/voice/activityPhrase";
import { BrandGlyph } from "../ui";
import { TemiFace } from "./CliStreamingPanel";

const ICONS = {
  read: FileText,
  edit: FilePen,
  run: Terminal,
  test: FlaskConical,
} as const;

/**
 * Renders the active running CLI logo icon:
 * - Claude Code -> Claude mark
 * - Codex -> Codex mark
 * - Frontier -> Canonical Temi eyes & mouth mark (> _ <)
 * - Gemini -> Gemini mark
 */
export const EngineGlyph: React.FC<{
  engine?: string;
  size?: number;
  className?: string;
  failed?: boolean;
  running?: boolean;
}> = ({ engine = "frontier", size = 14, className = "", failed = false, running = false }) => {
  const norm = (engine || "").toLowerCase();

  if (norm.includes("claude")) {
    return (
      <BrandGlyph
        brand="claude"
        size={size}
        className={`flex-shrink-0 ${className} ${running && !failed ? "animate-pulse" : ""}`}
      />
    );
  }

  if (norm.includes("codex")) {
    return (
      <BrandGlyph
        brand="codex"
        size={size}
        className={`flex-shrink-0 ${className} ${running && !failed ? "animate-pulse" : ""}`}
      />
    );
  }

  if (norm.includes("gemini")) {
    return (
      <BrandGlyph
        brand="gemini"
        size={size}
        className={`flex-shrink-0 ${className} ${running && !failed ? "animate-pulse" : ""}`}
      />
    );
  }

  // Frontier / default: our eyes and mouth logo!
  return (
    <TemiFace
      size={size + 2}
      className={`flex-shrink-0 ${
        failed ? "text-rose-400" : running ? "text-emerald-400" : "text-[#8f8f8f]"
      } ${running && !failed ? "animate-pulse" : ""} ${className}`}
    />
  );
};

export interface AgentActivityTickerProps {
  /** What to show. `null` draws nothing but the live region — see the note on absence. */
  phrase: ActivityPhrase | null;
  /** Active running engine name: "claude" | "codex" | "frontier" | "gemini" */
  engine?: string;
  /** Optional click-through, for surfaces that can open the full activity log. */
  onClick?: () => void;
  className?: string;
}

/**
 * Shows nothing when there is no phrase.
 *
 * Deliberate: an idle placeholder ("no activity") occupies the same space as
 * real news and trains the eye to ignore the strip, which costs exactly when it
 * finally has something to say.
 *
 * The announcement is the exception. The polite region is mounted whether or
 * not there is anything in it, because a live region that is inserted *with*
 * its first message is not reliably announced — screen readers watch regions
 * they already know about. It is `sr-only`, and therefore absolutely
 * positioned, so it is not a flex item and adds no gap to the bar.
 */
export const AgentActivityTicker: React.FC<AgentActivityTickerProps> = ({
  phrase,
  engine,
  onClick,
  className = "",
}) => {
  const storeEngine = useAssistantActivityStore((state) => state.activeEngine);
  const activeEngine = engine || storeEngine || "frontier";

  const failed = phrase?.state === "failed";
  const running = phrase?.state === "running";
  const spoken = phrase ? `${phrase.verb} ${phrase.full ?? phrase.target}`.trim() : "";

  // The diamonds icon was rendered when phrase.icon is "think" or unrecognized.
  // Replaced with the current running CLI logo icon:
  // - Claude Code -> Claude logo
  // - Codex -> Codex logo
  // - Frontier -> Our eyes and mouth logo (TemiFace)
  const isThinkOrDiamond = !phrase || phrase.icon === "think" || !(phrase.icon in ICONS);
  const IconComponent = !isThinkOrDiamond ? ICONS[phrase.icon as keyof typeof ICONS] : null;

  const glyph = IconComponent ? (
    <IconComponent
      size={13}
      strokeWidth={1.8}
      className={`flex-shrink-0 ${failed ? "text-rose-400" : running ? "text-emerald-400" : "text-[#8f8f8f]"} ${
        running && !failed ? "animate-pulse" : ""
      }`}
    />
  ) : (
    <EngineGlyph
      engine={activeEngine}
      size={14}
      failed={failed}
      running={running}
    />
  );

  const body = phrase ? (
    <>
      {glyph}
      <span
        className={`flex-shrink-0 transition-colors ${
          failed ? "text-rose-300" : "text-[#a0a0a0] group-hover:text-[#e8e8e8]"
        }`}
      >
        {phrase.verb}
      </span>
      {phrase.target ? (
        /* `min-w-0` is what makes `truncate` do anything at all here: a flex
           item defaults to `min-width:auto` and will not shrink below its own
           text, so without it a long path pushed the bar wide instead of
           ellipsing — the bug the elision was written to prevent. */
        <span
          className={`min-w-0 truncate font-mono text-[12px] transition-colors ${
            failed ? "text-rose-400/80" : "text-[#7a7a7a] group-hover:text-[#a0a0a0]"
          }`}
        >
          {phrase.target}
        </span>
      ) : null}
    </>
  ) : null;

  /* A control only where there is somewhere to go. `disabled` was the old way
     of saying so, and browsers suppress the tooltip on a disabled element —
     which is the one thing this strip needs, since the target it shows may be
     an elision of the path the tooltip carries.

     Hover is a colour shift and nothing else, which is exactly what the project
     name beside it does: two controls sharing one strip should answer the
     pointer the same way, and a filled hover block here would make the strip
     look like two different kinds of thing. */
  const shared = `group flex min-w-0 items-center gap-1.5 text-[13px] leading-none ${className}`;

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {spoken}
      </span>
      {phrase ? (
        <>
          <span aria-hidden className="h-3.5 w-px flex-shrink-0 bg-[#3d3d3d]" />
          {onClick ? (
            <button
              type="button"
              onClick={onClick}
              title={`${spoken} — open the activity log`}
              aria-label={spoken}
              className={`${shared} cursor-pointer text-left`}
            >
              {body}
            </button>
          ) : (
            <span className={shared} title={spoken}>
              {body}
            </span>
          )}
        </>
      ) : null}
    </>
  );
};

/** The same strip, reading this application's assistant activity and active engine. */
export const ConnectedAgentActivity: React.FC<{ onClick?: () => void; className?: string }> = ({ onClick, className }) => {
  const items = useAssistantActivityStore((state) => state.items);
  const isRunning = useAssistantActivityStore((state) => state.isTaskRunning);
  const latestProgress = useAssistantActivityStore((state) => state.latestProgress);
  const activeEngine = useAssistantActivityStore((state) => state.activeEngine);
  return (
    <AgentActivityTicker
      phrase={currentActivityPhrase(items, isRunning, latestProgress)}
      engine={activeEngine}
      onClick={onClick}
      className={className}
    />
  );
};
