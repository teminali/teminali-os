import React, { useEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";

/**
 * The "it is working" line, for the gap before anything else exists.
 *
 * A local model can take several seconds before its first token, and in that
 * gap an empty message reads as a broken app. This fills it with three things
 * that are all true: a word that changes so the interface is visibly alive, a
 * timer so a slow turn is legible rather than worrying, and a token count once
 * tokens start arriving.
 *
 * The word rotation is cosmetic and says so. What it does communicate honestly
 * is *phase*: the vocabulary shifts once tokens flow, so "still waiting" and
 * "actively writing" never look the same.
 *
 * The sweep across it is one grey moving through a lighter grey. It used to be
 * a cyan-violet-amber gradient, which was the single loudest thing in a window
 * whose whole palette is five greys — a spinner should not be the brightest
 * object on the screen.
 */

/** Before the first token. The model is loading or prefilling. */
const WAITING_WORDS = [
  "Warming up", "Spinning up", "Gathering", "Considering", "Pondering",
  "Sizing it up", "Loading weights", "Getting oriented", "Thinking it through",
  "Lining things up", "Turning it over", "Settling in",
];

/** After tokens begin. Now it is genuinely producing. */
const WRITING_WORDS = [
  "Composing", "Drafting", "Writing", "Assembling", "Working through it",
  "Putting it together", "Filling in the details", "Shaping it up",
];

/** While a tool is mid-flight. */
const TOOL_WORDS = ["Running it", "Checking", "Digging in", "Reading files", "Following the trail", "Verifying"];

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
    const tick = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
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
  // Four characters to a token is close enough for a live counter, and avoids
  // running a tokeniser on the render path.
  const tokens = Math.max(0, Math.round(charCount / 4));

  return (
    <div className="h-6 flex items-center gap-2 select-none" aria-live="polite">
      <span className="text-shimmer text-xs">{toolLabel ? `${word} — ${toolLabel}` : word}…</span>

      <span className="font-mono text-2xs text-ink-disabled tabular-nums">
        {seconds < 60 ? `${seconds.toFixed(0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`}
      </span>

      {tokens > 0 && <span className="font-mono text-2xs text-ink-disabled tabular-nums">{tokens.toLocaleString()} tokens</span>}

      {onStop && (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex items-center gap-1 text-2xs text-ink-disabled hover:text-danger transition-colors duration-ds ease-ds"
          title="Stop generating (Esc)"
        >
          <Square size={7} fill="currentColor" />
          stop
        </button>
      )}
    </div>
  );
};
