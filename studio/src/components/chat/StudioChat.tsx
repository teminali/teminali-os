import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Laptop } from "lucide-react";
import { AIService } from "../../services/aiService";
import { useStudioStore, PROFILES_LIST } from "../../store/studioStore";
import { usePanelStore } from "../../store/panelStore";
import { useRecorderDialogStore } from "../../store/recorderDialogStore";
import { useVoice } from "../../hooks/useVoice";
import { useAttachments } from "../../hooks/useAttachments";
import { composePrompt } from "../../services/fileService";
import { useCommandApproval } from "../../hooks/useCommandApproval";
import { CommandApprovalPrompt } from "./CommandApprovalPrompt";
import { Composer } from "./Composer";
import { MessageBlock } from "./MessageBlock";
import { speakableText } from "../../services/voice";
import { useGitHubStatus } from "../../hooks/useGitHubStatus";
import { UsageService } from "../../services/usageService";
import { AssistantHud } from "../assistant/AssistantHud";
import { BrandGlyph } from "../ui/BrandGlyph";
import type { UseAssistantResult } from "../../hooks/useAssistant";
import type { ChatMessage } from "../../types";

/**
 * The centre column — the conversation itself.
 *
 * Two states share one composer: an empty state that offers the repository,
 * branch and machine the next turn will run against, and the live transcript.
 * Voice is wired here rather than in the composer because sending, streaming
 * and speaking the reply are all one loop: the engine hands us an approved
 * utterance, we run it through the chat, and when the reply settles we hand it
 * back to be read aloud.
 */


export const StudioChat: React.FC<{
  /** The one screen assistant, created by the shell. */
  assistant: UseAssistantResult;
  onConnectGitHub?: () => void;
  onOpenWorkspace?: () => void;
}> = ({ assistant, onConnectGitHub, onOpenWorkspace }) => {
  const {
    frontierMessages,
    isStreaming,
    addMessageToEngine,
    updateLastMessageInEngine,
    setStreaming,
    currentProfile,
    activeSkill,
    screenshotToCodeStack,
    openFileAtSnippet,
  } = useStudioStore();

  const { status: github } = useGitHubStatus();
  const openPanel = usePanelStore((state) => state.open);
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);
  const openRecorder = useRecorderDialogStore((state) => state.open);
  const panelExpanded = usePanelStore((state) => state.isExpanded && state.isOpen);
  const agentSelection = useStudioStore((state) => state.agentSelection);
  const agentPermission = useStudioStore((state) => state.agentPermission);
  const chatDraft = useStudioStore((state) => state.chatDraft);
  const setChatDraft = useStudioStore((state) => state.setChatDraft);

  // Another surface handed the composer some text. Take it once and clear the
  // box, so it lands as an editable draft rather than being sent for them.
  useEffect(() => {
    if (chatDraft === null) return;
    setInput((current) => (current ? `${current}\n\n${chatDraft}` : chatDraft));
    setChatDraft(null);
  }, [chatDraft, setChatDraft]);
  const workspacePath = useStudioStore((state) => state.workspacePath);
  const workspaceName = workspacePath ? workspacePath.split("/").filter(Boolean).pop() : "";

  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // An agent CLI keeps its own resumable session. Holding it here makes the main
  // conversation a continuous thread for the agent as well, not a series of
  // one-shots that have each forgotten the last.
  const agentSessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const commandApproval = useCommandApproval();
  const attachments = useAttachments();

  const profile = useMemo(
    () => PROFILES_LIST.find((entry) => entry.id === currentProfile) ?? PROFILES_LIST[1],
    [currentProfile],
  );

  // The composer names what will actually run the next turn. When an agent is
  // selected that is the agent, not the Frontier lane sitting behind it.
  const modelLabel = agentSelection?.label ?? profile.name;

  // Switching agent — or leaving one — invalidates the session id: a Codex
  // thread cannot be resumed by Claude Code, and resuming the wrong one fails
  // rather than politely starting fresh.
  useEffect(() => {
    agentSessionRef.current = null;
  }, [agentSelection?.engine, agentSelection?.model]);

  const messages = frontierMessages ?? [];
  const isEmpty = messages.length === 0;

  /* ── Sending ───────────────────────────────────────────────────────────── */

  // Held in a ref so the voice engine, which is created once, always calls the
  // current version rather than the one captured at mount.
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});

  const send = useCallback(
    async (text: string) => {
      const ready = attachments.attachments.filter((entry) => entry.status === "ready");
      const typed = text.trim();
      // An attachment alone is a valid turn: dropping a PDF and pressing enter
      // should ask about the PDF.
      if ((!typed && ready.length === 0) || isStreaming || attachments.busy) return;

      const { prompt, images } = composePrompt(typed, attachments.attachments);
      setInput("");
      attachments.clear();
      const controller = new AbortController();
      abortRef.current = controller;

      const history = [...messages];
      addMessageToEngine("frontier", {
        role: "user",
        // Show what was typed, not the framed attachment payload.
        content: typed || ready.map((entry) => entry.name).join(", "),
        images: images.length > 0 ? images : undefined,
        tokensCount: Math.max(1, Math.ceil(prompt.length / 4)),
      });
      addMessageToEngine("frontier", {
        role: "assistant",
        content: "",
        isStreaming: true,
        tokensCount: 0,
        costUsd: 0,
        costLabel: profile.costLabel,
      });
      setStreaming(true);

      let accumulated = "";
      await AIService.streamMessage(
        agentSelection?.engine ?? "frontier",
        prompt,
        history,
        {
          onToken: (token) => {
            accumulated += token;
            updateLastMessageInEngine("frontier", () => ({
              content: accumulated,
              tokensCount: Math.max(1, Math.ceil(accumulated.length / 4)),
              isStreaming: true,
            }));
          },
          onToolCall: (call) => {
            // Replace in place when the same call transitions running →
            // completed, so a step updates rather than duplicating.
            updateLastMessageInEngine("frontier", (message) => {
              const existing = message.toolCalls ?? [];
              const index = existing.findIndex((entry) => entry.id === call.id);
              const next = index >= 0
                ? existing.map((entry, position) => (position === index ? call : entry))
                : [...existing, call];
              return { toolCalls: next };
            });
          },
          onComplete: (data) => {
            // Agent turns are recorded by the gateway, which sees them whether
            // or not this window survives. A local turn counts its tokens here,
            // so here is the only place it can be recorded from.
            if (!agentSelection) {
              void UsageService.record({
                engine: "frontier",
                model: data.telemetry.model,
                usage: {
                  inputTokens: data.telemetry.promptTokens,
                  outputTokens: data.telemetry.outputTokens,
                },
                costUsd: data.costUsd,
                durationMs: data.telemetry.totalDurationMs,
              });
            }
            updateLastMessageInEngine("frontier", () => ({
              content: data.fullText,
              isStreaming: false,
              costUsd: data.costUsd,
              costLabel: data.costLabel,
              tokensCount: data.tokensCount,
              durationSec: data.durationSec,
              engineUsed: data.engineUsed,
            }));
            setStreaming(false);
          },
          onError: (failure) => {
            updateLastMessageInEngine("frontier", () => ({
              content: `Error: ${failure.message || "The request failed."}`,
              isStreaming: false,
            }));
            setStreaming(false);
          },
        },
        images,
        {
          mode: currentProfile,
          signal: controller.signal,
          // Only meaningful for the agent engines; the local engine ignores them.
          agentModel: agentSelection?.model ?? null,
          agentPermission: agentPermission ?? undefined,
          agentSessionId: agentSessionRef.current,
          onAgentSession: (sessionId) => {
            agentSessionRef.current = sessionId;
          },
          skill: activeSkill
            ? {
                id: activeSkill.id,
                name: activeSkill.name,
                description: `${activeSkill.description} (target stack: ${screenshotToCodeStack})`,
              }
            : null,
          approveCommand: commandApproval.approveCommand,
        },
      );
    },
    [
      messages, isStreaming, addMessageToEngine, updateLastMessageInEngine, setStreaming,
      currentProfile, activeSkill, screenshotToCodeStack, commandApproval.approveCommand, profile.costLabel,
      attachments,
    ],
  );

  sendRef.current = send;

  /* ── Voice ─────────────────────────────────────────────────────────────── */

  const lastAssistant = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant" && messages[index].content) return messages[index].content;
    }
    return "";
  }, [messages]);

  // Read through a ref because the voice engine is built once and the
  // assistant's mode changes underneath it; a captured value would route every
  // utterance the way the first one was routed.
  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;

  const voice = useVoice({
    /**
     * Where an utterance goes.
     *
     * One microphone, one engine, two destinations. In dictation mode the
     * words land in the chat exactly as they always have — repaired, reviewed,
     * then sent. In talk or agent mode the same utterance is a question about
     * the screen and goes to the assistant instead. This is the seam that lets
     * the composer's microphone *be* the assistant rather than sit beside it.
     */
    submit: (text) => {
      if (assistantRef.current.claimsUtterance()) {
        void assistantRef.current.ask(text);
        return;
      }
      sendRef.current(text);
    },
    lastAssistantText: () => lastAssistant,
    isBusy: () => isStreaming,
    // The addressing tiebreak and the transcript polish both run on the same
    // local engine as the chat, so neither costs anything or leaves the machine.
    complete: async (prompt, signal) => {
      let output = "";
      await AIService.streamMessage(
        "frontier",
        prompt,
        [],
        {
          onToken: (token) => {
            output += token;
          },
          onComplete: (data) => {
            output = data.fullText;
          },
        },
        [],
        { mode: "flash", signal },
      );
      return output;
    },
  });

  // The assistant has no microphone of its own; this is the one. Lending it
  // here is what makes the composer's mic, the global shortcut and the menu bar
  // item three doors into one session rather than three recorders.
  useEffect(() => {
    assistant.attachVoice(voice);
    return () => assistant.attachVoice(null);
  }, [assistant, voice]);

  // When a reply settles during a hands-free turn, read it back. Not while the
  // assistant is speaking: two voices over one another is worse than either.
  const spokenFor = useRef<string | null>(null);
  useEffect(() => {
    if (assistant.claimsUtterance()) return;
    if (isStreaming || voice.mode !== "conversation" || voice.state === "idle") return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !last.content) return;
    if (spokenFor.current === last.id) return;
    spokenFor.current = last.id;
    void voice.speakReply(speakableText(last.content));
  }, [assistant, isStreaming, messages, voice]);

  /* ── Scrolling ─────────────────────────────────────────────────────────── */

  const pinnedRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    // Stay pinned only while the operator is already at the bottom, so reading
    // back through a long reply is not yanked forward by new tokens.
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  };

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    updateLastMessageInEngine("frontier", () => ({ isStreaming: false }));
    voice.silence();
  }, [setStreaming, updateLastMessageInEngine, voice]);

  // Escape interrupts a run, as it does in a terminal. Ignored while typing in
  // a field, so it never eats an in-progress edit.
  useEffect(() => {
    if (!isStreaming) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
      if (event.key === "Escape" && !typing) {
        event.preventDefault();
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isStreaming, stop]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    /* Flat. The canvas carried a warm floor wash and a cool top light, which is
       what a designed dark theme does and what Cursor conspicuously does not —
       its chat sits on one unbroken #151515 from the title bar to the composer. */
    /* `min-w-0` let the chat absorb every pixel a widening panel took, down
       to a 160px slot with a wrapped composer. It has a floor now; past it
       the panel stops. Expanding the panel is the one gesture that may
       take the whole column, and it hides the chat rather than crushing
       it — the conversation stays mounted, so nothing is lost. */
    <main
      data-chat-column
      className={`flex-1 min-w-[var(--chat-min-w)] flex-col bg-frame-mid ${
        panelExpanded ? "hidden" : "flex"
      }`}
    >
      {isEmpty ? (
        /* Cursor's empty state is the pickers that say what the next turn runs
           against, the composer, and a row of outline pills — and above them,
           where Cursor leaves bare canvas, our mark.

           This is the one deliberate departure. Cursor can afford an anonymous
           empty screen because you already know whose window you are in; a
           product still earning that recognition cannot. It is still not an
           illustration: a 52px mark and the name, one flat stack, no orb, no
           headline, no gradient. The two ambient orbs that used to live here
           are not coming back. */
        <div className="flex-1 flex flex-col items-center justify-center gap-2.5 px-8">
          <div className="flex flex-col items-center gap-2 mb-7 select-none">
            <BrandGlyph brand="teminali" size={52} className="rounded-xl" />
            <span className="text-sm text-ink-muted tracking-tight">Teminali Code</span>
          </div>

          <div className="w-full max-w-composerEmpty flex items-center gap-4 text-sm text-ink-muted pl-1">
            <Picker
              label={workspaceName || "Start from scratch"}
              title="Open a different repository"
              onSelect={onOpenWorkspace}
            />
            <Picker label="This Mac" icon={<Laptop size={14} />} title="Turns run locally on this machine" />
          </div>

          {assistant.open && (
            <div className="w-full flex justify-center">
              <AssistantHud assistant={assistant} transcript={voice.transcript} voiceState={voice.state} />
            </div>
          )}

          <div className="w-full flex justify-center">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => void send(input)}
              onStop={stop}
              streaming={isStreaming}
              modelName={modelLabel}
              voice={voice}
              attachments={attachments}
              tall
              autoFocus
            />
          </div>

          <div className="w-full max-w-composerEmpty flex items-center gap-2 pl-1">
            {/* The shortcut is ⇧⌘8 because that is the File menu accelerator
                that opens this exact dialog. The pill it replaced advertised
                ⇧Tab, which nothing in the app has ever bound. */}
            <Pill onClick={openRecorder} shortcut="⇧⌘8">
              Record Screen
            </Pill>
            <Pill onClick={onConnectGitHub}>
              {github?.connected ? "Open a Repository" : "Connect Your Repos"}
            </Pill>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto flex justify-center px-8 pt-7 pb-4">
            <div className="w-full max-w-composer flex flex-col">
              {messages.map((message, index) => (
                <MessageBlock
                  key={message.id}
                  message={message}
                  previousRole={index > 0 ? messages[index - 1].role : null}
                  onRetry={message.role === "assistant" && index > 0
                    ? () => void send(messages[index - 1].content)
                    : undefined}
                  onJumpToFile={(path, code) => {
                    void openFileAtSnippet(path, code);
                    focusOrOpen({ kind: "file", path, label: path.split("/").pop() });
                  }}
                  onRun={() => openPanel({ kind: "terminal" })}
                  onStop={stop}
                />
              ))}
              {commandApproval.pending && (
                <CommandApprovalPrompt
                  request={commandApproval.pending}
                  onApprove={commandApproval.approve}
                  onDeny={commandApproval.deny}
                />
              )}
            </div>
          </div>

          <div className="flex-shrink-0 flex flex-col items-center gap-2.5 px-8 pt-3 pb-5">
            {assistant.open && <AssistantHud assistant={assistant} transcript={voice.transcript} voiceState={voice.state} />}
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => void send(input)}
              onStop={stop}
              streaming={isStreaming}
              placeholder="Send follow-up"
              modelName={modelLabel}
              voice={voice}
              attachments={attachments}
            />
            {/* Cursor repeats the machine picker under the follow-up bar at the
                same size it uses above the empty-state composer — it is the same
                control, so it must not shrink into a caption here. */}
            <div
              className="w-full max-w-composer flex items-center gap-1.5 text-sm text-ink-muted pl-1"
              title="Turns run locally on this machine"
            >
              <Laptop size={14} />
              This Mac
            </div>
          </div>
        </>
      )}
    </main>
  );
};

/* ── Pieces ──────────────────────────────────────────────────────────────── */

/**
 * A picker in the empty state's header row.
 *
 * It carried a chevron and no handler — an affordance that promised a menu and
 * did nothing when clicked. It now either opens something or is not a button:
 * `onSelect` is required for the chevron to appear at all, so the shape of the
 * control always matches what it does.
 */
const Picker: React.FC<{ label: string; icon?: React.ReactNode; onSelect?: () => void; title?: string }> = ({
  label,
  icon,
  onSelect,
  title,
}) =>
  onSelect ? (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      className="flex items-center gap-1.5 hover:text-ink-high transition-colors duration-ds ease-ds"
    >
      {icon}
      {label}
      <ChevronDown size={14} className="text-ink-muted" />
    </button>
  ) : (
    <span className="flex items-center gap-1.5" title={title}>
      {icon}
      {label}
    </span>
  );

/**
 * The outline pills under the composer. Transparent fill, one flat #2f2f2f
 * hairline, full radius — the only control in Cursor that is drawn as an
 * outline rather than a fill, which is exactly why it reads as a suggestion
 * rather than as a button you are expected to press.
 */
const Pill: React.FC<{
  children: React.ReactNode;
  shortcut?: string;
  onClick?: () => void;
}> = ({ children, shortcut, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="h-7 px-3 rounded-full border border-edge-strong text-sm text-ink-muted flex items-center gap-1.5 hover:text-ink-high hover:bg-surface-hover transition-colors duration-ds ease-ds"
  >
    {children}
    {shortcut && <span className="text-ink-placeholder">{shortcut}</span>}
  </button>
);
