import React, { useEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";

/**
 * The "it is working" line.
 *
 * A local model can take several seconds before its first token arrives, and in
 * that gap an empty message reads as a broken app. This fills it with three
 * things that are all true and all useful: a word that changes so the interface
 * is visibly alive, a timer so a slow turn is legible rather than worrying, and
 * a token count once tokens start arriving.
 *
 * The word rotation is cosmetic and says so — it is not a description of an
 * internal state we do not have. What it does communicate honestly is *phase*:
 * the vocabulary shifts once tokens start flowing, so "still waiting" and
 * "actively writing" never look the same.
 */

/** Before the first token. The model is loading or prefilling. */
const WAITING_WORDS = [
  "Teminaling", "Warming up", "Spinning up", "Gathering", "Considering",
  "Pondering", "Sizing it up", "Reading the room", "Loading weights",
  "Getting oriented", "Thinking it through", "Lining things up",
  "Turning it over", "Settling in", "Consulting the tea leaves",
];

/** After tokens begin. Now it is genuinely producing. */
const WRITING_WORDS = [
  "Teminaling", "Composing", "Drafting", "Writing", "Assembling",
  "Working through it", "Putting it together", "Filling in the details",
  "Threading it together", "Shaping it up", "Building the answer",
];

/** While a tool is mid-flight. */
const TOOL_WORDS = [
  "Running it", "Checking", "Digging in", "Poking around", "Reading files",
  "Following the trail", "Verifying", "Cross-checking",
];

const ROTATE_MS = 2400;

export interface ThinkingIndicatorProps {
  /** True from submit until the turn settles. */
  active: boolean;
  /** Characters received so far; drives the phase and the count. */
  charCount?: number;
  /** A tool is executing right now. */
  toolLabel?: string | null;
  onStop?: () => void;
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  active,
  charCount = 0,
  toolLabel = null,
  onStop,
}) => {
  const startedAt = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [index, setIndex] = useState(0);

  // A fresh turn restarts both the clock and the vocabulary.
  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now();
    setElapsed(0);
    setIndex(Math.floor(Math.random() * WAITING_WORDS.length));
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const tick = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    const rotate = window.setInterval(() => setIndex((previous) => previous + 1), ROTATE_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(rotate);
    };
  }, [active]);

  const words = toolLabel ? TOOL_WORDS : charCount > 0 ? WRITING_WORDS : WAITING_WORDS;
  const word = useMemo(() => words[index % words.length], [words, index]);

  if (!active) return null;

  const seconds = elapsed / 1000;
  // Approximate: four characters to a token is close enough for a live counter
  // and avoids a tokeniser on the render path.
  const tokens = Math.max(0, Math.round(charCount / 4));

  return (
    <div className="flex items-center gap-2.5 py-1 select-none" aria-live="polite">
      <Shimmer>{toolLabel ? `${word} — ${toolLabel}` : word}…</Shimmer>

      <span className="font-mono text-2xs text-ink-faint tabular-nums">
        {seconds < 60 ? `${seconds.toFixed(0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`}
      </span>

      {tokens > 0 && (
        <span className="font-mono text-2xs text-ink-disabled tabular-nums">
          {tokens.toLocaleString()} tokens
        </span>
      )}

      {onStop && (
        <button
          type="button"
          onClick={onStop}
          className="ml-1 inline-flex items-center gap-1 text-2xs text-ink-faint hover:text-danger transition-colors duration-ds ease-ds"
          title="Stop generating (Esc)"
        >
          <Square size={8} fill="currentColor" />
          stop
        </button>
      )}
    </div>
  );
};

/**
 * A light sweep across the word. The motion is what signals "alive" — a static
 * label at 30 seconds looks identical to a hung process.
 */
const Shimmer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    className="text-sm font-medium bg-clip-text text-transparent"
    style={{
      backgroundImage:
        "linear-gradient(90deg, var(--text-placeholder) 0%, var(--text-bright) 45%, var(--text-placeholder) 90%)",
      backgroundSize: "220% 100%",
      animation: "shimmer 2.6s linear infinite",
    }}
  >
    {children}
  </span>
);
