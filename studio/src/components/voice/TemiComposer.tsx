/**
 * The chatbox, and the row of openers that sits under it on an empty chat.
 *
 * Two references, and they answer two different questions. **Codex owns the
 * box**: the project tab peeking above its top edge, the 16px body a shade
 * lighter than the canvas, the placeholder floated to the top-left, and a
 * control row of plus, approvals, engine, microphone, send. **Cursor owns the
 * empty screen** — the box centred on the canvas rather than pinned to the
 * bottom, with a row of outline pills beneath it. The stage decides which
 * layout is in force; this file draws the same box either way, because a
 * composer that changes shape when the conversation starts is two composers.
 *
 * Presentational. It owns no socket, no audio and no store beyond the project
 * library the openers read, so the stage stays the only thing that can talk.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  CircleDashed,
  Folder,
  History,
  Mic,
  MicOff,
  Plus,
  Square,
  X,
} from "lucide-react";

import { ModelPicker } from "../chat/ModelPicker";
import { ComposerMenu } from "../chat/ComposerMenu";
import { useProjectLibrary } from "../../hooks/useProjectLibrary";
import { useGitHubStatus } from "../../hooks/useGitHubStatus";
import { useRecorderDialogStore } from "../../store/recorderDialogStore";
import { SKILLS_LIST, useStudioStore } from "../../store/studioStore";
import { readTrigger, type ActiveTrigger, type ComposerMenuItem } from "../../utils/composerTrigger";
import { atFirstLine, atLastLine } from "../../utils/promptHistory";

export interface TemiComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** The workspace the next turn runs against, or null for "Choose project". */
  projectLabel: string | null;
  onChooseProject?: () => void;
  /**
   * The live process line, drawn into the project tab after the project name.
   *
   * A slot rather than a store read, so this file stays presentational and the
   * stage remains the only thing that talks to anything. Whatever goes here is
   * expected to render as a fragment into a flex row and to draw its own
   * leading separator — a hairline owned by the bar would be left hanging with
   * nothing after it whenever the assistant went quiet.
   */
  activity?: React.ReactNode;
  /** What the engine is allowed to do without asking. Opens the same picker. */
  permissionLabel: string;
  /** The engine, split the way Codex splits "Custom Light": name, then variant. */
  engineHead: string;
  engineTail: string;
  engineTitle: string;
  voiceOn: boolean;
  onToggleMic: () => void;
  /** Only offered while the voice is actually live; there is nothing to end otherwise. */
  onEndVoice?: () => void;
  voiceLive: boolean;
  /** True while a turn is in flight. Send becomes Stop; nothing else moves. */
  isRunning?: boolean;
  onStop?: () => void;
  /**
   * One step through the prompt ring, or `null` when there is nowhere to go —
   * in which case the arrow stays an arrow and moves the caret.
   *
   * The ring lives in the stage rather than here because this component is
   * remounted when the empty screen becomes a conversation, and a history that
   * empties itself the moment you send your first prompt is worse than none.
   */
  onNavigateHistory?: (direction: "older" | "newer", current: string) => string | null;
  placeholder?: string;
  className?: string;
}

export const TemiComposer: React.FC<TemiComposerProps> = ({
  value,
  onChange,
  onSubmit,
  projectLabel,
  onChooseProject,
  activity,
  permissionLabel,
  engineHead,
  engineTail,
  engineTitle,
  voiceOn,
  onToggleMic,
  onEndVoice,
  voiceLive,
  isRunning = false,
  onStop,
  onNavigateHistory,
  placeholder = "Do anything",
  className = "",
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /* ── The / and @ menus ──────────────────────────────────────────────────
     Ported from `chat/Composer.tsx`, which is now only mounted in the side
     panels: the menu, its trigger rules and its nine tests were all built and
     passing against a composer the operator no longer types into. The trigger
     is derived from the caret on every change rather than tracked as a mode,
     so deleting back past the `/` closes the menu with no teardown. */
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
  const [menuItems, setMenuItems] = useState<ComposerMenuItem[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const setSkill = useStudioStore((state) => state.setSkill);

  const syncTrigger = useCallback((element: HTMLTextAreaElement) => {
    const next = readTrigger(element.value, element.selectionStart ?? element.value.length);
    setTrigger(next);
    if (!next) setMenuIndex(0);
  }, []);

  const applyMenuItem = useCallback(
    (item: ComposerMenuItem) => {
      if (!trigger) return;
      const before = value.slice(0, trigger.at);
      const after = value.slice(trigger.at + 1 + trigger.query.length);
      if (item.kind === "skill") {
        // A skill is mounted, not typed: it changes how the next turn is run,
        // so it belongs in state rather than as literal text in the prompt.
        const skill = SKILLS_LIST.find((entry) => entry.id === item.id);
        if (skill) setSkill(skill);
        onChange(`${before}${after}`);
      } else {
        // A file is context: its path goes into the prompt, where the engine
        // already knows how to read an @-path.
        onChange(`${before}@${item.id} ${after}`);
      }
      setTrigger(null);
      setMenuIndex(0);
      requestAnimationFrame(() => areaRef.current?.focus());
    },
    [trigger, value, onChange, setSkill],
  );

  /* The caret goes to the end of a recalled prompt, as it does in a shell.
     `value` arrives as a prop, so this waits a frame for the render. */
  const caretToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.selectionStart = area.selectionEnd = area.value.length;
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // While a trigger menu is open these keys belong to it — otherwise Enter
      // would send a half-written prompt instead of picking the highlighted row.
      if (trigger && menuItems.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setMenuIndex((current) => (current + 1) % menuItems.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setMenuIndex((current) => (current - 1 + menuItems.length) % menuItems.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          applyMenuItem(menuItems[Math.min(menuIndex, menuItems.length - 1)]);
          return;
        }
        if (event.key === "Escape") {
          // Claimed here, so the stage's `useInterruptKey` sees a handled
          // keystroke and does not also stop the run: closing the menu is the
          // whole of what this Escape means.
          event.preventDefault();
          setTrigger(null);
          return;
        }
      }

      // History, but only where the arrow has nothing else to do: on the first
      // line for Up, the last for Down. A two-line draft still edits normally.
      if (onNavigateHistory && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const area = event.currentTarget;
        const caret = area.selectionStart ?? area.value.length;
        const onEdge = event.key === "ArrowUp" ? atFirstLine(value, caret) : atLastLine(value, caret);
        if (onEdge && area.selectionStart === area.selectionEnd) {
          const recalled = onNavigateHistory(event.key === "ArrowUp" ? "older" : "newer", value);
          if (recalled !== null) {
            event.preventDefault();
            caretToEnd();
            return;
          }
        }
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onSubmit();
      }
    },
    [trigger, menuItems, menuIndex, applyMenuItem, onNavigateHistory, value, caretToEnd, onSubmit],
  );

  /* The box is tall to begin with and grows with the draft, which is why the
     field cannot simply be an <input> as it was: a two-line paragraph scrolled
     out of sight inside a single-line box. */
  const resize = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
  }, []);
  useEffect(resize, [value, resize]);

  const canSend = value.trim().length > 0;

  return (
    <div className={`relative ${className}`}>
      {/* The project tab. It is a narrower panel *behind* the box with its top
          edge showing, not a floating chip — which is why it is inset on both
          sides and its bottom corners are square.

          It carries two facts, in the order a person asks them: **where** the
          next turn runs, then — past a hairline — **what** the assistant is
          doing about it. The activity slot used to be a bordered pill floating
          between the orb and this box, buying a whole row of the screen to say
          one short sentence; here it costs nothing, because this strip was
          already drawn and already half empty.

          A row of two controls rather than one control: the activity strip is
          itself clickable (it opens the log) and a button inside a button is
          not markup a browser will honour. */}
      <div className="mx-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-t-[14px] bg-[#212121] px-4 pb-3.5 pt-2 text-[13px]">
        <button
          type="button"
          onClick={onChooseProject}
          title={projectLabel ? `Working in ${projectLabel} — click to open another` : "Choose the project this chat works in"}
          className="flex min-w-0 items-center gap-2 text-left leading-none text-[#a0a0a0] transition-colors hover:text-[#e8e8e8]"
        >
          <Folder size={15} strokeWidth={1.8} className="flex-shrink-0" />
          <span className="truncate">{projectLabel ?? "Choose project"}</span>
        </button>
        {activity}
      </div>

      <div className="relative -mt-3 rounded-[16px] bg-[#252525] px-3.5 pb-2.5 pt-3.5 shadow-[0_8px_28px_-6px_rgba(0,0,0,0.55)]">
        {trigger && (
          <ComposerMenu
            trigger={trigger}
            activeIndex={menuIndex}
            onItems={setMenuItems}
            onSelect={applyMenuItem}
          />
        )}
        <textarea
          ref={areaRef}
          value={value}
          rows={1}
          onChange={(event) => {
            onChange(event.target.value);
            syncTrigger(event.target);
          }}
          onKeyUp={(event) => syncTrigger(event.currentTarget)}
          onClick={(event) => syncTrigger(event.currentTarget)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Message Temi"
          className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-1 text-[16px] leading-relaxed text-white placeholder-[#8a8a8a] focus:outline-none"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onChooseProject}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[#a0a0a0] transition-colors hover:bg-[#333333] hover:text-white"
            title="Attach from the workspace"
            aria-label="Attach from the workspace"
          >
            <Plus size={19} strokeWidth={1.8} />
          </button>

          {/* Codex's "Approve for me". Ours names the rung that is actually in
              force, because the rungs are ours and one of them asks first. */}
          <button
            type="button"
            onClick={() => setPickerOpen((previous) => !previous)}
            className="flex h-8 flex-shrink items-center gap-1.5 overflow-hidden rounded-full px-2 text-[13px] text-[#a0a0a0] transition-colors hover:bg-[#333333] hover:text-white"
            title="What the engine may do without asking"
          >
            <CircleDashed size={15} strokeWidth={1.8} className="flex-shrink-0" />
            <span className="truncate">{permissionLabel}</span>
          </button>

          <div className="flex-1" />

          <div className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setPickerOpen((previous) => !previous)}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              title={engineTitle}
              className="flex h-8 max-w-[200px] items-center gap-1.5 rounded-full px-2 text-[14px] transition-colors hover:bg-[#333333]"
            >
              <span className="truncate text-[#ececec]">{engineHead}</span>
              {engineTail && <span className="truncate text-[#8f8f8f]">{engineTail}</span>}
              <ChevronDown size={15} className="flex-shrink-0 text-[#8f8f8f]" />
            </button>
            <ModelPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
          </div>

          <button
            type="button"
            onClick={onToggleMic}
            aria-pressed={voiceOn}
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
              voiceOn ? "bg-emerald-500/15 text-emerald-300" : "text-[#a0a0a0] hover:bg-[#333333] hover:text-white"
            }`}
            title={voiceOn ? "Voice on — tap to type instead" : "Voice off — tap to speak"}
            aria-label={voiceOn ? "Turn voice off" : "Turn voice on"}
          >
            {voiceOn ? <Mic size={18} strokeWidth={1.8} /> : <MicOff size={18} strokeWidth={1.8} />}
          </button>

          {/* Nothing to end when the pipeline is idle, and Codex's row has no
              such button — so it appears only while there is a session to leave. */}
          {voiceLive && onEndVoice && (
            <button
              type="button"
              onClick={onEndVoice}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[#a0a0a0] transition-colors hover:bg-[#333333] hover:text-white"
              title="End the voice session"
              aria-label="End the voice session"
            >
              <X size={17} strokeWidth={2.2} />
            </button>
          )}

          {/* Stop is drawn *beside* send, not instead of it — the two are
              different actions and a follow-up typed mid-run now queues rather
              than killing what is running (`utils/taskQueue.ts`). Swapping one
              for the other would mean choosing between stopping the run and
              lining up the next thought.

              Stopping used to be two clicks deep in the activity dialog, and
              Escape was dead on this surface entirely, so a run that went wrong
              had nowhere on screen to be stopped from. It is never disabled:
              stopping must not depend on there being a draft to send. */}
          {isRunning && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#3a3a3a] text-white transition-colors hover:bg-[#4a4a4a]"
              title="Stop the running turn (Esc)"
              aria-label="Stop"
            >
              <Square size={13} strokeWidth={0} fill="currentColor" />
            </button>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSend}
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
              canSend
                ? "bg-white text-black hover:bg-[#e5e5e5]"
                : "cursor-default bg-[#2f2f2f] text-[#7a7a7a]"
            }`}
            title={isRunning ? "Send — this will queue behind the running turn" : "Send"}
            aria-label="Send"
          >
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Three marks lucide does not have ────────────────────────────────────── */

/**
 * The GitHub logo, not lucide's outline of it.
 *
 * A brand mark is a specific shape and an approximation of it reads as a
 * mistake — this is the octocat path GitHub publishes, filled, which is the
 * only form the mark is correct in.
 */
const GitHubMark: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

/**
 * A filled bulb: glass dome, then a screw base of two bars.
 *
 * The base is two solid bars rather than a hairline because this is drawn at
 * 14px. Rendered and looked at: the conventional single-hairline base
 * disappears at that size and what is left reads as a mushroom.
 */
const LightBulbMark: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
    <path d="M12 1.5a7.5 7.5 0 0 0-4.2 13.72V16.5h8.4v-1.28A7.5 7.5 0 0 0 12 1.5Z" />
    <rect x="8.1" y="18" width="7.8" height="2.1" rx="1.05" />
    <rect x="9.6" y="21.4" width="4.8" height="2.1" rx="1.05" />
  </svg>
);

/**
 * The record button: a red disc inside a ring.
 *
 * Red is the one place on this screen it is not an alert — it is what a record
 * control has been for fifty years, and a muted one would not be read as a
 * record control at all. The ring is `currentColor` so the pill's hover still
 * moves; only the disc is fixed.
 */
const RecordDot: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
    <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="5" fill="#ef4444" />
  </svg>
);

/* ── The openers under the box ───────────────────────────────────────────── */

export interface TemiActionRowProps {
  /** Seeds the composer; the operator still presses send. */
  onDraft: (text: string) => void;
  onConnectGitHub?: () => void;
  onOpenWorkspace?: () => void;
  className?: string;
}

/**
 * Cursor's outline pills, carrying the surfaces the empty screen lost.
 *
 * Every one of these already existed and had nothing pointing at it: the
 * recorder dialog, the project library and the GitHub connect flow were all
 * still wired into `StudioChat`, whose render was replaced by the voice stage.
 * This is that row put back, not new machinery.
 *
 * Empty chat only. Once there is a conversation the box docks to the bottom
 * and these go away — they are ways to start, and starting is over.
 */
export const TemiActionRow: React.FC<TemiActionRowProps> = ({
  onDraft,
  onConnectGitHub,
  onOpenWorkspace,
  className = "",
}) => {
  const { recent, openEntry } = useProjectLibrary();
  const { status: github } = useGitHubStatus();
  const openRecorder = useRecorderDialogStore((state) => state.open);
  const [recentsOpen, setRecentsOpen] = useState(false);

  // Six is what the popover shows without becoming a file browser; the sidebar
  // is where the whole library lives.
  const shown = recent.slice(0, 6);

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <Pill icon={<LightBulbMark />} onClick={() => onDraft("Plan: ")}>
        Plan New Idea
      </Pill>

      <Pill icon={<RecordDot />} onClick={openRecorder}>
        Screen Recorder
      </Pill>

      <div className="relative">
        <Pill
          icon={<History size={14} strokeWidth={1.8} />}
          onClick={() => (shown.length > 0 ? setRecentsOpen((previous) => !previous) : onOpenWorkspace?.())}
          trailing={shown.length > 0 ? <ChevronDown size={13} className="text-[#7a7a7a]" /> : undefined}
        >
          Recent Projects
        </Pill>
        {recentsOpen && shown.length > 0 && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setRecentsOpen(false)} />
            <div className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-[#3a3a3a] bg-[#212121] py-1 shadow-2xl">
              {shown.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    setRecentsOpen(false);
                    void openEntry(entry);
                  }}
                  title={entry.path}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[#d4d4d4] transition-colors hover:bg-[#2f2f2f] hover:text-white"
                >
                  <Folder size={14} strokeWidth={1.8} className="flex-shrink-0 text-[#8f8f8f]" />
                  <span className="truncate">{entry.name}</span>
                  {entry.kind === "video" && (
                    <span className="ml-auto flex-shrink-0 text-[11px] text-[#7a7a7a]">video</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <Pill icon={<GitHubMark />} onClick={onConnectGitHub}>
        {github?.connected ? "Open a Repository" : "Connect Your Repos"}
      </Pill>
    </div>
  );
};

/**
 * The outline pill. Transparent fill and one flat hairline — the only control
 * on this screen drawn as an outline rather than a fill, which is what makes it
 * read as a suggestion rather than as a button you are expected to press.
 */
const Pill: React.FC<{
  children: React.ReactNode;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
}> = ({ children, icon, trailing, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-8 items-center gap-1.5 rounded-full border border-[#333333] px-3 text-[13px] text-[#a0a0a0] transition-colors hover:border-[#4a4a4a] hover:bg-[#1e1e1e] hover:text-white"
  >
    {icon && <span className="flex flex-shrink-0 items-center">{icon}</span>}
    {children}
    {trailing}
  </button>
);
