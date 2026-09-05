import React, { useEffect, useRef, useState } from "react";
import { Lock, Plus, Square, Mic, X } from "lucide-react";
import { VoiceButton } from "../voice/VoiceButton";
import { VoiceOrb } from "../voice/VoiceOrb";
import { VoiceReviewBar } from "../voice/VoiceReviewBar";
import { VoiceHud } from "../voice/VoiceHud";
import type { UseVoiceResult } from "../../hooks/useVoice";
import { useAssistantSession } from "../assistant/AssistantContext";
import { ModelPicker } from "./ModelPicker";
import { ComposerMenu } from "./ComposerMenu";
import { readTrigger, type ActiveTrigger, type ComposerMenuItem } from "../../utils/composerTrigger";
import { AttachmentStrip } from "./AttachmentStrip";
import { filesFromClipboard, type UseAttachmentsResult } from "../../hooks/useAttachments";
import { SKILLS_LIST, useStudioStore } from "../../store/studioStore";

/**
 * The prompt composer, used by both the empty state and the live conversation.
 *
 * It is the only place voice and typing meet, so it owns the arbitration
 * between them: while an utterance is awaiting approval the review bar sits
 * above the field, and in hands-free mode the HUD replaces the field entirely
 * rather than leaving a text box that nobody is typing into.
 */

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  placeholder?: string;
  modelName: string;
  onPickModel?: () => void;
  onAttach?: () => void;
  voice: UseVoiceResult;
  /** Attachment intake. Omit to disable file sharing on this surface. */
  attachments?: UseAttachmentsResult;
  /** Taller field with the placeholder floated to the top, as in the design. */
  tall?: boolean;
  /**
   * `column` keeps the composer inside the reading column of the main chat;
   * `fill` lets it take the full width of a narrow panel, where a centred
   * column would waste space that is already scarce.
   */
  width?: "column" | "fill";
  autoFocus?: boolean;
}

/** How long a fresh "keep going" outranks the running commentary in the caption. */
const INTENT_CAPTION_MS = 6000;

const INTENT_LABEL: Record<string, string> = {
  stop: "stopped",
  acknowledge: "carrying on",
  status: "answering",
};

/**
 * One line under the orb. While the run is working it is the assistant's
 * latest progress line; while you talk over it, it is how that was read. A
 * dropped or reinterpreted utterance that leaves no trace is indistinguishable
 * from a broken microphone, which is what "it's not responding" usually means.
 */
function voiceCaption(voice: UseVoiceResult, streaming: boolean): string | null {
  if (voice.state === "hearing") return null;
  const busy = streaming || voice.state === "thinking" || voice.state === "sending";
  const intent = voice.lastIntent;
  // A fresh "keep going" beats the narration for a few seconds: the operator
  // must see it was heard as encouragement, not as an instruction.
  const freshAck = intent?.intent === "acknowledge" && Date.now() - intent.at < INTENT_CAPTION_MS;
  if (!freshAck && (voice.state === "speaking" || busy)) {
    if (voice.narration) return voice.narration;
  }
  if ((busy || freshAck) && intent && intent.intent !== "instruction") {
    const heard = intent.text.length > 42 ? `${intent.text.slice(0, 41).trim()}…` : intent.text;
    return `Heard “${heard}” — ${INTENT_LABEL[intent.intent] ?? intent.intent}`;
  }
  if (busy) return voice.narration ?? "Working…";
  return null;
}

export const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  placeholder = "Plan, Build, / for skills, @ for context",
  modelName,
  onPickModel,
  onAttach,
  voice,
  attachments,
  tall = false,
  width = "column",
  autoFocus = false,
}) => {
  const pickerRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The one screen assistant, if this composer is inside the shell.
   *
   * The microphone below opens it; it is not a recorder of its own. Which of
   * the assistant's three modes is selected decides what the utterance becomes
   * — words in this field, an explanation of what is on screen, or an action —
   * and that switch lives in the assistant, not here.
   */
  const assistant = useAssistantSession();

  // Grow with content up to a ceiling, then scroll.
  const [wrapped, setWrapped] = useState(false);
  useEffect(() => {
    const node = areaRef.current;
    if (!node) return;
    node.style.height = "auto";
    const height = Math.min(200, node.scrollHeight);
    node.style.height = `${height}px`;
    // A pill's radius is half its height, so a follow-up bar that grows a
    // second line stops being a pill and becomes a lozenge. Remember that it
    // grew, so the shell below can fall back to a fixed corner.
    const line = parseFloat(getComputedStyle(node).lineHeight) || 20;
    setWrapped(height > line * 1.6);
  }, [value]);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        event.preventDefault();
        setTrigger(null);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  const [pickerOpen, setPickerOpen] = useState(false);

  /* ── The / and @ menus ──────────────────────────────────────────────────
     The placeholder has advertised both since this composer was written; this
     is what makes the promise real. The trigger is derived from the caret on
     every change rather than tracked as a mode, so deleting back past the `/`
     closes the menu without any teardown of its own. */
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
  const [menuItems, setMenuItems] = useState<ComposerMenuItem[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const setSkill = useStudioStore((state) => state.setSkill);

  const syncTrigger = (element: HTMLTextAreaElement) => {
    const next = readTrigger(element.value, element.selectionStart ?? element.value.length);
    setTrigger(next);
    if (!next) setMenuIndex(0);
  };

  const applyMenuItem = (item: ComposerMenuItem) => {
    if (!trigger) return;
    if (item.kind === "skill") {
      // A skill is mounted, not typed: it changes how the next turn is run, so
      // it belongs in state rather than as literal text in the prompt.
      const skill = SKILLS_LIST.find((entry) => entry.id === item.id);
      if (skill) setSkill(skill);
      const before = value.slice(0, trigger.at);
      const after = value.slice(trigger.at + 1 + trigger.query.length);
      onChange(`${before}${after}`);
    } else {
      // A file is context: its path goes into the prompt, where the engine
      // already knows how to read an @-path.
      const before = value.slice(0, trigger.at);
      const after = value.slice(trigger.at + 1 + trigger.query.length);
      onChange(`${before}@${item.id} ${after}`);
    }
    setTrigger(null);
    setMenuIndex(0);
    requestAnimationFrame(() => areaRef.current?.focus());
  };
  const conversation = voice.mode === "conversation" && voice.state !== "idle";
  const reviewing = voice.state === "review" && voice.pending !== null;

  useEffect(() => {
    if (reviewing && voice.pending) {
      void voice.approve(voice.pending.repaired);
    }
  }, [reviewing, voice]);

  /* The follow-up bar is a true pill only while it is one row high. An
     attachment or a wrapped line makes it tall, and half of a tall box is the
     lozenge that pasting an image used to produce. */
  const pill = !wrapped && (attachments?.attachments.length ?? 0) === 0;

  return (
    <div className={`relative w-full flex flex-col gap-2.5 ${width === "column" ? (tall ? "max-w-composerEmpty" : "max-w-composer") : ""}`}>
      {trigger && (
        <ComposerMenu
          trigger={trigger}
          activeIndex={menuIndex}
          onItems={setMenuItems}
          onSelect={applyMenuItem}
        />
      )}
      {voice.error && (
        <p className="text-2xs text-danger px-1">
          {voice.error.message}
          {voice.error.code === "MIC_DENIED" && " Grant microphone access in system settings to use voice."}
        </p>
      )}

      {conversation && !tall && (
        <div className="w-full flex flex-col items-center gap-1 pb-3.5 overflow-visible">
          <div className="relative p-2 overflow-visible animate-float">
            <VoiceOrb
              state={voice.state}
              level={voice.level}
              size={56}
              onClick={() => void voice.stop()}
              title="Click to end voice conversation"
            />
          </div>
          {/* What the assistant last said about the run, or how it read what
              you said over it. A decision you cannot see is one you cannot
              correct, so "keep going" shows as carrying on, not as silence. */}
          {(() => {
            const caption = voiceCaption(voice, streaming);
            return caption ? (
              <p className="max-w-[28rem] px-2 text-2xs text-ink-muted text-center truncate" aria-live="polite">
                {caption}
              </p>
            ) : null;
          })()}
        </div>
      )}

      {conversation ? (
        /* ChatGPT Astra Voice Input Bar — matches Screenshot 1, 2, 3 */
        <div className="lit lit-strong lit-focus w-full bg-surface rounded-full px-3.5 py-1.5 flex items-center justify-between gap-3 border border-edge-subtle shadow-xl">
          <button
            type="button"
            onClick={onAttach}
            className="w-8 h-8 rounded-full flex items-center justify-center text-ink-muted hover:text-ink-high hover:bg-surface-hover transition-colors flex-shrink-0"
            title="Attach file"
            aria-label="Attach file"
          >
            <Plus size={16} />
          </button>
          <input
            type="text"
            value={value}
            onChange={(e) => {
              voice.touch();
              onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Type"
            className="flex-1 bg-transparent border-none outline-none text-sm text-ink-high placeholder:text-ink-muted px-1"
          />
          {value.trim() && (
            <button
              type="button"
              onClick={onSubmit}
              className="w-7 h-7 rounded-full bg-accent text-accent-ink hover:opacity-90 flex items-center justify-center transition-opacity flex-shrink-0"
              title={streaming ? "Interrupt and send" : "Send"}
              aria-label="Send"
            >
              <span className="text-xs leading-none font-bold">↑</span>
            </button>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => {
                if (voice.state === "listening" || voice.state === "hearing") {
                  voice.silence();
                }
              }}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                voice.state === "hearing"
                  ? "text-success bg-success/15"
                  : "text-ink-muted hover:text-ink-high hover:bg-surface-hover"
              }`}
              title={voice.state === "hearing" ? "Hearing you" : "Listening"}
              aria-label="Microphone"
            >
              <Mic size={15} />
            </button>
            <button
              type="button"
              onClick={() => void voice.stop()}
              className="w-8 h-8 rounded-full bg-surface-chip flex items-center justify-center text-ink-muted hover:text-danger hover:bg-danger/20 transition-colors"
              title="End voice conversation"
              aria-label="End voice conversation"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div
          {...(attachments?.dropProps ?? {})}
          onPaste={(event) => {
            if (!attachments) return;
            const files = filesFromClipboard(event);
            if (files.length === 0) return;
            // Only claim the paste when it carried files; pasting text must
            // still land in the field.
            event.preventDefault();
            attachments.add(files);
          }}
          /* Two shapes, one component. The empty-state composer is a 16px
             rounded box with the field floated to the top; the follow-up bar is
             a true pill — its radius is half its height, which is why it cannot
             be `rounded-2xl` and get there. Both sit on #212121 behind a flat
             #3a3a3a hairline, the brightest border in the window. */
          className={`lit lit-strong lit-focus w-full bg-surface transition-[border-radius,background-color,border-color] duration-ds ease-ds ${
            tall
              ? "rounded-2xl px-3.5 pt-4 pb-3"
              : `${pill ? "rounded-full" : "rounded-2xl"} px-2 py-[9px]`
          } ${attachments?.isDragging ? "lit-accent" : ""}`}
        >
          {attachments && attachments.attachments.length > 0 && (
            <div className="pb-2.5 pt-0.5">
              <AttachmentStrip
                attachments={attachments.attachments}
                onRemove={attachments.remove}
                compact={!tall}
              />
            </div>
          )}

          {attachments?.isDragging && (
            <p className="pb-2 text-2xs text-accent">Drop to attach — any file type.</p>
          )}
          {attachments?.error && <p className="pb-2 text-2xs text-danger">{attachments.error}</p>}
          {/* The empty-state field.
              
              The placeholder is drawn as an absolutely positioned line *over*
              the textarea rather than in front of it in the flow. That is not
              decoration: the field must exist whether or not it has a value,
              because it is the thing being typed into. A previous version
              mounted it only when `value` was already non-empty, which meant
              the empty box — the one every new chat opens on — had no input in
              it at all, and no keystroke could give it one. See
              tests/composer-input.test.mjs.

              Absolute rather than conditional flow so the box does not change
              height on the first keystroke, and `pointer-events-none` so a
              click anywhere in it lands on the field underneath. */}
          {tall && (
            <div className="relative pb-8">
              {!value && (
                <p className="absolute inset-x-0 top-0 text-md text-ink-placeholder pointer-events-none select-none">
                  {placeholder}
                </p>
              )}
              <textarea
                ref={areaRef}
                value={value}
                onChange={(event) => {
                  voice.touch();
                  onChange(event.target.value);
                  syncTrigger(event.target);
                }}
                onKeyUp={(event) => syncTrigger(event.currentTarget)}
                onClick={(event) => syncTrigger(event.currentTarget)}
                onKeyDown={onKeyDown}
                rows={1}
                aria-label={placeholder}
                className="relative w-full bg-transparent outline-none resize-none text-md text-ink-high leading-relaxed"
              />
            </div>
          )}

          <div className="flex items-center gap-3">
            {/* A filled disc with a plus inside it, not an outlined plus-in-a-
                circle glyph. Cursor draws this as a surface, so it reads as the
                same kind of object as the send button opposite it. */}
            <button
              type="button"
              onClick={() => (attachments ? pickerRef.current?.click() : onAttach?.())}
              title={attachments ? "Attach a file — or just drop or paste one" : "Attach context"}
              style={{ width: "var(--control-disc)", height: "var(--control-disc)" }}
              className="rounded-full bg-surface-control hover:bg-edge-popover text-ink-dim hover:text-ink-high flex items-center justify-center transition-colors duration-ds ease-ds flex-shrink-0"
            >
              <Plus size={15} strokeWidth={1.8} />
            </button>
            {attachments && (
              <input
                ref={pickerRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files?.length) attachments.add(event.target.files);
                  // Reset so choosing the same file twice still fires.
                  event.target.value = "";
                }}
              />
            )}

            {/* In the follow-up bar the field is inline; in the tall empty-state
                variant it lives above this row instead. */}
            {!tall && (
              <textarea
                ref={areaRef}
                value={value}
                onChange={(event) => {
                  voice.touch();
                  onChange(event.target.value);
                  syncTrigger(event.target);
                }}
                onKeyUp={(event) => syncTrigger(event.currentTarget)}
                onClick={(event) => syncTrigger(event.currentTarget)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={placeholder}
                className="flex-1 min-w-0 bg-transparent outline-none resize-none text-sm text-ink-high placeholder:text-ink-placeholder leading-snug py-0.5 max-h-24"
              />
            )}

            <div className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => {
                  setPickerOpen((previous) => !previous);
                  onPickModel?.();
                }}
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                className="flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink-high transition-colors duration-ds ease-ds"
              >
                {modelName}
                <Lock size={12} className="text-ink-soft" strokeWidth={1.8} />
              </button>
              <ModelPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
            </div>

            {tall && <div className="flex-1" />}

            {/* Live transcript lands in the field as it is spoken, so dictation
                and typing are visibly the same input. */}
            {voice.state === "hearing" && voice.transcript && (
              <span className="text-2xs text-ink-faint truncate max-w-[180px]">{voice.transcript}</span>
            )}

            {streaming ? (
              value.trim() ? (
                <button
                  type="button"
                  onClick={onSubmit}
                  title="Interrupt and send"
                  aria-label="Interrupt and send"
                  className="w-6 h-6 rounded-full bg-accent text-accent-ink hover:opacity-90 flex items-center justify-center flex-shrink-0 transition-colors duration-ds ease-ds shadow-sm"
                >
                  <span className="text-sm leading-none font-bold">↑</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStop}
                  title="Stop generating"
                  aria-label="Stop generating"
                  className="w-6 h-6 rounded-full bg-danger/20 text-danger flex items-center justify-center flex-shrink-0 hover:bg-danger/30 transition-colors duration-ds ease-ds"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              )
            ) : value.trim() ? (
              <button
                type="button"
                onClick={onSubmit}
                title="Send"
                className="w-6 h-6 rounded-full bg-ink-high text-frame-top flex items-center justify-center flex-shrink-0 hover:bg-accent-hover transition-colors duration-ds ease-ds"
              >
                <span className="text-sm leading-none">↑</span>
              </button>
            ) : (
              /* One assistant, two entry points: this and the global shortcut.
                 Both call `beginListening`, which opens the session, starts the
                 look at the screen and then opens this same microphone — so the
                 slow half of a turn is already running while the sentence is
                 still being said. */
              <VoiceButton
                state={voice.state}
                level={voice.level}
                mode={assistant?.settings.mode ?? "dictate"}
                onDictate={() => void voice.startConversation()}
                onConversation={() => void voice.startConversation()}
                onStop={() => {
                  assistant?.cancel();
                  void voice.stop();
                }}
                size={24}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
