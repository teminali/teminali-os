import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Circle, Clapperboard, FolderGit2, Laptop } from "lucide-react";
import { AIService } from "../../services/aiService";
import { useStudioStore, PROFILES_LIST } from "../../store/studioStore";
import { usePanelStore } from "../../store/panelStore";
import { useChangeStore } from "../../store/changeStore";
import { languageForPath } from "../../services/language";
import { useRecorderDialogStore } from "../../store/recorderDialogStore";
import { useVoice, type UseVoiceResult } from "../../hooks/useVoice";
import { useAttachments } from "../../hooks/useAttachments";
import { composePrompt } from "../../services/fileService";
import { resumableAgentSession } from "../../utils/chatSessions";
import { summariseScreen } from "../../services/screenToolCalls";
import { useCommandApproval } from "../../hooks/useCommandApproval";
import { useAskOperator } from "../../hooks/useAskOperator";
import { useSpokenApproval } from "../../hooks/useSpokenApproval";
import { useApprovalStore } from "../../store/approvalStore";
import { commandHead } from "../../services/agentCommands";
import { CommandApprovalPrompt } from "./CommandApprovalPrompt";
import { AskOperatorPrompt } from "./AskOperatorPrompt";
import { Composer } from "./Composer";
import { MessageBlock } from "./MessageBlock";
import { ChangeReviewDock } from "./ChangeReviewDock";
import {
  DIGEST_MAX_TOKENS,
  DIGEST_TAIL_IDLE_MS,
  DigestStream,
  STREAMED_SENTENCE_LIMIT,
  describeToolCall,
  digestBudgetMs,
  digestPrompt,
  digestSource,
  getImmediateAcknowledgment,
  isNonSpeechOrBlank,
  planSpokenDigest,
  speakableText,
  summariseProgress,
  VoiceDirector,
  type RunProgress,
  type SubmitOptions,
} from "../../services/voice";
import { FrontierEngine, sanitizeOngoingAssist } from "../../services/frontierEngine";
import { interruptTurn } from "../../services/interruption";
import { openBrowserAt } from "../../services/browserNavigation";
import { useInterruptKey } from "../../hooks/useInterruptKey";
import { useGitHubStatus } from "../../hooks/useGitHubStatus";
import { useProjectLibrary } from "../../hooks/useProjectLibrary";
import { UsageService } from "../../services/usageService";
import { AssistantHud } from "../assistant/AssistantHud";
import { BrandGlyph } from "../ui/BrandGlyph";
import { VoiceOrb } from "../voice";
import type { UseAssistantResult } from "../../hooks/useAssistant";
import type { ChatMessage } from "../../types";
import { dispatchPlayerCommand, type PlayerCommand } from "../../services/playerControl";

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

/**
 * What to call the machine the turns run on.
 *
 * It was the literal string "This Mac", in both places it appears, and the
 * first Windows customer to open the app was told their PC was a Mac — under a
 * tooltip promising the work happens on *this* machine, which is exactly the
 * claim the wrong noun undermines. There is no platform helper in `src/` to
 * borrow, and the renderer cannot read `process.platform`, so the user agent
 * answers it: it is the same string `voice/providers/webSpeech.ts` already
 * tests for Electron. Anything unrecognised gets the neutral noun rather than a
 * guess.
 */
const MACHINE_LABEL = (() => {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(agent)) return "This Mac";
  if (/Windows/i.test(agent)) return "This PC";
  return "This machine";
})();

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
  const { recent, openEntry } = useProjectLibrary();
  // Four is what fits one row beside the two suggestion pills above it
  // without wrapping at the composer's width.
  const recentProjects = useMemo(() => recent.slice(0, 4), [recent]);
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
  // An agent CLI keeps its own resumable session. Holding it on the chat makes
  // the conversation a continuous thread for the agent as well, not a series of
  // one-shots that have each forgotten the last — and because the chat is
  // persisted, that survives a remount, a switch away and back, and a restart.
  const activeSessionId = useStudioStore((state) => state.activeSessionId);
  const chatSessions = useStudioStore((state) => state.chatSessions);
  const setAgentSession = useStudioStore((state) => state.setAgentSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLElement>(null);
  const commandApproval = useCommandApproval();
  const askOperator = useAskOperator();
  const attachments = useAttachments();

  const profile = useMemo(
    () => PROFILES_LIST.find((entry) => entry.id === currentProfile) ?? PROFILES_LIST[1],
    [currentProfile],
  );

  // The composer names what will actually run the next turn. When an agent is
  // selected that is the agent, not the Frontier lane sitting behind it.
  const modelLabel = agentSelection?.label ?? profile.name;

  // Which agent a stored thread belongs to. A Codex thread cannot be resumed by
  // Claude Code, and resuming the wrong one fails rather than politely starting
  // fresh, so the id is only offered back when the agent still matches.
  const agentSessionKey = agentSelection ? `${agentSelection.engine}:${agentSelection.model}` : null;
  const resumableAgentSessionId = useMemo(
    () => resumableAgentSession(chatSessions, activeSessionId, agentSessionKey),
    [chatSessions, activeSessionId, agentSessionKey],
  );

  const messages = frontierMessages ?? [];
  const isEmpty = messages.length === 0;

  /* ── Sending ───────────────────────────────────────────────────────────── */

  // Held in a ref so the voice engine, which is created once, always calls the
  // current version rather than the one captured at mount.
  const sendRef = useRef<(text: string, options?: SubmitOptions) => Promise<void>>(async () => {});
  const stopRef = useRef<() => void>(() => {});
  const voiceRef = useRef<UseVoiceResult | null>(null);
  const spokenFor = useRef<string | null>(null);

  /*
    The command gate, offered to the voice layer as well as to the mouse.

    Publishing is all this does; the prompt below still draws itself and its
    buttons still settle the same gate. What the store adds is a second door —
    whichever engine has the microphone reads the command out and listens for
    "yes". See hooks/useSpokenApproval.ts.
  */
  const spokenApproval = useSpokenApproval(voiceRef);
  const approveRef = useRef(commandApproval);
  approveRef.current = commandApproval;
  useEffect(() => {
    const store = useApprovalStore.getState();
    const request = commandApproval.pending;
    if (!request) return;
    // The gate holds one command at a time, so its identity is the command
    // itself — there is no id to carry, and a re-render must not re-ask.
    const id = `chat:${request.command}`;
    store.offer({
      id,
      source: "chat",
      asker: "The assistant",
      action: request.command,
      alwaysLabel: commandHead(request.command),
      answer: (behavior, remember) => {
        if (behavior === "allow") approveRef.current.approve(remember);
        else approveRef.current.deny();
      },
    });
    return () => store.withdraw(id);
  }, [commandApproval.pending]);
  // What the current run has done so far — the tool calls and the prose — so
  // the voice layer can answer "how's it going?" from facts rather than filler.
  const runRef = useRef<RunProgress | null>(null);

  /**
   * Speak the part of a reply that was not read out while it streamed. Short:
   * verbatim. Long: a two-sentence summary from the Flash lane, spoken
   * sentence by sentence as the model produces it, with a rule-based line if
   * the first sentence is late. The full text is in the chat either way. See
   * `spokenDigest.ts` for the policy, its limits and the measurements behind
   * them.
   */
  const speakRemainder = useCallback(async (currentVoice: UseVoiceResult, remaining: string, turnId: number) => {
    const plan = planSpokenDigest(speakableText(remaining), currentVoice.settings.summariseLongReplies);
    if (plan.mode === "silent") {
      void currentVoice.enqueueSpeechChunk("", true);
      return;
    }
    if (plan.mode === "verbatim") {
      void currentVoice.enqueueSpeechChunk(plan.fallback, true);
      return;
    }
    currentVoice.noteDigesting();
    // The only wait the operator hears is for the first sentence, budgeted by
    // how much the model was shown. Once something is being spoken the clock
    // becomes an idle guard: a stalled tail is cut, not waited for. A newer
    // turn owns the voice, so it stops the digest outright.
    const live = () => turnId === turnIdRef.current;
    const stream = new DigestStream();
    const controller = new AbortController();
    let timer = window.setTimeout(() => controller.abort(), digestBudgetMs(digestSource(remaining).length));
    const say = (sentences: string[]) => {
      for (const sentence of sentences) void currentVoice.enqueueSpeechChunk(sentence, false);
    };
    let ended = false;
    try {
      await FrontierEngine.streamDigest(digestPrompt(remaining), {
        signal: controller.signal,
        maxTokens: DIGEST_MAX_TOKENS,
        onToken: (token) => {
          if (!live()) {
            controller.abort();
            return;
          }
          const ready = stream.push(token);
          if (ready.length > 0) say(ready);
          if (stream.done) {
            controller.abort();
            return;
          }
          if (stream.spokenSentences > 0) {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => controller.abort(), DIGEST_TAIL_IDLE_MS);
          }
        },
      });
      ended = !controller.signal.aborted;
    } catch {
      // Out of time, stopped, or the lane is down: what was said stands.
    } finally {
      window.clearTimeout(timer);
    }
    if (!live()) return;
    if (ended) say(stream.finish());
    if (stream.spokenSentences === 0) {
      void currentVoice.enqueueSpeechChunk(plan.fallback, true);
      return;
    }
    void currentVoice.enqueueSpeechChunk("", true);
  }, []);
  const turnIdRef = useRef(0);
  const hasSpokenModelTokens = useRef(false);

  // Read off once so `stop` has a stable identity: `useCommandApproval`
  // returns a fresh object every render, but this callback is the gate's.
  const cancelApproval = commandApproval.cancel;
  // Same reason, same shape: the ask gate hands back a fresh object each
  // render, and `stop` needs the gate's own callback, not this render's.
  const cancelAsk = askOperator.cancel;

  /**
   * Stop the run. The only way a turn is interrupted, from anywhere.
   *
   * It is declared here, above `send`, because `send` interrupts too — a new
   * prompt pre-empts the one in flight — and because the voice host's `stop`
   * intent lands on the same routine. Three copies of this had drifted apart;
   * the one that mattered, `commandApproval.cancel()`, was in none of them, so
   * stopping a run that was blocked on an approval left the prompt on screen
   * and the gate's promise unresolved forever.
   *
   * The order is deliberate. Retire the turn id first, so nothing still in
   * flight can write to the transcript after this; then abort, which is what
   * actually stops the work — the signal reaches the gateway's fetch, the
   * gateway aborts its upstream, and `agent-cli.js` SIGTERMs the CLI; then
   * settle what is on screen; then silence the voice.
   *
   * Through `voiceRef` rather than the `voice` value: the engine is built
   * below this point, and a captured value would be the one from mount.
   */
  const stop = useCallback(() => {
    turnIdRef.current += 1;
    runRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    // A command waiting on a decision is part of the run. Left pending it is
    // both a dialog nobody can answer and an agent loop nobody can finish.
    cancelApproval();
    // And a question waiting on an answer, for the identical reason: the
    // picker would outlive the run that raised it, and its promise would never
    // settle. This is the bug the approval gate shipped with; it does not get
    // to happen twice.
    cancelAsk();
    setStreaming(false);
    updateLastMessageInEngine("frontier", interruptTurn);
    voiceRef.current?.silence();
  }, [cancelApproval, cancelAsk, setStreaming, updateLastMessageInEngine]);

  const send = useCallback(
    async (text: string, options?: SubmitOptions) => {
      const ready = attachments.attachments.filter((entry) => entry.status === "ready");
      const typed = text.trim();
      // An attachment alone is a valid turn: dropping a PDF and pressing enter
      // should ask about the PDF.
      if ((!typed && ready.length === 0) || attachments.busy) return;

      // Universal Interruption: a new prompt pre-empts the run in flight, and
      // stops it exactly the way the stop button does.
      if (isStreaming) stop();

      turnIdRef.current += 1;
      const currentTurnId = turnIdRef.current;

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
      hasSpokenModelTokens.current = false;
      addMessageToEngine("frontier", {
        role: "assistant",
        content: "",
        isStreaming: true,
        tokensCount: 0,
        costUsd: 0,
        costLabel: profile.costLabel,
      });
      setStreaming(true);
      runRef.current = {
        startedAt: Date.now(),
        engine: agentSelection?.engine ?? "frontier",
        toolCalls: [],
        lastText: "",
      };

      // Immediate verbal acknowledgment based on prompt intent (e.g. "On it.", "Looking into that now.")
      const currentVoice = voiceRef.current;
      if (
        currentVoice &&
        currentVoice.settings.speakReplies &&
        (currentVoice.mode === "conversation" || currentVoice.state !== "idle") &&
        typed
      ) {
        const ack = getImmediateAcknowledgment(typed);
        if (ack) {
          void currentVoice.enqueueSpeechChunk(ack, false);
        }
      }

      let accumulated = "";
      const isFreshConversation = history.length === 0 || history.every((m) => !m.content || m.role === "system");
      const director = new VoiceDirector({
        isFreshConversation,
        maxStreamedChunks: STREAMED_SENTENCE_LIMIT,
        onSpeechChunk: (chunk, isFinal) => {
          if (currentTurnId !== turnIdRef.current) return;
          const currentVoice = voiceRef.current;
          if (
            currentVoice &&
            currentVoice.settings.speakReplies &&
            (currentVoice.mode === "conversation" || currentVoice.state !== "idle")
          ) {
            if (chunk && !isNonSpeechOrBlank(chunk)) {
              hasSpokenModelTokens.current = true;
            }
            void currentVoice.enqueueSpeechChunk(chunk, isFinal);
          }
        },
      });

      await AIService.streamMessage(
        agentSelection?.engine ?? "frontier",
        prompt,
        history,
        {
          onToken: (token) => {
            if (currentTurnId !== turnIdRef.current) return;
            accumulated += token;
            const textToDisplay = !isFreshConversation ? sanitizeOngoingAssist(accumulated) : accumulated;
            updateLastMessageInEngine("frontier", () => ({
              content: textToDisplay,
              tokensCount: Math.max(1, Math.ceil(textToDisplay.length / 4)),
              isStreaming: true,
            }));

            if (runRef.current) runRef.current.lastText = textToDisplay;

            // Route tokens to real-time Voice Director agent to curate speech
            const currentVoice = voiceRef.current;
            if (
              currentVoice &&
              currentVoice.settings.speakReplies &&
              (currentVoice.mode === "conversation" || currentVoice.state !== "idle")
            ) {
              director.pushToken(token);
            }
          },
          onToolCall: (call) => {
            if (currentTurnId !== turnIdRef.current) return;
            const run = runRef.current;
            if (run) {
              const at = run.toolCalls.findIndex((entry) => entry.id === call.id);
              run.toolCalls = at >= 0
                ? run.toolCalls.map((entry, position) => (position === at ? call : entry))
                : [...run.toolCalls, call];
            }
            // The voice layer's running commentary: one plain line when a step
            // starts, and the outcome of a test or build run.
            const line = director.onToolCall(call) ?? describeToolCall(call);
            if (line) voiceRef.current?.noteProgress(line);
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
            if (currentTurnId !== turnIdRef.current) return;
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
            const full = data.fullText || accumulated;
            const cleanFull = !isFreshConversation ? sanitizeOngoingAssist(full) : full;
            updateLastMessageInEngine("frontier", () => ({
              content: cleanFull,
              isStreaming: false,
              costUsd: data.costUsd,
              costLabel: data.costLabel,
              tokensCount: data.tokensCount,
              durationSec: data.durationSec,
              loadSec: Number((data.telemetry.loadDurationMs / 1000).toFixed(2)),
              // What the window could not afford. Carried onto the message so
              // the row can say it: a reply given without the sections that
              // grant a capability is a different reply, and until now the
              // only record of that was discarded. See `droppedWorthNaming`.
              droppedSections: data.telemetry.contextBudget?.dropped ?? [],
              engineUsed: data.engineUsed,
            }));
            setStreaming(false);

            if (runRef.current) runRef.current.finishedAt = Date.now();
            runRef.current = null;

            // What is left to say: curated by Voice Director
            const currentVoice = voiceRef.current;
            if (
              currentVoice &&
              currentVoice.settings.speakReplies &&
              (currentVoice.mode === "conversation" || currentVoice.state !== "idle")
            ) {
              const spokenLen = director.getSpokenLength();
              const remaining = cleanFull.slice(spokenLen);
              if (currentVoice.settings.summariseLongReplies && remaining.length > 250) {
                hasSpokenModelTokens.current = true;
                void speakRemainder(currentVoice, remaining, currentTurnId);
              } else {
                director.finish(cleanFull);
              }
            }
          },
          onError: (failure) => {
            if (currentTurnId !== turnIdRef.current) return;
            director.abort();
            runRef.current = null;
            const currentVoice = voiceRef.current;
            if (currentVoice && currentVoice.mode === "conversation" && currentVoice.state !== "idle") {
              currentVoice.silence();
            }
            const isAbort =
              controller.signal.aborted ||
              failure.name === "AbortError" ||
              /aborted|cancelled|stopped by the user/i.test(failure.message);
            if (isAbort) {
              updateLastMessageInEngine("frontier", interruptTurn);
            } else {
              updateLastMessageInEngine("frontier", () => ({
                content: `Error: ${failure.message || "The request failed."}`,
                isStreaming: false,
              }));
            }
            setStreaming(false);
          },
        },
        images,
        {
          mode: currentProfile,
          signal: controller.signal,
          // A spoken turn is a transcript. The engine frames it as one so a
          // misheard filename is investigated rather than taken literally.
          origin: options?.origin ?? "text",
          // Only meaningful for the agent engines; the local engine ignores them.
          agentModel: agentSelection?.model ?? null,
          agentPermission: agentPermission ?? undefined,
          agentSessionId: resumableAgentSessionId,
          onAgentSession: (sessionId) => {
            setAgentSession(activeSessionId, sessionId, agentSessionKey);
          },
          skill: activeSkill
            ? {
                id: activeSkill.id,
                name: activeSkill.name,
                description: `${activeSkill.description} (target stack: ${screenshotToCodeStack})`,
              }
            : null,
          approveCommand: commandApproval.approveCommand,
          askOperator: askOperator.askOperator,
          /*
            The screen, for the lane the operator is actually talking to.

            Offered only when this machine has an eye: `canSee` is false until
            Accessibility is granted, and with it false the engine never
            advertises the fence, so the prompt does not pay window for a
            capability whose every call would fail. The summary is deliberately
            short — see `summariseScreen`.
          */
          lookAtScreen: assistant.canSee
            ? async (question: string) => summariseScreen(await assistant.look(true), question)
            : undefined,
          /*
            The agent driving the workspace from the chat, not only from a
            panel tab.

            `getState()` rather than the hook values above: this closure is
            captured once per turn and must act on the store as the event
            arrives. A project switch only sets the path — the gateway has
            already rebound its root, and the sidebar re-reads the tree when
            that path changes.
          */
          onWorkspace: (event) => {
            const store = useStudioStore.getState();
            if (event.action === "reveal") store.revealPath(event.path);
            else if (event.action === "open-file") void store.showFile(event.path);
            else if (event.action === "open-folder") store.showFolder(event.path);
            // The player is a mounted pane, not the store: the command goes to
            // whichever pane holds the element. See services/playerControl.ts.
            else if (event.action === "player") dispatchPlayerCommand(event.command as PlayerCommand);
            else if (event.action === "browse") openBrowserAt(event.url, { newTab: event.newTab });
            else {
              // Exactly what a click in the sidebar does, and in the same
              // order: the video editor has to be on screen before the load
              // runs, because it reports through the video pane's own toasts.
              if (event.kind === "video") focusOrOpen({ kind: "video" });
              store.setWorkspacePath(event.path);
            }
          },
          /*
            And a file it wrote becomes a reviewable row, the way one the chat
            authored itself already does. Same dock, different road: the chat
            hands `LiveEditService` both sides, whereas an agent writes to disk
            and the gateway recovers the pair from its tool stream.
          */
          onEdit: (event) => {
            useChangeStore.getState().record({
              path: event.path,
              before: event.before,
              after: event.after,
              existedBefore: event.existedBefore,
              origin: "agent",
              requestId: String(currentTurnId),
            });
            useStudioStore.getState().openFile({
              path: event.path,
              name: event.path.split("/").pop() || event.path,
              content: event.after,
              language: languageForPath(event.path),
              encoding: "utf8",
              mimeType: "text/plain",
              size: event.size ?? undefined,
              modified: event.modified ?? undefined,
            });
          },
        },
      );
    },
    [
      messages, isStreaming, addMessageToEngine, updateLastMessageInEngine, setStreaming,
      currentProfile, activeSkill, screenshotToCodeStack, commandApproval.approveCommand, profile.costLabel,
      attachments, speakRemainder, stop,
    ],
  );

  sendRef.current = send;
  stopRef.current = stop;

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
    submit: (text, options) => {
      // A standing permission prompt gets first refusal on the words. "Yes" is
      // an answer to it, not a message for the model — see useSpokenApproval.
      if (spokenApproval.consume(text)) return;
      // Direct bridge to normal chatbox — voice does not have its own workflow.
      // The origin rides along so the turn reaches the model marked as heard,
      // not typed: the words are a transcript and the names in them are its
      // best guess, not the operator's spelling.
      sendRef.current(text, options);
    },
    // "Stop", heard. The same routine the stop button runs — see §6.1 for
    // which utterances get here and which are only encouragement.
    interrupt: () => stopRef.current(),
    lastAssistantText: () => lastAssistant,
    isBusy: () => isStreaming,
    // "How's it going?" mid-run is answered from what the run has actually
    // done, without stopping it.
    progressSummary: () => (runRef.current ? summariseProgress(runRef.current) : null),
    // The material behind that summary, for the voice lane's own agent: a
    // question about the run is answered from this instead of being sent to
    // the chat, which would have cancelled the run it was asking about.
    runProgress: () => runRef.current ?? null,
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
  voiceRef.current = voice;

  useEffect(() => {
    assistant.attachVoice(voice);
    return () => assistant.attachVoice(null);
  }, [assistant, voice]);

  // When a reply settles, ensure it is spoken if it hasn't been spoken yet.
  useEffect(() => {
    if (isStreaming) return;
    const currentVoice = voiceRef.current;
    if (!currentVoice || !currentVoice.settings.speakReplies) return;
    if (currentVoice.mode !== "conversation" && currentVoice.state === "idle") return;

    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !last.content) return;
    if (spokenFor.current === last.id) return;
    spokenFor.current = last.id;

    if (hasSpokenModelTokens.current) {
      hasSpokenModelTokens.current = false;
      return;
    }

    const isOngoing = messages.filter((m) => m.role !== "system").length > 2;
    const finalContent = isOngoing ? sanitizeOngoingAssist(last.content) : last.content;
    const cleanSpeech = speakableText(finalContent).trim();
    if (cleanSpeech && !isNonSpeechOrBlank(cleanSpeech)) {
      void currentVoice.speakReply(cleanSpeech);
    }
  }, [isStreaming, messages]);

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

  /*
    Escape interrupts a run, as it does in a terminal.

    It used to be refused whenever a field had focus, which reads as caution
    and was the whole defect: the composer *is* a textarea, it is autofocused,
    and it keeps focus after a prompt is sent — so the one place the operator
    presses Escape was the one place it was thrown away. The rule is in
    `services/interruption.ts` and the wiring in `hooks/useInterruptKey`,
    shared with the agent tabs and the side chats so one rule cannot become
    three. `columnRef` is what makes this column "the chat": a keystroke
    inside it interrupts even from a text field.
  */
  useInterruptKey(isStreaming, columnRef, stop);

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
      ref={columnRef}
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
          <div className="relative z-10 flex flex-col items-center select-none overflow-visible pt-2 pb-1 mb-6">
            <div className="relative p-4 overflow-visible flex items-center justify-center min-h-[105px]">
              <VoiceOrb
                size={68}
                state={voice.state}
                level={voice.level}
                caption={voice.narration ?? voice.transcript ?? undefined}
                badge={
                  /*
                    Nothing listens while idle, so "Say Hey Temy" was a
                    promise the app could not keep: the operator says it, the
                    microphone is not open, and the orb sits there. The wake
                    word remains one of the signals that decides whether live
                    speech was addressed to Temy (services/voice/addressing.ts)
                    — that is a different thing, and it works. What is gone is
                    the claim that it starts a conversation.
                  */
                  voice.state === "idle"
                    ? "Tap to talk"
                    : voice.state === "speaking"
                      ? "Temy is speaking"
                      : voice.state === "hearing"
                        ? "Listening to you…"
                        : "Listening…"
                }
                onClick={() => {
                  if (voice.state === "idle") {
                    void voice.startConversation();
                  } else {
                    void voice.stop();
                  }
                }}
                title={voice.state === "idle" ? "Tap to start a voice conversation" : "Tap to end voice conversation"}
              />
            </div>
          </div>

          <div className="w-full max-w-composerEmpty flex items-center gap-4 text-sm text-ink-muted pl-1">
            <Picker
              label={workspaceName || "Start from scratch"}
              title="Open a different repository"
              onSelect={onOpenWorkspace}
            />
            <Picker label={MACHINE_LABEL} icon={<Laptop size={14} />} title="Turns run locally on this machine" />
          </div>



          <div className="w-full flex justify-center">
            <ChangeReviewDock />
          </div>

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
            <Pill
              onClick={openRecorder}
              shortcut="⇧⌘8"
              /* The record dot, in `--danger` — the one red in the palette, and
                 the same red the take's own controls use. It is what makes this
                 pill readable as the recorder at a glance, next to a neighbour
                 that is only words. */
              icon={<Circle className="w-2.5 h-2.5 fill-current text-danger" />}
            >
              Record Screen
            </Pill>
            <Pill onClick={onConnectGitHub}>
              {github?.connected ? "Open a Repository" : "Connect Your Repos"}
            </Pill>
          </div>

          {/* Recent projects — one list, both kinds.

              Here and nowhere else: this is the screen with room for it, and
              the conversation view is already the answer to "which project am
              I in". A code project and a video project sit side by side
              because that is what the operator has been working on; the glyph
              is the only thing that separates them, and the click is what
              actually differs. */}
          {recentProjects.length > 0 && (
            <div className="w-full max-w-composerEmpty flex items-center gap-2 pl-1 flex-wrap">
              {recentProjects.map((entry) => (
                <Pill
                  key={entry.path}
                  onClick={() => {
                    // The editor has to be on screen before the load runs: it
                    // reports through the video pane's own toasts.
                    if (entry.kind === "video") focusOrOpen({ kind: "video" });
                    void openEntry(entry);
                  }}
                  icon={
                    entry.kind === "video" ? (
                      <Clapperboard size={13} strokeWidth={1.7} />
                    ) : (
                      <FolderGit2 size={13} strokeWidth={1.7} />
                    )
                  }
                >
                  <span className="max-w-[13ch] truncate">{entry.name}</span>
                </Pill>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto flex justify-center px-8 pt-7 pb-4">
            <div className="w-full max-w-composer flex flex-col">
              {messages.map((message, index) => (
                <MessageBlock
                  key={message.id}
                  message={message}
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
              {askOperator.pending && (
                <AskOperatorPrompt
                  questions={askOperator.pending}
                  onAnswer={askOperator.answer}
                  onDismiss={askOperator.dismiss}
                />
              )}
              {commandApproval.pending && (
                <CommandApprovalPrompt
                  request={commandApproval.pending}
                  onApprove={(remember) => commandApproval.approve(remember)}
                  onDeny={commandApproval.deny}
                  listening={spokenApproval.listening}
                />
              )}
            </div>
          </div>

          <div className="flex-shrink-0 flex flex-col items-center gap-2 px-8 pt-2.5 pb-4">
            {/* Directly above the composer: the last thing between an edit that
                is already on disk and the next prompt. */}
            <ChangeReviewDock />
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
            {/* The machine, at caption weight. It was repeated here at the
                same 13px as the empty state's picker, which made a static fact
                the second-loudest thing under the composer. */}
            <div
              className="w-full max-w-composer flex items-center gap-1.5 text-2xs text-ink-disabled pl-1"
              title="Turns run locally on this machine"
            >
              <Laptop size={11} />
              {MACHINE_LABEL}
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
  icon?: React.ReactNode;
  onClick?: () => void;
}> = ({ children, shortcut, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="h-7 px-3 rounded-full border border-edge-strong text-sm text-ink-muted flex items-center gap-1.5 hover:text-ink-high hover:bg-surface-hover transition-colors duration-ds ease-ds"
  >
    {icon && <span className="flex-shrink-0 flex items-center">{icon}</span>}
    {children}
    {shortcut && <span className="text-ink-placeholder">{shortcut}</span>}
  </button>
);
