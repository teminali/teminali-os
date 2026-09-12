/**
 * The conversation, rendered the way the reference voice screen renders it.
 *
 * The asymmetry is the whole point and is not decoration: **the operator's
 * turns are bubbles, Temi's are not.** Two facing walls of bubbles is what
 * makes a chat feel busy; one wall against plain prose reads as someone
 * talking to you. Everything else here — the width, the spacing, the muted
 * action row — exists to keep Temi's side looking like speech rather than
 * like a message.
 *
 * Presentational on purpose. It takes turns and callbacks and owns no store,
 * no socket and no scrolling: the stage positions it, because the stage is
 * what has an orb and a composer floating over it.
 */

import React, { useCallback, useState } from "react";
import { Check, Copy, MoreHorizontal, ThumbsUp } from "lucide-react";
import { CursorMarkdownRenderer } from "../chat/CursorMarkdownRenderer";

export interface DialogueTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** A turn still being spoken or transcribed. Renders with a live caret. */
  pending?: boolean;
}

export interface TemiTranscriptProps {
  turns: DialogueTurn[];
  /** Speak an earlier answer again. Absent hides the option. */
  onRepeat?: (text: string) => void;
  onCopied?: () => void;
  className?: string;
}

const LiveCaret: React.FC<{ tone: "user" | "assistant" }> = ({ tone }) => (
  <span
    aria-hidden
    className={`ml-1 inline-block h-[0.9em] w-[2px] translate-y-[2px] animate-pulse ${
      tone === "user" ? "bg-white/70" : "bg-[#8f8f8f]"
    }`}
  />
);

/** The muted row under one of Temi's answers: copy, mark, overflow. */
const AssistantActions: React.FC<{
  text: string;
  onRepeat?: (text: string) => void;
  onCopied?: () => void;
}> = ({ text, onRepeat, onCopied }) => {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        onCopied?.();
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => undefined
    );
  }, [text, onCopied]);

  const button =
    "flex h-7 w-7 items-center justify-center rounded-md text-[#8f8f8f] transition-colors hover:bg-[#212121] hover:text-[#ececec]";

  return (
    <div className="mt-1.5 flex items-center gap-0.5 opacity-60 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
      <button type="button" onClick={copy} className={button} title="Copy" aria-label="Copy answer">
        {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
      </button>

      <button
        type="button"
        onClick={() => setLiked((previous) => !previous)}
        aria-pressed={liked}
        className={`${button} ${liked ? "text-[#ececec]" : ""}`}
        title={liked ? "Marked as a good answer" : "Good answer"}
        aria-label="Good answer"
      >
        <ThumbsUp size={15} className={liked ? "fill-current" : ""} />
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((previous) => !previous)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={button}
          title="More"
          aria-label="More actions"
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && (
          <>
            {/* Click-away. Sits under the menu, over everything else. */}
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              role="menu"
              className="absolute bottom-full left-0 z-50 mb-1 w-[176px] overflow-hidden rounded-xl border border-[#3a3a3a] bg-[#2f2f2f] py-1 shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
            >
              {onRepeat && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRepeat(text);
                  }}
                  className="w-full px-3 py-2 text-left text-[13px] text-[#ececec] transition-colors hover:bg-[#3f3f3f]"
                >
                  Say that again
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  copy();
                }}
                className="w-full px-3 py-2 text-left text-[13px] text-[#ececec] transition-colors hover:bg-[#3f3f3f]"
              >
                Copy text
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * A turn with nothing in it is not a turn, and must not be drawn.
 *
 * Neither side of this screen is invisible when its text is: the operator's
 * side draws its shape first, so an empty turn is a green pill with 20px of
 * padding and no words in it — a blob against the right margin — and Temi's
 * side is a zero-height block that still spends the column's `gap-8`, so it is
 * a 32px hole between two things she said.
 *
 * Both are reachable with nothing going wrong. This transcript renders
 * `frontierMessages`, the same conversation the chat panel writes (see
 * `dialogueFromMessages`), and the panel appends `{ role: "assistant",
 * content: "" }` as its streaming placeholder before every answer — so the
 * hole is on screen for the whole of every answer typed in the panel, and
 * stays for good when a run ends having produced no text. On the operator's
 * side, Gemini's input transcription arrives in fragments and a fragment can
 * be a single space, which `final_user_request` trims to nothing and stores.
 *
 * Judged on trimmed content, because whitespace draws the same empty shape as
 * no content at all. Pending turns are held to the same rule: the state they
 * would be reporting is already on the orb and the status dot, and a caret
 * inside an empty pill is not what "she is hearing you" looks like.
 */
const hasWords = (turn: DialogueTurn): boolean => turn.content.trim().length > 0;

export const TemiTranscript: React.FC<TemiTranscriptProps> = ({
  turns,
  onRepeat,
  onCopied,
  className = "",
}) => (
  <div className={`flex flex-col gap-8 ${className}`}>
    {turns.filter(hasWords).map((turn) =>
      turn.role === "user" ? (
        // The operator: a bubble, right-aligned, never wider than 70% of the
        // column so the ragged left edge stays legible.
        <div key={turn.id} className="flex justify-end">
          <div className="max-w-[70%] whitespace-pre-wrap break-words rounded-3xl bg-[#06512f] px-5 py-3.5 text-[16px] leading-[1.6] text-white">
            {turn.content}
            {turn.pending && <LiveCaret tone="user" />}
          </div>
        </div>
      ) : (
        <div key={turn.id} className="group flex flex-col items-start">
          {/*
            Temi's side is markdown, the operator's is not.

            An answer arrives as an answer — headings, a list of steps, a table,
            a fenced command — and rendering it as one string of source put
            literal `**` on the screen. It goes through the same renderer the
            panel chats use rather than a second one written for this surface;
            `scale="stage"` is what makes that renderer 16px prose in this
            screen's own palette instead of 13px on the token ramp. The caret
            is handed to it rather than placed after it, so a half-spoken
            sentence still ends in a caret rather than dropping one onto the
            line below.
          */}
          <div className="max-w-full break-words text-[16px] leading-[1.75] text-[#f3f3f3]">
            <CursorMarkdownRenderer
              content={turn.content}
              scale="stage"
              isStreaming={turn.pending}
              trailing={turn.pending ? <LiveCaret tone="assistant" /> : undefined}
            />
          </div>
          {/* No actions on a half-spoken answer — there is nothing settled to
              copy yet, and the row would jump as the text grows. Emptiness is
              not re-checked here: `hasWords` has already dropped those turns. */}
          {!turn.pending && (
            <AssistantActions text={turn.content} onRepeat={onRepeat} onCopied={onCopied} />
          )}
        </div>
      )
    )}
  </div>
);
