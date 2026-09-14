import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SlidersHorizontal, SquarePlus } from "lucide-react";
import { TemiCanvasOrb } from "./TemiCanvasOrb";
import { TemiTranscript, type DialogueTurn } from "./TemiTranscript";
import { TemiChatMenu, TemiStageSettings } from "./TemiStagePanels";
import { TemiActionRow, TemiComposer } from "./TemiComposer";
import { ConnectedAgentActivity } from "./AgentActivityTicker";
import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import { PROFILES_LIST, useStudioStore } from "../../store/studioStore";
import { PERMISSION_LABELS } from "../chat/ModelPicker";
import { VoiceAudioEngine } from "../../services/voice/voiceAudioEngine";
import { GeminiLiveEngine } from "../../services/voice/geminiLiveEngine";
import { formatTurnLatency, recordTurn, turnLatencySummary } from "../../services/voice/turnLatency";
import { geminiLiveRemedy, type GeminiLiveRemedy } from "../../services/voice/geminiLiveToken";
import { CaptionPacer } from "../../services/voice/captionPacer";
import { TeminaliAgentBridge, type TaskDelegationOptions } from "../../services/voice/teminaliAgentBridge";
import { routeVoiceTurn } from "../../services/voice/voiceTurnRouter";
import {
  FOLLOW_UP_WINDOW_MS,
  scoreAddressing,
  stripWakeWord,
} from "../../services/voice/addressing";
import { selfAudio } from "../../services/voice/selfAudio";
import { EchoGuard, stripSelfEcho } from "../../services/voice/echoGuard";
/* Agent C owns this module and it lands separately; the call is written
   against its published signature. See the block at the head of
   `performVoiceTurn` for why the transport has to be asked first. */
import { handleSpokenPlayerCommand, survivesSelfAudioWithoutWakeWord } from "../../services/voice/playerActions";
import { classifyApprovalReply, describeApprovalRequest } from "../../services/voice/approvalIntent";
import { DEFAULT_VOICE_SETTINGS } from "../../services/voice/types";
import { commandHead } from "../../services/agentCommands";
import { useApprovalStore } from "../../store/approvalStore";
import { useChangeStore } from "../../store/changeStore";
import { useCommandApproval } from "../../hooks/useCommandApproval";
import { useSpokenApproval } from "../../hooks/useSpokenApproval";
import { SpokenApprovalPrompt } from "./SpokenApprovalPrompt";
import { runProgressFromActivity } from "../../services/voice/runProgressFromActivity";
import { traceVoice } from "../../services/voice/voiceTrace";
import { loadTemiMemory, primeTemiMemory, saveTemiMemory } from "../../services/voice/temiMemoryStore";
import type { TranscriptTurn } from "../../services/voice/temiMemoryExtract";
import { formatMemoryPass, runMemoryPass } from "../../services/voice/temiMemoryPass";
import { temiMemoryModel } from "../../services/voice/temiMemoryModel";
import {
  candidatesFromEntries,
  parseWorkspaceCommand,
  type FolderCandidate,
} from "../../services/voice/workspaceActions";
import {
  describeEditorResult,
  parseEditorCommand,
  type EditorCommand,
} from "../../services/voice/editorActions";
import {
  decomposeCompoundUtterance,
  executeActionChain,
} from "../../services/voice/compoundActionRunner";
import { splitTrailingClause } from "../../services/voice/turnIntent";
import { WorkspaceService, type ProjectsResponse } from "../../services/workspaceService";
import { dialogueFromMessages, messagesFromDialogue } from "../../utils/sessionDialogue";
import { EMPTY_HISTORY, newer, older, remember, stopBrowsing, type PromptHistory } from "../../utils/promptHistory";
import { useInterruptKey } from "../../hooks/useInterruptKey";
import { stripStageDirections } from "../../services/voice/numberWords";
import type { ChatMessage } from "../../types";
import type { UseVoiceResult } from "../../hooks/useVoice";

export interface TemiVoiceStageProps {
  messages?: ChatMessage[];
  voice?: UseVoiceResult;
  isStreaming?: boolean;
  onSend?: (text: string) => Promise<void>;
  onStop?: () => void;
  machineLabel?: string;
  onOpenWorkspace?: () => void;
  onConnectGitHub?: () => void;
  className?: string;
}

const INITIAL_DIALOGUE: DialogueTurn[] = [
  {
    id: "init-temi",
    role: "assistant",
    content:
      "I'm right here with you. Tell me what we're conquering today, or what's on your mind. Speak whenever you're ready — or type, if you'd rather.",
  },
];

/** The column the transcript, the composer and the status dot all share. */
const COLUMN = "w-full max-w-[720px]";

/**
 * The engine label in two parts, the way Codex writes "Custom Light": the name
 * in near-white, the variant muted behind it.
 *
 * The row this feeds has a spacer in it, so both halves fit — which is what
 * changed. The old pill had room for one word and kept the wrong one: every
 * agent selection reads "Claude Code · Default", and truncating from the left
 * cut away the half that identifies the model. Splitting keeps both and lets
 * the *variant* be the part that gives way when the panel is narrow.
 */
const splitEngineLabel = (label: string): { head: string; tail: string } => {
  const dot = label.indexOf("·");
  if (dot >= 0) {
    return { head: label.slice(0, dot).trim(), tail: label.slice(dot + 1).trim() };
  }
  const frontier = /^(Frontier)\s+(.+)$/i.exec(label);
  if (frontier) return { head: frontier[1], tail: frontier[2] };
  return { head: label, tail: "" };
};

/* How long a line the shell sent to be spoken may go unspoken before the
   transcript records it instead. Gemini begins its `outputTranscription`
   inside a second of a client turn; four is far enough clear of that to never
   race a healthy socket, and short enough that a dead one does not leave the
   operator reading a silence. */
const SPOKEN_LINE_FALLBACK_MS = 4000;

import {
  frameAssistantReport,
  handoffAcknowledgement,
  isAssistantReportEcho,
} from "../../services/voice/assistantHandoff";

/**
 * Say what failed, out of whatever the engine threw.
 *
 * `onError` receives an `Error` from the token fetch, a DOM `ErrorEvent` from
 * the socket, and whatever the SDK rejected with from `live.connect`. `String`
 * on the middle one is "[object Event]", which is not a sentence anyone can
 * act on.
 */
const describeVoiceError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  return "the voice service failed without saying why";
};

/**
 * What the voice lane has to say for itself, and what can be done about it.
 *
 * The text and the remedy travel together so they cannot disagree: a note that
 * arrives with no remedy clears the button the note before it put up, which is
 * what keeps "Add key" off a banner that has moved on to saying the gateway is
 * down. `remedy` is absent far more often than it is present: most failures
 * are news, not a thing with a button behind it.
 */
interface VoiceNote {
  text: string;
  remedy?: GeminiLiveRemedy;
}

/** Shared so clearing the note twice is one render, not two. */
const NO_VOICE_NOTE: VoiceNote = { text: "" };

/**
 * Where a turn came from, which decides two things the operator never sees.
 *
 * `spoken` reached the model through the live socket and is already being
 * answered, so acting on it locally means barging in first. `typed` was never
 * heard, so it has to be sent. `clause` is the second half of a spoken
 * sentence the stage split for itself: the model heard it inside the whole
 * utterance and the barge-in already happened when the first half was acted
 * on, so it needs neither, and doing either again would cut the line
 * confirming the clause before it.
 */
type TurnSource = "spoken" | "typed" | "clause";


/**
 * Enough of the timeline store to answer "is there an edit open?".
 *
 * Structural on purpose: the video domain is a dynamic import on this screen
 * (see `runEditorCommand`), and naming its types here would drag the module
 * graph back in through the type checker's front door.
 */
interface TimelineProbe {
  getState(): { tracks: ReadonlyArray<{ clips: ReadonlyArray<unknown> }> };
}

export const TemiVoiceStage: React.FC<TemiVoiceStageProps> = ({
  voice,
  isStreaming = false,
  onStop,
  machineLabel = "This Mac",
  onOpenWorkspace,
  onConnectGitHub,
  className = "",
}) => {
  const [inputText, setInputText] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);
  // What the voice engine says about reaching Gemini Live. Empty while it is
  // healthy: a working assistant should not narrate that it is working.
  const [voiceNote, setVoiceNote] = useState<VoiceNote>(NO_VOICE_NOTE);
  /*
    The conversation lives in the store, not here.

    It was a `useState` for as long as this stage existed, which is what made
    the sidebar's chat history unopenable: `switchSession` swapped
    `frontierMessages` exactly as it should, and this component went on drawing
    its own array, so every chat showed the same transcript and a reload lost
    all of them. Reading the store instead is the whole fix — switching a chat
    now changes what is on screen because it changes what this renders.

    The setter keeps the `setState` shape on purpose: seven call sites below
    append to the transcript with `prev => [...]`, and they are unchanged.
  */
  const frontierMessages = useStudioStore((state) => state.frontierMessages);
  const setFrontierMessages = useStudioStore((state) => state.setFrontierMessages);
  const newChatSession = useStudioStore((state) => state.newChatSession);
  const dialogueHistory = React.useMemo(
    () => dialogueFromMessages(frontierMessages, INITIAL_DIALOGUE),
    [frontierMessages],
  );
  const setDialogueHistory = useCallback(
    (update: React.SetStateAction<DialogueTurn[]>) => {
      setFrontierMessages((previous) => {
        const drawn = dialogueFromMessages(previous, INITIAL_DIALOGUE);
        const next = typeof update === "function" ? update(drawn) : update;
        return messagesFromDialogue(next, previous);
      });
    },
    [setFrontierMessages],
  );
  const [liveUserSpeech, setLiveUserSpeech] = useState<string | null>(null);
  const [liveAssistantStream, setLiveAssistantStream] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [isAudioStarted, setIsAudioStarted] = useState(false);
  const [userEnergy, setUserEnergy] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* The surface's own running truth. `isStreaming` is the parent's chat lane,
     which nothing on this stage sets — arming Escape on it alone is why Escape
     was dead here. A delegated run is what an operator on this screen means by
     "running", and that is `isTaskRunning`.

     `isSpeaking` belongs here too, and its absence was the same bug a second
     time. Temi talking with no delegated run behind it is the ordinary case —
     every plain answer — and in that state Escape was unarmed and the composer
     offered no Stop, so there was no way at all to cut her off. Half-duplex
     means the microphone is deliberately ignored while she speaks, so the voice
     cannot do it either. Reported as "I cannot stop this", 2026-09-10.

     If she is talking, she can be stopped. That is the whole rule. */
  const isTaskRunning = useAssistantActivityStore((state) => state.isTaskRunning);
  const isRunning = isTaskRunning || isStreaming || isSpeaking;
  const stageRef = useRef<HTMLDivElement>(null);
  const isActivityOpen = useAssistantActivityStore((state) => state.isOpen);
  const setActivityOpen = useAssistantActivityStore((state) => state.setOpen);
  const isPanelExpanded = useAssistantActivityStore((state) => state.isPanelExpanded);
  const setActiveEngine = useAssistantActivityStore((state) => state.setActiveEngine);
  const logAction = useAssistantActivityStore((state) => state.logAction);

  const composerContainerRef = useRef<HTMLDivElement>(null);
  const [composerBottomOffset, setComposerBottomOffset] = useState<number>(340);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const composerEl = composerContainerRef.current;
    if (!stage || !composerEl) return;

    const measure = () => {
      const stageRect = stage.getBoundingClientRect();
      const composerRect = composerEl.getBoundingClientRect();
      const offset = Math.round(stageRect.bottom - composerRect.top);
      if (offset > 0) {
        setComposerBottomOffset(offset);
      }
    };

    measure();

    const t1 = setTimeout(measure, 50);
    const t2 = setTimeout(measure, 150);
    const t3 = setTimeout(measure, 250);
    const t4 = setTimeout(measure, 320);

    composerEl.addEventListener("transitionend", measure);

    const ro = new ResizeObserver(() => {
      measure();
    });
    ro.observe(composerEl);
    ro.observe(stage);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      composerEl.removeEventListener("transitionend", measure);
      ro.disconnect();
    };
  }, [isPanelExpanded]);

  useEffect(() => {
    if (isPanelExpanded && scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      const timer = setTimeout(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }, 320);
      return () => clearTimeout(timer);
    }
  }, [isPanelExpanded, composerBottomOffset]);

  const currentProfile = useStudioStore((state) => state.currentProfile);
  const agentSelection = useStudioStore((state) => state.agentSelection);
  // The engine that will do the work, named the way the chat composer names it.
  const engineLabel =
    agentSelection?.label ?? PROFILES_LIST.find((profile) => profile.id === currentProfile)?.name ?? "Auto";
  const engine = splitEngineLabel(engineLabel);

  const agentPermission = useStudioStore((state) => state.agentPermission);
  /* Codex writes "Approve for me" because Codex has one mode. We have several,
     and one of them asks before every tool call — so the chip names the rung
     that is actually in force, and falls back to the noun for the control
     rather than to a claim about behaviour we may not be in. */
  const permissionLabel = agentPermission
    ? (PERMISSION_LABELS[agentPermission] ?? agentPermission)
    : "Approvals";

  const workspacePath = useStudioStore((state) => state.workspacePath);
  const projectLabel = workspacePath ? (workspacePath.split("/").filter(Boolean).pop() ?? null) : null;

  /* The key field the banner offers, and the count that says one was filled
     in. Both live on the store because the two save sites are elsewhere in
     the shell, a modal at `App` level and a card in settings, and neither
     of them knows this screen exists. */
  const setGeminiKeyModalOpen = useStudioStore((state) => state.setGeminiKeyModalOpen);
  const providerKeySaves = useStudioStore((state) => state.providerKeySaves);

  // There is no Teminali OS chat any more, so this picker is the only place the
  // engine can be chosen — and the bridge reads the activity store's engine, not
  // the studio store's. Keep them in step, or choosing Claude Code here would
  // delegate to Codex anyway. One direction only: the picker leads.
  useEffect(() => {
    setActiveEngine(agentSelection?.engine ?? (currentProfile === "max" ? "gemini" : "frontier"));
  }, [agentSelection?.engine, currentProfile, setActiveEngine]);

  const audioRef = useRef<VoiceAudioEngine | null>(null);

  /* The caption is paced by the speaker, not by the model — see captionPacer.
     `pendingFinal` is the finished reply held back until the voice has caught up
     with it: committing on `final_assistant_answer` would snap the whole
     sentence on screen the instant generation ended, seconds before it is said,
     which is the defect the pacing exists to remove. */
  const pacerRef = useRef(new CaptionPacer());
  const secondsPlayedRef = useRef(0);
  const pendingFinalRef = useRef<string | null>(null);
  const assistantTurnActiveRef = useRef(false);
  const awaitingAssistantAnswerRef = useRef(false);
  const captionCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* A line the shell put into her mouth lands on exactly one surface.

     There are two of them. Either she says it and the transcript records what
     she said, or the transcript records it because she did not. Doing both is
     what put one answer on screen twice, measured on a live call 2026-09-12:
     the delegate path's `onCompleted` appended the report to the transcript AND
     sent it to be spoken, and the spoken copy then committed as its own bubble
     underneath the written one.

     The spoken surface wins, because it is the record of what the operator
     actually heard. The written one is a fallback and nothing more: if she has
     not begun speaking within `SPOKEN_LINE_FALLBACK_MS` the socket is down or
     the turn was swallowed, and a report that reached nobody is a worse
     failure than a report that arrived twice. */
  const unspokenLineRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  /* Move the held reply into the transcript.

     `truncateToSpoken` is for a turn the operator cut off. What lands in the
     transcript is then what she actually said, not what she was going to say —
     a transcript that records words the speaker was silenced before reaching is
     a record of something that did not happen. */
  /* The conversation as it is actually happening, kept so that when it ends
     there is something to remember it by.

     Its own list rather than a read of `dialogueHistory` at teardown, and the
     difference is not stylistic. `dialogueHistory` is derived from
     `frontierMessages`, which is persisted: it holds what he said on this
     screen yesterday too, and `newChatSession` can empty it mid-conversation.
     A teardown that read it would be consolidating something other than "the
     session that just ended", which is the only thing the memory pass is
     allowed to touch.

     Emptied by the pass that consumes it, which is what makes a second run
     harmless: it finds nothing and writes nothing. React strict mode does
     exactly that on every mount in development. */
  const sessionTranscriptRef = useRef<TranscriptTurn[]>([]);
  const uncommittedUserSpeechRef = useRef<string | null>(null);

  const rememberTurn = useCallback((role: "user" | "assistant", content: string) => {
    const clean = content.trim();
    if (clean) sessionTranscriptRef.current.push({ role, content: clean });
  }, []);

  /* Spoken user speech updates the last bubble only when it is an in-place prefix refinement.
     Distinct user turns are preserved so consecutive messages are never overwritten. */
  const rememberUserSpeech = useCallback((content: string) => {
    const clean = content.trim();
    if (!clean) return;
    const turns = sessionTranscriptRef.current;
    const last = turns[turns.length - 1];
    if (last && last.role === "user") {
      if (last.content === clean) return;
      if (clean.startsWith(last.content)) {
        last.content = clean;
        return;
      }
    }
    turns.push({ role: "user", content: clean });
  }, []);

  const commitSpokenTurn = useCallback((truncateToSpoken: boolean) => {
    if (captionCommitTimer.current) {
      clearTimeout(captionCommitTimer.current);
      captionCommitTimer.current = null;
    }
    const pacer = pacerRef.current;
    const pending = pendingFinalRef.current;
    if (!pending && !truncateToSpoken) {
      if (!truncateToSpoken) return;
      assistantTurnActiveRef.current = false;
      const cut = pacer.advanceTo(secondsPlayedRef.current);
      if (cut) {
        pacer.completeTurn(cut, secondsPlayedRef.current);
        const userPrefix = uncommittedUserSpeechRef.current;
        uncommittedUserSpeechRef.current = null;
        awaitingAssistantAnswerRef.current = false;
        setDialogueHistory((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            if (last.content.trim() === cut.trim()) return prev;
            if (
              cut.trim().startsWith(last.content.trim()) ||
              (cut.trim().length > last.content.trim().length && cut.trim().includes(last.content.trim()))
            ) {
              return [...prev.slice(0, -1), { ...last, content: cut }];
            }
            if (last.content.trim().includes(cut.trim())) return prev;
          }
          const shouldPrependUser =
            userPrefix &&
            (!last || last.role !== "user") &&
            !prev.some(
              (t) =>
                t.role === "user" &&
                (t.content.trim().toLowerCase().startsWith(userPrefix.trim().toLowerCase()) ||
                  userPrefix.trim().toLowerCase().startsWith(t.content.trim().toLowerCase()))
            );
          return [
            ...prev,
            ...(shouldPrependUser ? [{ id: `user-${Date.now() - 1}`, role: "user" as const, content: userPrefix }] : []),
            { id: `asst-${Date.now()}`, role: "assistant", content: cut },
          ];
        });
        if (userPrefix) rememberTurn("user", userPrefix);
        rememberTurn("assistant", cut);
      }
      setLiveAssistantStream(null);
      setLiveUserSpeech(null);
      return;
    }
    assistantTurnActiveRef.current = false;
    const spoken = truncateToSpoken
      ? pacer.advanceTo(secondsPlayedRef.current) || pending
      : pacer.revealAll() || pending;
    const targetText = truncateToSpoken ? spoken : (pending || spoken);
    if (targetText) {
      pacer.completeTurn(targetText, secondsPlayedRef.current);
    }
    pendingFinalRef.current = null;
    /* `spoken` is empty when the pacer was already closed, which means this
       turn has been committed once already. Appending here is exactly the
       duplicate row, minus its text. */
    if (spoken) {
      const userPrefix = uncommittedUserSpeechRef.current;
      uncommittedUserSpeechRef.current = null;
      awaitingAssistantAnswerRef.current = false;
      setDialogueHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          if (last.content.trim() === spoken.trim()) {
            return prev;
          }
          if (
            spoken.trim().startsWith(last.content.trim()) ||
            (spoken.trim().length > last.content.trim().length && spoken.trim().includes(last.content.trim()))
          ) {
            return [...prev.slice(0, -1), { ...last, content: spoken }];
          }
          if (last.content.trim().includes(spoken.trim())) {
            return prev;
          }
        }
        const shouldPrependUser =
          userPrefix &&
          (!last || last.role !== "user") &&
          !prev.some(
            (t) =>
              t.role === "user" &&
              (t.content.trim().toLowerCase().startsWith(userPrefix.trim().toLowerCase()) ||
                userPrefix.trim().toLowerCase().startsWith(t.content.trim().toLowerCase()))
          );
        return [
          ...prev,
          ...(shouldPrependUser ? [{ id: `user-${Date.now() - 1}`, role: "user" as const, content: userPrefix }] : []),
          { id: `asst-${Date.now()}`, role: "assistant", content: spoken },
        ];
      });
      if (userPrefix) rememberTurn("user", userPrefix);
      rememberTurn("assistant", spoken);
      echoGuardRef.current.remember(spoken);
    }
    setLiveAssistantStream(null);
    setLiveUserSpeech(null);
  }, [rememberTurn]);
  const commitSpokenTurnRef = useRef(commitSpokenTurn);
  commitSpokenTurnRef.current = commitSpokenTurn;
  const protocolRef = useRef<GeminiLiveEngine | null>(null);
  const echoGuardRef = useRef(new EchoGuard());

  /* Hand one line to the voice, and write it into the transcript only if the
     voice never takes it. See `unspokenLineRef` for why that is the rule.
     When framing is "report", it is handed to Gemini Live to answer in Temi's voice;
     we never dump the raw background report text into the transcript. */
  const speakLine = useCallback(
    (text: string, framing: "verbatim" | "report") => {
      const line = text.trim();
      if (!line) return;
      echoGuardRef.current.remember(line);
      assistantAskedQuestionRef.current = line.endsWith("?");
      if (audioRef.current?.isMuted) {
        assistantTurnEndedAtRef.current = Date.now();
        setDialogueHistory((prev) => [
          ...prev,
          { id: `asst-${Date.now()}`, role: "assistant", content: line },
        ]);
        return;
      }
      const protocol = protocolRef.current;
      if (framing === "report") protocol?.sendUserText(frameAssistantReport(line));
      else protocol?.sendAssistantDirective(line);

      /* One slot, so a second line supersedes the first rather than queueing
         behind it. Two shell-composed lines inside four seconds means the
         later one is the one that matters -- a report landing on top of its
         own "on it", most often. */
      if (unspokenLineRef.current) clearTimeout(unspokenLineRef.current.timer);
      unspokenLineRef.current = {
        text: line,
        timer: setTimeout(() => {
          unspokenLineRef.current = null;
          setDialogueHistory((prev) => [
            ...prev,
            { id: `asst-${Date.now()}`, role: "assistant", content: line },
          ]);
        }, SPOKEN_LINE_FALLBACK_MS),
      };
    },
    [setDialogueHistory],
  );
  const speakLineRef = useRef(speakLine);
  speakLineRef.current = speakLine;
  const toastTimerRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  // The socket effect runs once and must keep running once — putting the turn
  // handler in its dependency list would reopen the live session on every render.
  const performTurnRef = useRef<((text: string, source: TurnSource) => void) | null>(null);
  // What Temi last said, so "say that again" has something to say again.
  const lastSpokenRef = useRef<string | null>(null);
  const isSpeakingRef = useRef(false);
  /* When the microphone first heard this turn, and when she last stopped
     talking. Both feed gates rather than the screen, so both are refs: they are
     read from `onMessage`, which is installed into the socket once and would
     otherwise see the state as it was when the session opened.

     `turnStartedAtRef` is what `selfAudio.audibleSince` is asked about — a
     recogniser hands back a final transcript some way behind the audio it was
     built from, so "was the app making sound at any point that could be in this
     turn?" is a different question from "is it making sound now?". */
  const turnStartedAtRef = useRef(0);
  const assistantTurnEndedAtRef = useRef(0);
  /* Did her last turn end in a question? Two gates need this and neither can
     work without it: the addressing blend opens a follow-up window on it, and
     the turn switch uses it to tell "yes, run them" from "yes, nice work". */
  const assistantAskedQuestionRef = useRef(false);
  /* How many delegations this screen started and has not seen finish. Read on
     unmount, where a run nobody is listening to any more is an orphan. */
  const delegationsInFlightRef = useRef(0);
  const pendingReportSpeechRef = useRef(false);
  const reportBaseSamplesRef = useRef(0);
  const captureTotalSamplesRef = useRef(0);
  /* The folders a spoken name is allowed to resolve to.

     A ref rather than state because it is read from `performVoiceTurn`, which
     lives in `performTurnRef` and is installed into the socket once: a state
     copy would be the empty array the socket opened with, forever. It is also
     never rendered, so there is nothing for state to buy.

     The gateway is the only source of these in the renderer. `workspaceActions`
     can list a directory itself, but only through an injected `fs.readdirSync`,
     and the renderer is a browser bundle with no `fs`. The cost is the known
     limitation: a project the operator has never opened is not in `recent`, so
     it is not a candidate and that turn correctly falls through to the
     assistant, which can reach the disk. */
  const workspaceCandidatesRef = useRef<FolderCandidate[]>([]);
  /* The two halves of the candidate list, kept apart so either can be replaced
     without dropping the other. `absorbProjects` runs again after every switch;
     if the discovered folders lived only in the merged list they would be wiped
     by the first switch and voice would silently shrink back to the recents. */
  const projectsRef = useRef<ProjectsResponse | null>(null);
  const discoveredRef = useRef<readonly { path: string; name: string }[]>([]);
  /* Whether the root the shell is bound to is a video project.

     The editor grammar is small but its words are not rare: "undo that",
     "delete that clip", "pause it" are all things an operator says to an agent
     working on code, and answering them by reaching for a timeline that is not
     there would turn ordinary conversation into "That didn't work". The gateway
     already answers this question — it classifies a directory as `video` from
     the `teminali-video-project` marker in its `project.json` — so the shell
     does not have to guess and no new state has to be invented. */
  const isVideoProjectRef = useRef(false);
  /* Whether the gateway has actually answered that question.
     `isVideoProjectRef` is a boolean with three meanings and only two values:
     "video", "code", and "we never found out". It is set from
     `WorkspaceService.listProjects`, whose failure path is a deliberate
     `.catch(() => undefined)` — so one failed fetch on mount left it `false`,
     and `false` gated the entire editor lane off for the rest of the session
     with no error anywhere and no way for the operator to tell. Separating "we
     know it is not video" from "we do not know" is what lets the unknown case
     fall back to something true instead of to something safe-looking. */
  const projectKindKnownRef = useRef(false);
  /* The fallback for the unknown case: a timeline with clips on it. Loaded
     lazily and only when it is needed, and read by `getState()` rather than
     subscribed to — the playhead lives in that store and is written on every
     frame of playback. */
  const timelineProbeRef = useRef<TimelineProbe | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the operator is reading the live end of the conversation. Scrolling
  // up to re-read something must not be yanked back by the next turn arriving.
  const pinnedToBottomRef = useRef(true);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2400);
  }, []);

  const lastProgressSpokenAtRef = useRef(0);
  const narrateProgress = useCallback(
    (summary: string) => {
      if (!summary) return;
      const clean = summary
        .replace(/(\b[a-zA-Z0-9_-]+)\s+dot\s+(html|css|js|ts|tsx|jsx|json|py|md|txt|sh|yml|yaml|sql|png|jpg|svg)\b/gi, "$1.$2")
        .trim();
      showToast(clean);
      if (/^(Starting background|Task assigned|Finished|Starting that|Taking a look)/i.test(clean)) {
        return;
      }
      const now = Date.now();
      if (now - lastProgressSpokenAtRef.current >= 2500) {
        lastProgressSpokenAtRef.current = now;
        protocolRef.current?.sendAssistantDirective(clean);
      }
    },
    [showToast],
  );
  const narrateProgressRef = useRef(narrateProgress);
  narrateProgressRef.current = narrateProgress;

  /* ── Was that meant for me? ──────────────────────────────────────────────
     Everything below this line is the gate the audit of 2026-09-12 found was
     not wired to anything. `scoreAddressing`, `stripWakeWord` and
     `selfAudio.audibleSince` all existed, all worked, and all had exactly one
     caller: `conversation.ts`, which nothing on this screen mounts. So this
     stage took every final transcript as an instruction, and a sentence from
     the room that happened to contain a machine verb delegated a real run.

     Two layers, in this order, because they fail differently.

     1. PROVENANCE. While the app itself is making sound — a video in the Files
        panel, a page in the Browser panel, the operator's own footage on the
        timeline — the bar is a wake word, with one exemption. The transcript
        of a film is real speech, correctly heard, addressed to nobody in this
        room, and no gate that asks *who a sentence was for* can tell it from
        an operator, because it genuinely is a person speaking. Not a closed
        microphone: "Temy, pause the video" is the turn most needed while
        something is playing, and it still lands. See services/voice/selfAudio.ts.

        The exemption is transport, and only with a player pane mounted: a bare
        "pause", "play" or "play/pause" is admitted, because the wake word was
        costing the turn most often said at a playing video, and because mpv
        plays out of process, never registers as self-audio, and has always
        taken a bare "pause" — the strict bar made the same sentence work in one
        player and not the other. Seek, volume, mute, fullscreen, speed and
        subtitles all stay behind the wake word, along with every other lane, so
        the worst a film can say to itself is pause or resume. Chosen by the
        operator; see `survivesSelfAudioWithoutWakeWord` in playerActions.ts.

     2. ADDRESSING. The blend in `addressing.ts`. The context is honest about
        what this surface actually knows: there is no speaker enrolment here
        and no wake-word setting here, so no profile is claimed and no wake word
        is required — the operator opened a hands-free screen on purpose, and in
        that room an ordinary sentence is for the assistant unless something
        says otherwise. What "something says otherwise" means in practice is
        third-party phrasing, which costs 0.45 and puts "hold on, I'll call you
        back" well under the line.

     `needsClassifier` is ignored, and correctly: it is only ever true in
     wake-word-only mode, and there is no local completion on this lane to spend
     the latency on.

     Returns the text to route — the wake word stripped off, so "Temy, open
     DukaBot" reaches the switch as a command and not as a greeting — or null
     when the turn was not ours. */
  const gateSpokenTurn = useCallback(
    (heard: string, turnStartedAt: number): string | null => {
      const wakeWords = voice?.settings.wakeWords ?? ["temi", "teminali", "frontier", "studio"];
      const { text: stripped, matched: wakeWord } = stripWakeWord(heard, wakeWords);
      const routed = stripped || heard;

      const echoVerdict = echoGuardRef.current.filter(routed);
      if (echoVerdict.echoed && !echoVerdict.text) {
        traceVoice("dropped", { by: "self-echo", overlap: echoVerdict.overlap });
        return null;
      }
      const cleanRouted = echoVerdict.echoed && echoVerdict.text ? echoVerdict.text : routed;

      if (selfAudio.audibleSince(turnStartedAt)) {
        if (!wakeWord) {
          if (!survivesSelfAudioWithoutWakeWord(routed)) {
            traceVoice("dropped", { by: "self-audio" });
            return null;
          }
          traceVoice("admitted", { by: "transport-exemption" });
        }
        return cleanRouted;
      }

      const { verdict } = scoreAddressing(heard, {
        assistantAskedQuestion: assistantAskedQuestionRef.current,
        msSinceAssistantTurn: Date.now() - assistantTurnEndedAtRef.current,
        speakerMatch: null,
        hasProfile: false,
        requireWakeWord: false,
        requireSpeakerMatch: false,
        wakeWords,
        windowFocused: typeof document !== "undefined" ? document.hasFocus() : true,
      });
      if (!verdict.directed) {
        traceVoice("dropped", { by: "addressing", reason: verdict.reason });
        return null;
      }
      return cleanRouted;
    },
    [voice?.settings.wakeWords],
  );
  const gateSpokenTurnRef = useRef(gateSpokenTurn);
  gateSpokenTurnRef.current = gateSpokenTurn;

  /* ── The command gate, offered to the ears as well as to the mouse ───────
     `useSpokenApproval` was mounted in StudioChat and in AgentPane and never
     here, so "approve that" and "yes go ahead" — the two sentences an operator
     on a hands-free screen is most likely to use — routed as conversation and
     the standing prompt went on standing.

     Three halves, and the third one is why this is not a one-line hook call:

     - `approveCommand` is handed to every delegation (see the delegate case),
       so a run that needs permission asks for it rather than being denied in a
       millisecond by an absent gate.
     - The pending request is published to `approvalStore`, which is what
       `useSpokenApproval.consume` reads. Without it the hook has nothing to
       consume and "yes" means nothing.
     - The question is spoken from here. `useSpokenApproval` speaks through a
       `UseVoiceResult`, and this stage's voice is the live socket rather than
       one of those, so its own asking half stays quiet and this does the
       asking. `consume` does not depend on it and answers either way. */
  const commandApproval = useCommandApproval();
  const approvalVoiceRef = useRef<UseVoiceResult | null>(voice ?? null);
  approvalVoiceRef.current = voice ?? null;
  const spokenApproval = useSpokenApproval(approvalVoiceRef);
  const approveRef = useRef(commandApproval);
  approveRef.current = commandApproval;
  const approvalPending = commandApproval.pending;
  const storeApprovalPending = useApprovalStore((state) => state.pending);
  const spokenStoreApprovalRef = useRef<string | null>(null);

  useEffect(() => {
    if (!approvalPending) return;
    const store = useApprovalStore.getState();
    // One command at a time, so the command is its own identity — there is no
    // id to carry and a re-render must not re-ask.
    const id = `voice:${approvalPending.command}`;
    const asker = "The assistant";
    const alwaysLabel = commandHead(approvalPending.command);
    store.offer({
      id,
      source: "chat",
      asker,
      action: approvalPending.command,
      alwaysLabel,
      answer: (behavior, remember) => {
        store.withdraw(id);
        if (behavior === "allow") approveRef.current.approve(remember);
        else approveRef.current.deny();
      },
    });
    return () => store.withdraw(id);
  }, [approvalPending]);

  // Audibly ask for approval whenever ANY approval is offered in useApprovalStore
  // (covers both chat commands and background agent delegations)
  useEffect(() => {
    if (!storeApprovalPending) {
      spokenStoreApprovalRef.current = null;
      return;
    }
    if (spokenStoreApprovalRef.current === storeApprovalPending.id) return;
    spokenStoreApprovalRef.current = storeApprovalPending.id;

    speakLineRef.current(
      describeApprovalRequest({
        asker: storeApprovalPending.asker,
        action: storeApprovalPending.action,
        alwaysLabel: storeApprovalPending.alwaysLabel,
      }),
      "verbatim",
    );
    /* The prompt is a question even though it does not end in one — it ends in
       the list of answers. Marked explicitly so the follow-up window opens and
       a one-word "yes" clears the addressing gate. */
    assistantAskedQuestionRef.current = true;
  }, [storeApprovalPending]);

  // ── The transcript is kept, not faded ────────────────────────────────────
  // Both modes scroll back over the whole conversation: muted, this is an
  // ordinary text chat and scrollback is the point; unmuted, it is the record
  // of what was actually heard, which is exactly what you reach for when a
  // spoken answer went past too quickly.
  const turns: DialogueTurn[] = React.useMemo(() => {
    let baseHistory = dialogueHistory;
    const cleanUser = liveUserSpeech ? liveUserSpeech.trim() : "";
    const cleanAsst = liveAssistantStream ? liveAssistantStream.trim() : "";

    // 1. Live Assistant Streaming
    if (cleanAsst) {
      const last = baseHistory[baseHistory.length - 1];
      // Suppress fragments that already exist verbatim in dialogue history
      const alreadyInHistory = baseHistory.some(
        (t) => t.role === "assistant" && (t.content.trim() === cleanAsst || t.content.trim().includes(cleanAsst))
      );

      if (!alreadyInHistory) {
        if (last && last.role === "assistant") {
          // If continuing the current assistant bubble, update its content
          if (cleanAsst.startsWith(last.content.trim()) || last.content.trim().startsWith(cleanAsst)) {
            baseHistory = [
              ...baseHistory.slice(0, -1),
              { ...last, content: cleanAsst, pending: true },
            ];
          } else {
            baseHistory = [
              ...baseHistory,
              { id: "live-assistant", role: "assistant" as const, content: cleanAsst, pending: true },
            ];
          }
        } else {
          // Check if cleanUser is already in baseHistory before attaching
          const userAlreadyPresent =
            cleanUser &&
            baseHistory.some(
              (t) =>
                t.role === "user" &&
                (t.content.trim().toLowerCase().startsWith(cleanUser.toLowerCase()) ||
                  cleanUser.toLowerCase().startsWith(t.content.trim().toLowerCase()))
            );
          return [
            ...baseHistory,
            ...(cleanUser && !userAlreadyPresent
              ? [{ id: "live-user", role: "user" as const, content: cleanUser, pending: true }]
              : []),
            { id: "live-assistant", role: "assistant" as const, content: cleanAsst, pending: true },
          ];
        }
      }
    }

    // 2. Live User Speech Streaming
    if (cleanUser) {
      const last = baseHistory[baseHistory.length - 1];
      // Check if user turn is already represented in baseHistory (subsumed or equal)
      const alreadyCommitted = baseHistory.some(
        (t) =>
          t.role === "user" &&
          (t.content.trim().toLowerCase().startsWith(cleanUser.toLowerCase()) ||
            cleanUser.toLowerCase().startsWith(t.content.trim().toLowerCase()))
      );

      if (!alreadyCommitted) {
        if (last && last.role === "user") {
          return [
            ...baseHistory.slice(0, -1),
            { ...last, content: cleanUser, pending: true },
          ];
        } else {
          return [...baseHistory, { id: "live-user", role: "user" as const, content: cleanUser, pending: true }];
        }
      }
    }

    return baseHistory;
  }, [dialogueHistory, liveUserSpeech, liveAssistantStream]);

  /* The landing screen: the seeded greeting and nothing else.
     `turns.length === 0` is never true — a chat with no messages draws
     INITIAL_DIALOGUE rather than an empty list (see `dialogueFromMessages`), so
     the test is for that seed being all there is. This is also why the greeting
     is never stored: a chat holding one real message would stop being empty and
     the landing screen would never come back. A live utterance appends to
     `turns` before the history does, which is what makes the switch happen the
     moment the operator speaks rather than when the round-trip lands. */
  const isEmpty = turns.length === 1 && turns[0]?.id === "init-temi";

  const handleTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns]);

  /* The gateway's project list, folded into candidates the resolver can score.
     `current` goes in first so "open the folder I'm already in" resolves to a
     no-op rather than falling through to a delegate. */
  /* Everything the resolver is allowed to score, in one list: the project he is
     in, the ones he has opened before, then every folder found under the
     allowed roots.

     THE DEDUPE IS LOAD BEARING, not tidiness. `resolveFolder` refuses when the
     winner has no margin over the runner up and there is not exactly one exact
     match. A folder that is both recent AND discovered -- which is every folder
     he actually uses -- would therefore appear twice, score 1.0 twice, and be
     REFUSED. Adding discovery without this would have broken the one command
     that already worked. Path order is preserved so `current` still wins, which
     is what makes "open the folder I'm already in" a no-op rather than a
     delegate. */
  const rebuildCandidates = useCallback(() => {
    const projects = projectsRef.current;
    const seenPath = new Set<string>();
    const seenName = new Set<string>();
    const entries: { path: string; name?: string }[] = [];
    for (const entry of [
      ...(projects ? [projects.current, ...projects.recent] : []),
      ...discoveredRef.current,
    ]) {
      const key = entry?.path?.replace(/\/+$/, "") ?? "";
      if (!key || seenPath.has(key)) continue;
      /* One folder per NAME, and the first one wins because the list above is
         already in priority order. This is not tidiness either: `resolveFolder`
         refuses outright when two candidates match the spoken name EXACTLY
         (`exactCount > 1`), because it will not guess between them -- and that
         refusal is correct and stays. But the operator really does have two
         different directories called `4K Video Downloader+`, one in ~/Downloads
         and one in ~/Movies, and scanning the roots put both in the list, so
         the command that worked against the 12-entry store started resolving to
         nothing the moment discovery was added. A name lookup cannot tell two
         identical names apart, so the one he has actually opened is the only
         defensible answer, and it is decided HERE rather than by weakening the
         resolver's refusal. Cost, stated plainly: a folder whose name duplicates
         one he has used more recently is not reachable by that name. */
      const label = (entry?.name ?? key.split("/").filter(Boolean).pop() ?? "").toLowerCase();
      if (label && seenName.has(label)) continue;
      seenPath.add(key);
      if (label) seenName.add(label);
      entries.push(entry);
    }
    workspaceCandidatesRef.current = candidatesFromEntries(entries);
  }, []);

  const absorbProjects = useCallback(
    (projects: ProjectsResponse) => {
      projectsRef.current = projects;
      isVideoProjectRef.current = projects.current.kind === "video";
      projectKindKnownRef.current = true;
      rebuildCandidates();
    },
    [rebuildCandidates],
  );

  /**
   * Whether an edit command can be acted on right now.
   *
   * The gateway's answer when there is one, and the timeline's own when there
   * is not. "A timeline is loaded" is a weaker signal than the
   * `teminali-video-project` marker and it is deliberately the second choice —
   * but it is a true one, and it is the difference between "undo that" working
   * after a failed mount fetch and the whole editor lane being silently dead
   * until the app is restarted.
   */
  const editorLaneOpen = useCallback((): boolean => {
    if (projectKindKnownRef.current) return isVideoProjectRef.current;
    const tracks = timelineProbeRef.current?.getState().tracks ?? [];
    return tracks.some((track) => track.clips.length > 0);
  }, []);

  /* Fetched once, on mount. A failure here is not worth a line to the operator:
     it costs the fast path, and every spoken folder name then falls through to
     the assistant, which is exactly where it went before this existed. */
  useEffect(() => {
    const controller = new AbortController();
    void WorkspaceService.listProjects(controller.signal)
      .then(absorbProjects)
      .catch(() => {
        /* Silent to the operator, but not silent to the editor lane. Without a
           project kind the lane has to be decided some other way, so the
           timeline's own state is fetched to decide it with. Dynamic, for the
           same reason `runEditorCommand` imports the registry dynamically: this
           screen usually never touches the editor at all. */
        void import("../../video/store/timelineStore")
          .then((module) => {
            timelineProbeRef.current = module.useTimelineStore;
          })
          .catch(() => undefined);
      });
    /* The folders he has never opened. Without this the fast path could only
       reach what was already in the recent-projects store, so a folder he has
       not opened before was unreachable by voice however clearly he said its
       name -- it fell through to the assistant, which is the slow path this
       whole lane exists to avoid. Fetched alongside the recents rather than
       after them: the two settle independently and `rebuildCandidates` merges
       whichever has arrived. A failure here is not worth a line to the
       operator, for the same reason the projects fetch is silent. */
    void WorkspaceService.discoverProjectFolders(controller.signal)
      .then((discovered) => {
        discoveredRef.current = discovered.folders;
        rebuildCandidates();
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [absorbProjects, rebuildCandidates]);

  // ── Initialize the Real 8000 AudioEngine & ProtocolManager ───────────────
  useEffect(() => {
    /* Started first, before a single object is constructed, because the system
       instruction is composed inside `connect()` and reads the store
       synchronously. Everything below is local work: two constructors and
       about three hundred handler assignments. The read is a localhost GET of
       a small JSON file, so it overlaps with that and is normally settled long
       before `connect` is reached.

       "Normally" is why `connect` is still sequenced behind it rather than
       fired alongside. A gateway that is slow to answer would otherwise open
       the session with an empty store and she would walk in having forgotten
       him, silently, with nothing in the transcript to show it happened. */
    const primed = primeTemiMemory();

    const audio = new VoiceAudioEngine();
    const protocol = new GeminiLiveEngine({ voice: useAssistantActivityStore.getState().selectedVoice });
    /* Declared here rather than beside `onNote`, because `onError` is assigned
       up with `onConnected` and needs it too. */
    let cancelled = false;

    // Live Voice Capture for self-improving dev module & automated testing
    const liveVoiceCapture = {
      active: false,
      startedAt: 0,
      firstChunkAt: 0,
      lastChunkAt: 0,
      chunks: [] as Int16Array[],
      totalSamples: 0,
      turnCaptions: [] as string[],
      resolvers: [] as Array<(payload: unknown) => void>,
      chunkSettleTimer: null as ReturnType<typeof setTimeout> | null,
      /** Snapshot of frontierMessages.length when this capture began.
       *  Used to scope the store lookup so a stale Turn N answer is not
       *  attributed to Turn N+1 during continuous conversation. */
      msgCountAtStart: 0,
    };

    const buildCapturedVoicePayload = () => {
      const total = liveVoiceCapture.totalSamples;
      const flat = new Int16Array(total);
      let offset = 0;
      for (const chunk of liveVoiceCapture.chunks) {
        flat.set(chunk, offset);
        offset += chunk.length;
      }

      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < total; i++) {
        const norm = flat[i] / 32768.0;
        sumSq += norm * norm;
        const abs = Math.abs(norm);
        if (abs > peak) peak = abs;
      }
      const rms = total > 0 ? Math.sqrt(sumSq / total) : 0;
      const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -100;

      // 44-byte RIFF WAV Header for 48000 Hz 16-bit Mono PCM
      const wavHeader = new ArrayBuffer(44);
      const v = new DataView(wavHeader);
      const dataBytes = total * 2;
      v.setUint8(0, 0x52); v.setUint8(1, 0x49); v.setUint8(2, 0x46); v.setUint8(3, 0x46); // "RIFF"
      v.setUint32(4, 36 + dataBytes, true);
      v.setUint8(8, 0x57); v.setUint8(9, 0x41); v.setUint8(10, 0x56); v.setUint8(11, 0x45); // "WAVE"
      v.setUint8(12, 0x66); v.setUint8(13, 0x6d); v.setUint8(14, 0x74); v.setUint8(15, 0x20); // "fmt "
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); // PCM
      v.setUint16(22, 1, true); // Mono (1 channel)
      v.setUint32(24, 48000, true); // 48kHz
      v.setUint32(28, 48000 * 2, true); // ByteRate (48000 * 1 * 2)
      v.setUint16(32, 2, true); // BlockAlign (1 * 2)
      v.setUint16(34, 16, true); // 16 bits
      v.setUint8(36, 0x64); v.setUint8(37, 0x61); v.setUint8(38, 0x74); v.setUint8(39, 0x61); // "data"
      v.setUint32(40, dataBytes, true);

      const headerBytes = new Uint8Array(wavHeader);
      const pcmBytes = new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength);
      const fullBytes = new Uint8Array(headerBytes.length + pcmBytes.length);
      fullBytes.set(headerBytes, 0);
      fullBytes.set(pcmBytes, headerBytes.length);

      let binary = "";
      const CHUNK = 8192;
      for (let i = 0; i < fullBytes.length; i += CHUNK) {
        const sub = fullBytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, sub as unknown as number[]);
      }
      const base64Wav = btoa(binary);

      const latencyToFirstAudioMs = liveVoiceCapture.firstChunkAt && liveVoiceCapture.startedAt
        ? liveVoiceCapture.firstChunkAt - liveVoiceCapture.startedAt
        : null;

      // Prefer live captions captured during THIS turn over the store, which
      // may still hold an answer from a prior turn in continuous conversation.
      const liveCap = liveVoiceCapture.turnCaptions[liveVoiceCapture.turnCaptions.length - 1] || "";
      let transcript = liveCap;
      if (!transcript) {
        // Fall back to the store, but only consider messages added AFTER this
        // capture started (msgCountAtStart) so stale prior-turn answers are
        // never returned as the current turn's transcript.
        const msgs = useStudioStore.getState().frontierMessages;
        const newMsgs = msgs.slice(liveVoiceCapture.msgCountAtStart);
        transcript = newMsgs.filter((m) => m.role === "assistant").pop()?.content || "";
      }

      return {
        sampleRate: 48000,
        totalSamples: total,
        durationSeconds: Math.round((total / 48000) * 100) / 100,
        chunkCount: liveVoiceCapture.chunks.length,
        peakAmplitude: Math.round(peak * 1000) / 1000,
        avgRms: Math.round(rms * 1000) / 1000,
        rmsDbfs: Math.round(rmsDbfs * 10) / 10,
        isVoiced: rmsDbfs > -45 && total > 2400,
        latencyToFirstAudioMs,
        transcript,
        allCaptions: liveVoiceCapture.turnCaptions,
        base64Wav,
      };
    };

    audioRef.current = audio;
    protocolRef.current = protocol;

    audio.onAudioChunkReady = (buf) => protocol.sendAudioChunk(buf);
    audio.onTTSPlaybackStarted = () => {
      isSpeakingRef.current = true;
      setIsSpeaking(true);
      awaitingAssistantAnswerRef.current = false;
      protocol.sendTTSStart();
      selfAudio.set("assistant:tts", true);
      const textToRemember = pendingFinalRef.current || lastSpokenRef.current;
      if (textToRemember) echoGuardRef.current.remember(textToRemember);
    };
    audio.onTTSPlaybackStopped = () => {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      protocol.sendTTSStop();
      selfAudio.drop("assistant:tts");
      echoGuardRef.current.markEnded();
      /* When she stopped. The follow-up window is measured from here, so a
         "yes" is judged against the moment the question finished being asked
         rather than the moment it finished generating. */
      assistantTurnEndedAtRef.current = Date.now();
      /* Debounced: the worklet reports "stopped" after 120ms of silence, which
         is the ordinary gap between two synthesised sentences as often as it is
         the end of the reply. Committing on the first one would cut the caption
         off mid-answer. */
      captionCommitTimer.current = setTimeout(() => {
        if (!isSpeakingRef.current) {
          commitSpokenTurnRef.current?.(false);
          // Only resolve test captures if there are no background tool delegations still in flight and audio is finished
          if (
            liveVoiceCapture.active &&
            liveVoiceCapture.chunks.length > 0 &&
            delegationsInFlightRef.current === 0 &&
            !pendingReportSpeechRef.current &&
            !audio.isTTSPlaying
          ) {
            const resolvers = liveVoiceCapture.resolvers.splice(0);
            const payload = buildCapturedVoicePayload();
            for (const res of resolvers) res(payload);
          }
        }
      }, 600);
    };

    audio.onTTSProgress = (seconds) => {
      secondsPlayedRef.current = seconds;
      if (!assistantTurnActiveRef.current) return;
      const shown = pacerRef.current.advanceTo(seconds);
      setLiveAssistantStream(shown);
      const pending = pendingFinalRef.current;
      if (pending && shown.length >= pending.length) {
        // The voice has said everything that was generated
        commitSpokenTurnRef.current?.(false);
      }
    };

    protocol.onConnected = () => {
      setIsWsConnected(true);
      // A socket that opened is a socket that works, and the note is the
      // record of a failure that is now over. `describeGeminiLive` already
      // returns "" on success, so this only ever clears a stale line.
      if (!cancelled) setVoiceNote(NO_VOICE_NOTE);
    };
    protocol.onDisconnected = () => {
      setIsWsConnected(false);
    };
    /* Every failure inside the engine calls this — a token the gateway refused,
       a socket `error` event, a throw out of `live.connect`, a throw out of
       `handleServerMessage`, and four more on the send paths. It was never
       assigned, so all of them were `this.onError?.()` against null: the engine
       reported its failures faithfully into nothing, and a dead voice lane was
       completely silent. Now it says so, and `voiceNote` is a banner rather
       than a tooltip on a 2.5px dot. */
    protocol.onError = (error) => {
      if (cancelled) return;
      /* A note that came with a remedy outranks this line, because this line
         is the same failure said worse. A refused token fires `onNote` and
         then `onError` one statement later, so a missing key reached the
         banner as the sentence naming the fix and was overwritten, before a
         frame was painted, by "Temi's voice hit an error: no-key: ...", which is
         raw pair the engine builds for the console. The remedy is cleared by
         the next note whatever it says, so nothing gets pinned here for
         longer than the failure behind it lasts. */
      setVoiceNote((current) =>
        current.remedy ? current : { text: `Temi's voice hit an error: ${describeVoiceError(error)}` },
      );
    };

    protocol.onMessage = (msg) => {
      const { type, content } = msg;

      // 1. Live Whisper Transcription
      if (type === "partial_user_request") {
        // Our own directive, mid-flight back to us -- not speech. Showing it
        // would caption the operator with words they never said.
        if (GeminiLiveEngine.isAssistantDirectiveEcho(content ?? "")) return;
        if (isAssistantReportEcho(content ?? "")) return;
        const echoCheck = echoGuardRef.current.filter(content ?? "");
        if (echoCheck.echoed && !echoCheck.text) {
          traceVoice("dropped", { by: "partial-self-echo", overlap: echoCheck.overlap });
          return;
        }
        // The first partial of a turn is the closest thing this lane has to
        // "speech began", which is what the self-audio gate is asked about.
        if (turnStartedAtRef.current === 0) turnStartedAtRef.current = Date.now();
        if (assistantTurnActiveRef.current || pendingFinalRef.current) {
          audio.stopTTSPlayback();
          setLiveAssistantStream(null);
          pendingFinalRef.current = null;
          assistantTurnActiveRef.current = false;
        }
        const textToDisplay = echoCheck.echoed && echoCheck.text ? echoCheck.text : content;
        uncommittedUserSpeechRef.current = textToDisplay;
        setLiveUserSpeech(textToDisplay);
      } else if (type === "final_user_request") {
        setLiveUserSpeech(null);
        const turnStartedAt = turnStartedAtRef.current;
        turnStartedAtRef.current = 0;
        if (content && content.trim()) {
          const clean = content.trim();
          uncommittedUserSpeechRef.current = clean;
          // What the microphone actually produced, before anything can drop it.
          // The whole diagnosis of a dead spoken turn starts here; see
          // `voiceTrace.ts` for why this is a ring and not a console line.
          traceVoice("heard", { text: clean });
          // A directive re-entering as a user turn must not be transcribed and
          // must not reach the switch: classified as work it delegates again,
          // and the loop never closes. See `isAssistantDirectiveEcho`.
          if (GeminiLiveEngine.isAssistantDirectiveEcho(clean)) {
            traceVoice("dropped", { by: "directive-echo" });
            uncommittedUserSpeechRef.current = null;
            return;
          }
          if (isAssistantReportEcho(clean)) {
            traceVoice("dropped", { by: "report-echo" });
            uncommittedUserSpeechRef.current = null;
            return;
          }

          const echoVerdict = echoGuardRef.current.filter(clean);
          if (echoVerdict.echoed && !echoVerdict.text) {
            traceVoice("dropped", { by: "self-echo", overlap: echoVerdict.overlap });
            uncommittedUserSpeechRef.current = null;
            if (isSpeakingRef.current || awaitingAssistantAnswerRef.current) {
              protocol.sendBargeIn();
            }
            return;
          }

          /* The addressing and self-audio gate, before anything acts on the
             words. See `gateSpokenTurn`. A turn that was not ours is not
             transcribed either: the transcript is the record of this
             conversation, and a stranger's sentence is not part of it. */
          const routed = gateSpokenTurnRef.current(clean, turnStartedAt);
          if (routed === null) {
            /* If the assistant is currently speaking or in the middle of preparing an answer
               to a user turn, ambient room noise or background chatter must be cleanly IGNORED.
               We do NOT barge in and do NOT cut off her playback! */
            if (isSpeakingRef.current || awaitingAssistantAnswerRef.current) {
              traceVoice("ignored", { text: clean, reason: "undirected noise while assistant is answering" });
              return;
            }

            traceVoice("dropped", { text: clean, by: "addressing-idle" });
            protocol.sendBargeIn();
            audio.stopTTSPlayback();
            return;
          }

          // Update last user bubble if from this same turn, or append new turn
          uncommittedUserSpeechRef.current = null;
          awaitingAssistantAnswerRef.current = true;
          setDialogueHistory((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "user") {
              if (last.content.trim() === clean) return prev;
              if (clean.startsWith(last.content.trim())) {
                return [...prev.slice(0, -1), { ...last, content: clean }];
              }
            }
            const alreadyPresent = prev.some(
              (t) =>
                t.role === "user" &&
                (t.content.trim().toLowerCase() === clean.toLowerCase() ||
                  t.content.trim().toLowerCase().startsWith(clean.toLowerCase()) ||
                  clean.toLowerCase().startsWith(t.content.trim().toLowerCase()))
            );
            if (alreadyPresent) return prev;
            return [...prev, { id: `user-${Date.now()}`, role: "user", content: clean }];
          });
          rememberUserSpeech(clean);

          // Everything the operator says now goes through one switch. A status
          // question is answered from the live run, a stop lands on the run, and
          // only real work reaches the assistant. `routed` rather than `clean`:
          // the wake word is an address, not content, and "Temy, open DukaBot"
          // has to reach the switch as "open DukaBot".
          performTurnRef.current?.(routed, "spoken");
        }
      }

      // 2. Live Assistant Text Generation
      else if (type === "partial_assistant_answer") {
        setLiveUserSpeech(null);
        uncommittedUserSpeechRef.current = null;
        const cleanContent = content ? stripStageDirections(content) : "";
        if (liveVoiceCapture.active && cleanContent) {
          liveVoiceCapture.turnCaptions.push(cleanContent);
        }
        /* She has the line. The transcript will get it from the speaker, so the
           fallback write must not also happen. See `unspokenLineRef`. */
        if (unspokenLineRef.current) {
          clearTimeout(unspokenLineRef.current.timer);
          unspokenLineRef.current = null;
        }
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          pacerRef.current.beginTurn();
          secondsPlayedRef.current = 0;
          audio.resetTTSProgress();
        }
        pacerRef.current.setText(cleanContent);
        setLiveAssistantStream(pacerRef.current.advanceTo(secondsPlayedRef.current));
      } else if (type === "final_assistant_answer") {
        setLiveUserSpeech(null);
        uncommittedUserSpeechRef.current = null;
        const cleanContent = content ? stripStageDirections(content) : "";
        if (liveVoiceCapture.active && cleanContent) {
          liveVoiceCapture.turnCaptions.push(cleanContent);
        }
        if (cleanContent) {
          lastSpokenRef.current = cleanContent;
          echoGuardRef.current.remember(cleanContent);
          /* Her own turn, so her own question. This is the case the follow-up
             window was built for: she asks "should I run the tests?", the
             operator says "yes", and without this that "yes" is one unaddressed
             word in a room and is dropped before it reaches anything. */
          assistantAskedQuestionRef.current = content.trim().endsWith("?");
          /* Generation has finished; the voice has not. The reply is held here
             and committed by the speaker — either when the caption catches up
             with it, or when playback has been quiet long enough to mean the
             end of the turn rather than the gap between two sentences. */
          pendingFinalRef.current = cleanContent;
          pacerRef.current.setText(cleanContent);
          setLiveAssistantStream(pacerRef.current.advanceTo(secondsPlayedRef.current));
          /* Unless no audio ever arrives. A caption must not be held hostage to
             a speaker that failed or was never switched on. */
          if (captionCommitTimer.current) clearTimeout(captionCommitTimer.current);
          captionCommitTimer.current = setTimeout(() => {
            if (secondsPlayedRef.current === 0) commitSpokenTurnRef.current?.(false);
          }, 2500);
        } else {
          setLiveAssistantStream(null);
        }
      }

      // 3. Spoken audio from the model, already resampled to the context rate
      else if (type === "tts_audio" && msg.int16) {
        audio.playTTSChunk(msg.int16);
        if (liveVoiceCapture.active) {
          if (!liveVoiceCapture.firstChunkAt) liveVoiceCapture.firstChunkAt = Date.now();
          liveVoiceCapture.lastChunkAt = Date.now();
          liveVoiceCapture.chunks.push(msg.int16);
          liveVoiceCapture.totalSamples += msg.int16.length;
          captureTotalSamplesRef.current = liveVoiceCapture.totalSamples;

          // Clear pendingReportSpeech once audio chunks for the report start streaming in
          if (
            pendingReportSpeechRef.current &&
            captureTotalSamplesRef.current > reportBaseSamplesRef.current + 4000
          ) {
            pendingReportSpeechRef.current = false;
          }

          if (liveVoiceCapture.chunkSettleTimer) clearTimeout(liveVoiceCapture.chunkSettleTimer);
          liveVoiceCapture.chunkSettleTimer = setTimeout(() => {
            if (
              liveVoiceCapture.active &&
              liveVoiceCapture.chunks.length > 0 &&
              delegationsInFlightRef.current === 0 &&
              !pendingReportSpeechRef.current &&
              !isSpeakingRef.current &&
              !audio.isTTSPlaying
            ) {
              const resolvers = liveVoiceCapture.resolvers.splice(0);
              const payload = buildCapturedVoicePayload();
              for (const res of resolvers) res(payload);
            }
          }, 850);
        }
      }

      // 4. Interruption / Barge-In Cut
      else if (type === "tts_interrupt") {
        audio.stopTTSPlayback();
        setIsSpeaking(false);
        commitSpokenTurnRef.current?.(true);
        if (
          liveVoiceCapture.active &&
          liveVoiceCapture.chunks.length > 0 &&
          delegationsInFlightRef.current === 0 &&
          !pendingReportSpeechRef.current
        ) {
          const resolvers = liveVoiceCapture.resolvers.splice(0);
          const payload = buildCapturedVoicePayload();
          for (const res of resolvers) res(payload);
        }
      }

      /* 5. She asked for the hands herself.

         Until today the decision to delegate was taken for her, by a regex in
         `machineAction.ts`, before she ever saw the turn. That gate is still
         there and still useful as a fast path, but it cannot be the whole
         story: it reads verbs and nouns, and what actually matters is whether
         SHE knows the answer. Measured 2026-09-12, spoken: asked the size of
         the operator's Desktop she said "12.4 gigabytes" (it is 38G), asked his
         remaining storage she said "512 gigabytes" (27Gi free on a 460Gi disk,
         so more than the whole drive), and challenged on it she said "the
         system provided those numbers" -- inventing a source to defend an
         invented number. No regex catches the general case of that, because the
         general case is "she does not know and says something anyway".

         So the model gets a tool and decides for itself. `machineAction` now
         guards the fast, obvious commands; this handles everything else,
         including the open-ended questions a search can answer and a
         conversation model cannot. */
      else if (type === "tool_call") {
        const args = (msg.args ?? {}) as { task?: unknown; spoken_note?: unknown };
        const task = typeof args.task === "string" ? args.task.trim() : "";
        const note = typeof args.spoken_note === "string" ? args.spoken_note.trim() : "";
        if (!task) {
          protocol.sendToolResponse(msg.id, msg.name, "No task was given, so nothing was run.");
        } else {
          /* The line she said she would say. The toast stays because the
             activity store types its rows as machine events
             (cmd/edit/read/test) and this is a sentence, but it is no longer
             the whole of it: `handoffAcknowledgement` ends the blocking call
             immediately so she can actually speak it. That silence was the
             defect -- see the comment on `handoffAcknowledgement`. */
          showToast(note || "Handing this to the assistant…");
          protocol.sendToolResponse(msg.id, msg.name, handoffAcknowledgement(note));
          void (async () => {
            delegationsInFlightRef.current += 1;
            try {
              /* `inspect` rather than `edit`: this path exists because she was
                 missing a fact, and `summariseOutcome` needs to know a silent
                 run answered a question rather than failed to do work.

                 `approveCommand` for the reason the delegate case gives: a run
                 that has to ask permission and has nobody to ask is denied in a
                 millisecond and reports a failure the operator cannot act on. */
              const options: TaskDelegationOptions = {
                action: "inspect",
                approveCommand: approveRef.current.approveCommand,
                onProgress: (prog) => narrateProgressRef.current?.(prog),
              };
              const report = await TeminaliAgentBridge.delegateTask(task, options);
              /* Capped as a backstop. `delegateTask` returns
                 `summariseOutcome`'s line, which is a sentence, so this has
                 never fired in practice; it is here because the report enters
                 the live session and competes for the same window the
                 conversation lives in. */
              const capped = report.length > 4000 ? `${report.slice(0, 4000)}\n[report truncated]` : report;
              pendingReportSpeechRef.current = true;
              reportBaseSamplesRef.current = captureTotalSamplesRef.current;
              speakLineRef.current(capped || "The assistant finished but reported nothing.", "report");
              setTimeout(() => {
                pendingReportSpeechRef.current = false;
              }, 7000);
            } catch (error) {
              /* Told, not swallowed. A run that reports nothing back leaves the
                 operator holding a question she has already promised to
                 answer. */
              const reason = error instanceof Error ? error.message : String(error);
              speakLineRef.current(`That could not be completed: ${reason}`, "verbatim");
            } finally {
              delegationsInFlightRef.current = Math.max(0, delegationsInFlightRef.current - 1);
            }
          })();
        }
      }
    };

    /* The engine reaches Gemini Live directly and mints its own credential on
       the way: the gateway holds the API key and hands back a single-use
       ephemeral token, so the renderer never sees the key and the stage never
       learns an address. That is why `connect()` takes no argument any more,
       and why the operator's one-line note arrives through the engine rather
       than from a status call here -- a token is `uses: 1`, so a second fetch
       just to render a sentence would burn one. */
    protocol.onNote = (note) => {
      /* The remedy is read off the note here rather than shipped with it,
         because `onNote` is typed `(note: string) => void` and the engine
         builds the argument: there is no room in the callback for a second
         field without changing the engine. `geminiLiveRemedy` compares
         against the same constant `describeGeminiLive` returns, so the
         sentence and its button are one edit, not two. */
      if (!cancelled) setVoiceNote({ text: note, remedy: geminiLiveRemedy(note) ?? undefined });
    };

    /* The engine has stamped every turn since 5109911 and nothing read the
       stamps, so the only latency anyone could quote was the harness
       utterance the A/B was run on. This is the ear's counterpart: a real
       conversation leaves a distribution behind it, and a turn the endpointer
       called too early prints CUT rather than being silently recovered.

       Console rather than a panel because it is diagnostic, and mirrored onto
       a global because the packaged app is driven over CDP here far more often
       than its devtools are opened: `teminaliTurnLatency()` in an evaluate
       returns the distribution without a conversation having to be watched.

       Its own global rather than a field on `window.teminali`, which preload
       defines through `contextBridge` and the renderer therefore cannot
       assign to. It is deliberately left in place on unmount, so the numbers
       survive him leaving the voice screen. */
    protocol.onTiming = (timing) => {
      const summary = recordTurn(timing);
      console.info(formatTurnLatency(timing, summary));
    };
    (window as unknown as { teminaliTurnLatency?: typeof turnLatencySummary }).teminaliTurnLatency =
      turnLatencySummary;
    (window as unknown as { __temiVoiceTest?: unknown }).__temiVoiceTest = {
      audio,
      protocol,
      sendAudioChunk: (buf: ArrayBuffer) => protocol.sendAudioChunk(buf),
      feedPcm48k: (pcm48k: Int16Array) => {
        const BATCH = 2048;
        let ts = Date.now() & 0xffffffff;
        for (let i = 0; i < pcm48k.length; i += BATCH) {
          const slice = pcm48k.subarray(i, Math.min(i + BATCH, pcm48k.length));
          const buf = new ArrayBuffer(8 + BATCH * 2);
          const view = new DataView(buf);
          view.setUint32(0, ts++, false);
          view.setUint32(4, 0, false);
          const int16 = new Int16Array(buf, 8);
          int16.set(slice);
          protocol.sendAudioChunk(buf);
        }
      },
      performVoiceTurn: (text: string) => {
        liveVoiceCapture.active = true;
        liveVoiceCapture.startedAt = Date.now();
        liveVoiceCapture.firstChunkAt = 0;
        liveVoiceCapture.lastChunkAt = 0;
        liveVoiceCapture.chunks = [];
        liveVoiceCapture.totalSamples = 0;
        liveVoiceCapture.turnCaptions = [];
        liveVoiceCapture.msgCountAtStart = useStudioStore.getState().frontierMessages.length;
        return performTurnRef.current?.(text, "spoken");
      },
      startVoiceCapture: () => {
        liveVoiceCapture.active = true;
        liveVoiceCapture.startedAt = Date.now();
        liveVoiceCapture.firstChunkAt = 0;
        liveVoiceCapture.lastChunkAt = 0;
        liveVoiceCapture.chunks = [];
        liveVoiceCapture.totalSamples = 0;
        liveVoiceCapture.turnCaptions = [];
        liveVoiceCapture.resolvers = [];
        liveVoiceCapture.msgCountAtStart = useStudioStore.getState().frontierMessages.length;
        return { ok: true, startedAt: liveVoiceCapture.startedAt };
      },
      stopVoiceCapture: () => {
        liveVoiceCapture.active = false;
        return buildCapturedVoicePayload();
      },
      getCapturedVoiceData: () => buildCapturedVoicePayload(),
      waitForSpokenResponse: (timeoutMs = 15000) => {
        return new Promise((resolve) => {
          if (!liveVoiceCapture.active) {
            liveVoiceCapture.active = true;
            liveVoiceCapture.startedAt = Date.now();
          }
          // If response audio has already arrived and settled with no active tasks, resolve immediately
          if (
            liveVoiceCapture.chunks.length > 0 &&
            delegationsInFlightRef.current === 0 &&
            !pendingReportSpeechRef.current &&
            !isSpeakingRef.current
          ) {
            resolve(buildCapturedVoicePayload());
            return;
          }
          const timer = setTimeout(() => {
            const idx = liveVoiceCapture.resolvers.indexOf(onDone);
            if (idx >= 0) liveVoiceCapture.resolvers.splice(idx, 1);
            resolve(buildCapturedVoicePayload());
          }, timeoutMs);
          const onDone = (payload: unknown) => {
            clearTimeout(timer);
            resolve(payload);
          };
          liveVoiceCapture.resolvers.push(onDone);
        });
      },
      runVoiceTestTurn: (query: string, timeoutMs = 25000) => {
        if (liveVoiceCapture.chunkSettleTimer) {
          clearTimeout(liveVoiceCapture.chunkSettleTimer);
          liveVoiceCapture.chunkSettleTimer = null;
        }
        audio.stopTTSPlayback();
        setLiveAssistantStream(null);
        setLiveUserSpeech(null);
        uncommittedUserSpeechRef.current = null;
        pendingFinalRef.current = null;
        assistantTurnActiveRef.current = false;
        pendingReportSpeechRef.current = false;
        reportBaseSamplesRef.current = 0;
        captureTotalSamplesRef.current = 0;
        liveVoiceCapture.active = true;
        liveVoiceCapture.startedAt = Date.now();
        liveVoiceCapture.firstChunkAt = 0;
        liveVoiceCapture.lastChunkAt = 0;
        liveVoiceCapture.chunks = [];
        liveVoiceCapture.totalSamples = 0;
        liveVoiceCapture.turnCaptions = [];
        liveVoiceCapture.resolvers = [];
        liveVoiceCapture.msgCountAtStart = useStudioStore.getState().frontierMessages.length;

        const promise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            const idx = liveVoiceCapture.resolvers.indexOf(onDone);
            if (idx >= 0) liveVoiceCapture.resolvers.splice(idx, 1);
            resolve(buildCapturedVoicePayload());
          }, timeoutMs);
          const onDone = (payload: unknown) => {
            clearTimeout(timer);
            resolve(payload);
          };
          liveVoiceCapture.resolvers.push(onDone);
        });

        // Record user bubble in transcript so dialogue history preserves continuous conversation context
        setDialogueHistory((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "user") {
            return [...prev.slice(0, -1), { ...last, content: query }];
          }
          return [...prev, { id: `user-${Date.now()}`, role: "user", content: query }];
        });
        rememberUserSpeech(query);

        // Perform turn with 'typed' source so conversational queries route to Gemini Live
        void performTurnRef.current?.(query, "typed");

        return promise;
      },
      getDialogueSummary: () => {
        const msgs = useStudioStore.getState().frontierMessages;
        const body = document.body ? document.body.innerText : "";
        const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
        return {
          messageCount: msgs.length,
          recentLines: lines.slice(-15),
          messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        };
      },
      turnOnListening: async () => {
        if (!audio.audioContext) {
          await audio.start();
        } else if (audio.isMuted) {
          audio.toggleMute();
        }
        setIsAudioStarted(true);
        setIsMicMuted(false);
        const start = Date.now();
        while (Date.now() - start < 8000 && !protocol.hasSession) {
          await new Promise((r) => setTimeout(r, 100));
        }
        return { isVoiceOn: true, isAudioStarted: true, isMicMuted: false, sessionReady: Boolean(protocol.hasSession) };
      },
      clearDialogue: () => {
        setDialogueHistory([]);
      },
      unmuteMic: async () => {
        if (!audio.audioContext) {
          await audio.start();
        } else if (audio.isMuted) {
          audio.toggleMute();
        }
        setIsAudioStarted(true);
        setIsMicMuted(false);
      },
      isTaskRunning: () => Boolean(useAssistantActivityStore.getState().isTaskRunning),
      muteMic: () => {
        if (audio && !audio.isMuted) {
          audio.toggleMute();
        }
        setIsMicMuted(true);
      },
      hasPendingApproval: () => {
        const approvalStorePending = Boolean(useApprovalStore.getState().pending);
        if (approvalStorePending) return true;
        const btns = Array.from(document.querySelectorAll("button"));
        return btns.some((b) => {
          if (b.disabled) return false;
          const t = b.innerText.trim();
          return t === "Allow" || t === "Always Allow" || t === "Always";
        });
      },
      approvePendingCommand: () => {
        const store = useApprovalStore.getState();
        if (store.pending) {
          const p = store.pending;
          store.withdraw(p.id);
          p.answer("allow", false);
          return true;
        }
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find((b) => {
          if (b.disabled) return false;
          const t = b.innerText.trim();
          return t === "Allow" || t === "Always Allow" || t === "Always";
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      },
      denyPendingCommand: () => {
        const store = useApprovalStore.getState();
        if (store.pending) {
          const p = store.pending;
          store.withdraw(p.id);
          p.answer("deny", false);
          return true;
        }
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find((b) => {
          if (b.disabled) return false;
          const t = b.innerText.trim();
          return t === "Deny" || t === "Reject";
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      },
      hasPendingChangesReview: () => {
        if (useChangeStore.getState().changes.length > 0) return true;
        const btns = Array.from(document.querySelectorAll("button"));
        return btns.some((b) => {
          if (b.disabled) return false;
          const t = b.innerText.trim();
          return t.startsWith("Accept all") || t === "Accept";
        });
      },
      acceptPendingChangesReview: () => {
        let clicked = false;
        try {
          if (useChangeStore.getState().changes.length > 0) {
            useChangeStore.getState().acceptAll();
            clicked = true;
          }
        } catch {}
        const btns = Array.from(document.querySelectorAll("button"));
        for (const btn of btns) {
          if (btn.disabled) continue;
          const t = btn.innerText.trim();
          if (t.startsWith("Accept all") || t === "Accept") {
            try {
              btn.click();
              clicked = true;
            } catch {}
          }
        }
        return clicked;
      },
      isSpeaking: () => Boolean(isSpeakingRef.current || audio.isTTSPlaying),
    };

    void primed.then(() => {
      if (!cancelled) return protocol.connect();
    });

    // Automatically initialize audio engine and turn on listening on studio startup
    void (async () => {
      try {
        await audio.start();
        if (!cancelled) {
          setIsAudioStarted(true);
          setIsMicMuted(false);
        }
      } catch (err) {
        console.info("Automatic mic listening deferred until user gesture:", err);
      }
    })();

    // Continuous audio energy sampling for the 3D Orb
    const sampleEnergy = () => {
      setUserEnergy(audio.getUserEnergy());
      animFrameRef.current = requestAnimationFrame(sampleEnergy);
    };
    animFrameRef.current = requestAnimationFrame(sampleEnergy);

    return () => {
      cancelled = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (unspokenLineRef.current) {
        clearTimeout(unspokenLineRef.current.timer);
        unspokenLineRef.current = null;
      }
      if (liveVoiceCapture.chunkSettleTimer) {
        clearTimeout(liveVoiceCapture.chunkSettleTimer);
        liveVoiceCapture.chunkSettleTimer = null;
      }
      audio.cleanup();
      protocol.disconnect();
      selfAudio.drop("assistant:tts");
      echoGuardRef.current.clear();
      delete (window as unknown as { __temiVoiceTest?: unknown }).__temiVoiceTest;

      /* The session is over, so now she gets to keep some of it.

         Here and nowhere else. DESIGN.md 6.48 puts the whole layer off the live
         turn, and this is the seam that holds it there: one model call, over a
         whole transcript, at the moment there is nobody left to keep waiting.

         Deliberately not awaited and deliberately not cancelled. The screen is
         going away, the renderer is not, and the pass carries its own deadline
         (`temiMemoryModel`) for that reason: handing it the signal that just
         fired would abort the extraction before it read a word.

         What this does not cover is quitting the app mid-conversation, which
         tears down the renderer without running a cleanup, and loses that
         session. The alternative is consolidating partway through, and that is
         the one thing the contract forbids. */
      const transcript = sessionTranscriptRef.current;
      sessionTranscriptRef.current = [];
      if (transcript.length > 0) {
        void runMemoryPass({
          turns: transcript,
          complete: temiMemoryModel(),
          load: loadTemiMemory,
          save: saveTemiMemory,
        })
          .then((report) => console.info(formatMemoryPass(report)))
          .catch(() => {});
      }
      /* The run this screen started, and this screen is going away.

         `onProgress` toasts and `onCompleted` speaks — both through refs into a
         component that no longer exists, and the socket the report was meant to
         be spoken over has just been disconnected. So the work went on, at cost,
         reporting to nobody: an orphan, not a background job. There is no other
         owner to hand it to; the voice screen is where it was asked for and the
         only place its report can land.

         Only when something is actually in flight. An unconditional stop here
         would abort a run the *chat* started every time the operator glanced at
         the voice screen and left. */
      if (delegationsInFlightRef.current > 0) {
        delegationsInFlightRef.current = 0;
        TeminaliAgentBridge.stopCurrentTask();
      }
    };
  }, [logAction]);

  /*
    A key pasted while this screen is open used to change nothing until quit.

    The effect above builds the engine once and depends on `logAction` alone,
    so the `no-key` refusal it got on mount was the last word that instance
    ever had: the gateway re-reads the provider store on every mint and would
    have handed out a token happily, but nothing asked it for one again. The
    operator's fix was to quit the app, which is the fix nobody should have to
    find. This asks again instead.

    Deliberately its own effect. Adding the save count to the dependency array
    above would tear down `VoiceAudioEngine` and the microphone with it, and if
    that ever fired while he was mid-sentence it would cut him off to fix a
    problem he no longer has.

    One attempt per save, and no guard against a live session needed: the
    engine's `connect()` already returns immediately when it holds one or is
    mid-connect, so a key saved for some other provider while voice is up
    costs nothing. A wrong key does not loop either: the attempt reports the
    new failure through `onNote` and stops there, and whatever retry ladder
    that failure deserves is the engine's to run, not this screen's.
  */
  const keySavesAtMount = useRef(providerKeySaves);
  useEffect(() => {
    if (providerKeySaves === keySavesAtMount.current) return;
    void protocolRef.current?.connect();
  }, [providerKeySaves]);

  /**
   * One parsed editor command, executed, and reported honestly.
   *
   * Exactly one line is spoken per command, and it is derived from the result
   * rather than from the request. `splitAtPlayhead` succeeds with `cut: 0` when
   * the playhead is over nothing, so announcing "Cut." on a successful call
   * tells the operator about an edit that did not happen — and he finds out at
   * the export. `describeEditorResult` is where that judgement lives.
   *
   * The export is the one command that speaks twice, deliberately: it holds the
   * machine for minutes, and the delegate path already established that silence
   * across a long job reads as a command that was never heard. Two lines at two
   * different times is not the double-render defect of DESIGN.md 6.0.21, which
   * was one line landing on two surfaces at once.
   */
  const runEditorCommand = useCallback(
    (command: EditorCommand) => {
      const slow = command.tool === "export_project";
      if (slow) speakLineRef.current(command.spoken, "verbatim");
      showToast(command.spoken);

      void import("../../video/mcp/toolRegistry")
        .then(({ executeTool }) => executeTool(command.tool, command.args, "Temi (voice)"))
        .then((result) => {
          const line = describeEditorResult(command, result);
          // A slow command has already said what it was doing; saying it again
          // on success would be the same sentence twice.
          if (!slow || !result.success || line !== command.spoken) {
            speakLineRef.current(line, "verbatim");
          }
        })
        .catch((error: unknown) => {
          /* The import itself failing means this build has no editor in it —
             a different thing from the editor refusing, and worth saying so
             rather than reporting a tool error the operator cannot act on. */
          const reason = error instanceof Error ? error.message : String(error);
          speakLineRef.current(`I could not reach the editor: ${reason}`, "verbatim");
        });
    },
    [showToast],
  );

  // ── One switch for everything the operator says (spoken or typed) ────────
  //
  // `routeVoiceTurn` decides; this performs. The split is deliberate: the
  // decision is pure and tested, and everything socket-shaped lives here.
  const performVoiceTurn = useCallback(
    (text: string, source: TurnSource) => {
      const clean = text.trim();
      if (!clean) return;

      /* ── The rest of the sentence ─────────────────────────────────────────
         Every parser below matches on a fragment and the stage returns the
         moment one of them recognises something, so "open the DukaBot folder
         and run the tests" opened the folder and threw the tests away without
         a word. The clause was not misheard and not refused; it was never
         looked at.

         The proof that a tail was ignored is that the head parses, alone, to
         exactly what the whole sentence parsed to: the parser reached its
         verdict without reading past the seam. Anything else and the split is
         a guess, so the turn is left whole and behaves as it always did.
         Conversation never comes through here at all, because the router is
         handed the whole utterance and the model reads both clauses itself.

         `JSON.stringify` is the comparison because these verdicts are flat
         records built at one site each, so two equal ones serialise the same
         way, and neither module exports an equality this can borrow. */
      const tailIgnoredBy = <T,>(parse: (clause: string) => T, whole: T): string | null => {
        const split = splitTrailingClause(clean);
        if (!split) return null;
        return JSON.stringify(parse(split.head)) === JSON.stringify(whole) ? split.tail : null;
      };
      /* Not `spoken`, whatever the tail came from: the model already heard it
         inside the sentence, and the barge-in that silenced her fired when the
         first clause was acted on. */
      const performTail = (tail: string | null) => {
        if (tail) performTurnRef.current?.(tail, source === "typed" ? "typed" : "clause");
      };

      /* ── The transport, before anything else at all ───────────────────────
         "pause" is in STOP_PHRASES. So is "wait", so is "hold on". With a video
         playing and an agent running, "pause" reached `routeVoiceTurn`, was
         classified as a stop, and cancelled the RUN while the video carried on
         playing — the operator lost minutes of work and the thing they actually
         asked for did not happen. The ordering is the fix, and it is first
         because every other path here has a claim on those words: the router's
         stop set, the workspace parser's "go to", the editor's "pause it".

         `handleSpokenPlayerCommand` refuses by returning `{ handled: false }`
         when no media pane is live, so on every screen without a player this
         costs one synchronous call and changes nothing. */
      const player = handleSpokenPlayerCommand(clean);
      if (player.handled) {
        if (source === "spoken") {
          protocolRef.current?.sendBargeIn();
          audioRef.current?.stopTTSPlayback();
        }
        if (player.reply) speakLineRef.current(player.reply, "verbatim");
        showToast(player.reply || player.action || "Done");
        return;
      }

      /* ── A standing permission prompt gets first refusal on the words ─────
         "yes" while the assistant is blocked on "Claude Code wants to run npm
         test" is an answer to that, not a new instruction and not praise.
         `classifyApprovalReply` draws the line narrowly: anything that is not
         plainly an answer travels on with the prompt still standing. */
      if (spokenApproval.consume(clean)) {
        if (source === "spoken") {
          protocolRef.current?.sendBargeIn();
          audioRef.current?.stopTTSPlayback();
        }
        /* Said back. The hook says it too, but only through a `UseVoiceResult`,
           and this stage's voice is the socket — an operator who answers a
           machine and hears nothing says it again, louder. */
        const verdict = classifyApprovalReply(clean);
        speakLineRef.current(
          verdict === "deny" ? "Refused." : verdict === "allow-always" ? "Allowed, and I won't ask again." : "Allowed.",
          "verbatim",
        );
        return;
      }

      // Read the store rather than the render's closure: this runs from a
      // WebSocket callback that was installed once and would otherwise see the
      // run as it looked when the socket opened.
      const activity = useAssistantActivityStore.getState();
      const busy = activity.isTaskRunning;

      /* ── The workspace fast path, ahead of the router ──────────────────────
         Naming a project he already has is a name lookup, not a job. The slow
         path still exists and is still correct — `machineAction.ts` files this
         under `workspace` and the assistant opens it — but that is a delegate,
         a prompt, a tool call and a report for a decision about four sibling
         directories. This is ahead of `routeVoiceTurn` for the same reason
         `mute` is: the router would file "switch to DukaBot" as conversation
         and answer it with talk.

         It resolves or it returns null; `parseWorkspaceCommand` under-matches
         on purpose, so a name it will not swear to falls through to the two
         paths that were already here rather than opening a guess.

         THE `!busy` GATE IS LOAD BEARING, and it is a measured hazard rather
         than caution. `openProject` rebinds the workspace root that every
         workspace and terminal route resolves against (`workspaceService.ts`),
         and an agent run in flight resolves its relative paths against that
         same root — so switching mid-run sends the run's next Edit or Write
         into a DIFFERENT REPOSITORY. A silent wrong-file write is the most
         expensive failure on this lane. `reveal-folder` is genuinely safe
         mid-run, since it only touches `expandedPaths` and `revealTarget`, but
         one gate is easier to keep right than two and mid-run the assistant
         answers instead. */
      const store = useStudioStore.getState();
      const workspaceOptions = {
        candidates: workspaceCandidatesRef.current,
        /* Only when the gateway has confirmed it. The initial `workspacePath`
           is a hardcoded guess (`studioStore.ts`), and an unconfirmed root must
           not get to decide that a folder is "local" — that turns a switch into
           a reveal against a root we are not actually bound to. */
        workspacePath: store.workspaceRootConfirmed ? store.workspacePath : undefined,
      };
      const workspaceAction = parseWorkspaceCommand(clean, workspaceOptions);

      /* The line that tells a turn the parser refused apart from one the gate
         held: both end in silence and they need opposite fixes. */
      traceVoice("turn", {
        source,
        busy,
        workspace: workspaceAction ? workspaceAction.kind : null,
        candidates: workspaceCandidatesRef.current.length,
      });

      if (workspaceAction && !busy) {
        // She is mid-sentence and the model is already answering the spoken
        // turn. Cut both, exactly as the delegate path does.
        if (source === "spoken") {
          protocolRef.current?.sendBargeIn();
          audioRef.current?.stopTTSPlayback();
        }

        const workspaceTail = tailIgnoredBy(
          (clause) => parseWorkspaceCommand(clause, workspaceOptions),
          workspaceAction,
        );

        if (workspaceAction.kind === "reveal-folder") {
          /* `relativePath`, not `path`: `revealPath` keys the open set by
             workspace-relative path, so an absolute one opens nothing. */
          store.revealPath(workspaceAction.relativePath);
          const name = workspaceAction.relativePath.split("/").filter(Boolean).pop() ?? "it";
          speakLineRef.current(`Opening ${name} in the tree.`, "verbatim");
          showToast(`Revealed ${workspaceAction.relativePath}`);
          // Nothing about the root moved, so the rest of the sentence can be
          // acted on where it was said.
          performTail(workspaceTail);
          return;
        }

        if (workspaceAction.path === store.workspacePath) {
          /* Already there. Not merely redundant: `setWorkspacePath` collapses
             every open folder, clears the reveal target and restamps the active
             chat session onto the root, so re-applying the root the shell is
             already bound to would throw away the operator's open tree to
             arrive where he is. */
          speakLineRef.current(`We're already in ${workspaceAction.label}.`, "verbatim");
          performTail(workspaceTail);
          return;
        }

        const target = workspaceAction.label;
        showToast(`Opening ${target}…`);
        void WorkspaceService.openProject(workspaceAction.path)
          .then((projects) => {
            /* The gateway's confirmed path, never the parsed one. The gateway
               owns which root the routes read; passing the path we guessed
               would stamp a guess into the store as a confirmed fact. */
            useStudioStore.getState().setWorkspacePath(projects.current.path);
            absorbProjects(projects);
            speakLineRef.current(`Switched to ${projects.current.name || target}.`, "verbatim");
            /* Here and not before the switch, which is the whole difficulty
               with "open the DukaBot folder and run the tests": the tests are
               meant to be DukaBot's. Handing the clause to the assistant while
               the old root is still bound would run it against the repository
               he just asked to leave, and he would be reading a green suite
               from the wrong project. */
            performTail(workspaceTail);
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            /* The tail is dropped here rather than run, because the root it
               was meant for is not the root we are standing in. Dropped out
               loud, though: this lane's rule is that a refusal he cannot hear
               is indistinguishable from a command that was never heard. */
            speakLineRef.current(
              workspaceTail
                ? `I could not open ${target}: ${reason} I've left the rest of that alone.`
                : `I could not open ${target}: ${reason}`,
              "verbatim",
            );
          });
        return;
      }

      /* Named a folder while a run is in flight.
         The gate above is right to refuse -- see its note, a switch mid-run
         sends the run's next Edit into a different repository -- but refusing
         in SILENCE is most of why this lane looked broken. He says "switch to
         DukaBot", nothing happens, and a refusal he agrees with is
         indistinguishable from a command that was never heard. One of those
         needs him to wait and the other needs him to say it again.

         So the turn is answered here rather than falling through to the
         assistant, which would answer a workspace command with talk. */
      if (workspaceAction) {
        const held =
          workspaceAction.kind === "reveal-folder"
            ? (workspaceAction.relativePath.split("/").filter(Boolean).pop() ?? "it")
            : workspaceAction.label;
        if (source === "spoken") {
          protocolRef.current?.sendBargeIn();
          audioRef.current?.stopTTSPlayback();
        }
        /* Says only what is true. There is NO QUEUE: `busy` is read once, here,
           and nothing re-issues the action later. An earlier draft of this line
           said "I'll switch once this run finishes", which promised a mechanism
           that does not exist -- the same fabrication failure the report path is
           built to refuse, arriving through a line of UI copy. Deferring the
           switch would also be its own hazard: a run can end minutes later, by
           which time an unannounced root change is the silent wrong switch the
           gate exists to prevent. So it refuses, out loud, and he decides. */
        const verb = workspaceAction.kind === "reveal-folder" ? "open" : "switch to";
        speakLineRef.current(
          `I can't ${verb} ${held} while this run is going. Tell me again when it's done.`,
          "verbatim",
        );
        showToast(`Refused: a run is in flight. Say it again when it finishes.`);
        return;
      }

      /* ── The video editor fast path, ahead of the router ───────────────────
         An operator looking at the timeline saying "cut here" wants an edit,
         not a conversation about an edit. In an earlier build this was a full
         agent delegate — a 10s LLM round trip, a prompt, a tool call and a
         tool call — so "cut here", spoken aloud, arrived as conversation and
         was answered with a sentence about cutting. This is the link.

         `parseEditorCommand` refuses far more than it accepts; null here means
         the turn carries on to the assistant exactly as it did before.

         THIS ONE IS NOT GATED ON `!busy`, and the difference from the workspace
         block above is the point rather than an oversight. A workspace switch
         redirects an in-flight run's writes into another repository, silently.
         An edit does not: it lands on the timeline in front of the operator,
         who asked for it while watching, and hands-free control that switches
         itself off whenever an agent is working is control he does not have
         when he most wants it. `export_project` is the one heavy verb, and the
         pipeline's own `canExport` is a better judge of whether it can run than
         a flag about some unrelated agent.

         The registry is reached by dynamic import on purpose. `toolRegistry`
         pulls the ffmpeg and caption surfaces behind it, and a static import
         here would drag all of it into the chunk this stage ships in, on a
         screen that usually never touches the editor at all. */
      const editorCommand = editorLaneOpen() ? parseEditorCommand(clean) : null;
      if (editorCommand) {
        if (source === "spoken") {
          protocolRef.current?.sendBargeIn();
          audioRef.current?.stopTTSPlayback();
        }
        runEditorCommand(editorCommand);
        /* Unlike the switch above, an edit binds nothing the next clause has
           to resolve against, so "cut here and delete that" does not have to
           wait for the cut to land before the delete is read. */
        performTail(tailIgnoredBy(parseEditorCommand, editorCommand));
        return;
      }

      /* ── Universal Fast-Path Action Chain (Single & Compound) ─────────────
         Universal sub-second execution across system telemetry, accessibility,
         video editor mutations, and chained compound tasks ("and", "then").
         Guarantees < 50ms per step, 0 model tokens, and atomic execution. */
      const chainSteps = decomposeCompoundUtterance(clean);
      if (chainSteps && chainSteps.length > 0) {
        if (source === "spoken") {
          protocolRef.current?.sendBargeIn();
        }
        audioRef.current?.stopTTSPlayback();

        void (async () => {
          try {
            const result = await executeActionChain(clean, {
              executeEditorTool: async (tool, args) => {
                const mod = await import("../../video/mcp/toolRegistry");
                return mod.executeTool(tool, args, "Temi (voice)");
              },
            });
            if (result && result.handled) {
              lastSpokenRef.current = result.spoken;
              TeminaliAgentBridge.recordReport(result.spoken);
              speakLineRef.current(result.spoken, "verbatim");
              showToast(result.spoken);
            }
          } catch {
            speakLineRef.current("I couldn't complete that task right now.", "verbatim");
          }
        })();
        return;
      }

      const decision = routeVoiceTurn(clean, {
        busy,
        speaking: isSpeakingRef.current,
        run: busy
          ? runProgressFromActivity(activity.items, {
              engine: activity.activeEngine,
              lastText: activity.latestProgress,
            })
          : null,
        lastSpoken: lastSpokenRef.current,
      });

      const protocol = protocolRef.current;

      /* ── "yes" is two different sentences ────────────────────────────────
         `acknowledge` covers both and the switch used to discard both.

         One is a backchannel: "mhm", "yeah", "right", said over her while she
         is still talking, which is what a person does to show they are still
         listening. It was being treated as a barge-in — her sentence was cut
         dead by `suppressPipelineAnswer` and then `case "acknowledge"` was a
         bare `break`, so nothing replaced it. The operator agreed with her and
         she stopped mid-word.

         The other is an ANSWER. She asked "should I run the tests?", he said
         "yes", and the same path filed it as praise and dropped it: the thing
         she offered to do was never done and nothing said so. That one has to
         reach the model, which is the only thing that knows what it offered —
         so it is re-routed to `converse`, and for a spoken turn `converse` means
         exactly "let her own answer through", which is why the barge-in must not
         fire on it either.

         The window is `addressing.ts`'s, deliberately the same one: a "yes"
         inside it is the answer to the question, and the same word after it has
         closed is praise for work that has since finished. */
      const answeringHerQuestion =
        decision.action.kind === "acknowledge" &&
        assistantAskedQuestionRef.current &&
        Date.now() - assistantTurnEndedAtRef.current < FOLLOW_UP_WINDOW_MS;
      if (answeringHerQuestion) assistantAskedQuestionRef.current = false;
      const backchannel = decision.action.kind === "acknowledge" && isSpeakingRef.current;

      // A spoken turn is already being answered by the model — it begins
      // generating the moment its own VAD closes the turn. A typed one is not.
      if (source === "spoken" && decision.suppressPipelineAnswer && !answeringHerQuestion && !backchannel) {
        protocol?.sendBargeIn();
        audioRef.current?.stopTTSPlayback();
      }

      const action = answeringHerQuestion ? ({ kind: "converse" } as const) : decision.action;
      switch (action.kind) {
        case "delegate": {
          showToast("Handing this to the assistant…");
          delegationsInFlightRef.current += 1;
          // Temi says one grounded line, and the model's own reply is
          // suppressed above. Asking the persona to improvise the "on it" is
          // what produced invented accounts of work that had not started:
          // a prompt to acknowledge an action it cannot observe gets answered
          // by describing the action. See `machineAction.ts`.
          if (decision.speak) speakLineRef.current(decision.speak, "verbatim");
          const options: TaskDelegationOptions = {
            // The kind travels with the prompt so the closing line knows
            // whether it is reporting work or answering a question.
            action: action.action,
            approveCommand: approveRef.current.approveCommand,
            onProgress: (summary) => narrateProgressRef.current?.(summary),
            onCompleted: (finalReport) => {
              /* One surface, and the report is answered from rather than read
                 out. This used to append the report to the transcript AND send
                 it to be spoken, which is what put one answer on screen
                 twice. */
              pendingReportSpeechRef.current = true;
              reportBaseSamplesRef.current = captureTotalSamplesRef.current;
              speakLineRef.current(finalReport, "report");
              setTimeout(() => {
                pendingReportSpeechRef.current = false;
              }, 7000);
            },
          };
          void TeminaliAgentBridge.delegateTask(action.prompt, options)
            .catch((error: unknown) => {
              // Told, not swallowed, and for the same reason as the tool_call
              // path: a run that reports nothing leaves the operator holding a
              // question she has already promised to answer.
              const reason = error instanceof Error ? error.message : String(error);
              speakLineRef.current(`That could not be completed: ${reason}`, "verbatim");
            })
            .finally(() => {
              delegationsInFlightRef.current = Math.max(0, delegationsInFlightRef.current - 1);
            });
          break;
        }

        case "answer":
        case "repeat":
          // Answered here, from the run. The model never sees the question,
          // because its persona prompt has never heard of the work in flight.
          // One surface, as everywhere else on this switch.
          speakLineRef.current(action.text, "verbatim");
          break;

        case "stop":
          TeminaliAgentBridge.stopCurrentTask();
          showToast("Stopped");
          if (decision.speak) speakLineRef.current(decision.speak, "verbatim");
          break;

        case "hush":
          // The voice stops; the work does not. Conflating the two once cost a
          // build to a request for quiet — see §6.8.
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          audioRef.current?.stopTTSPlayback();
          break;

        case "mute": {
          /* Stronger than `hush`, and in the other direction too: the ears
             close as well as the mouth, and nothing reopens them until she is
             asked to. The run itself is untouched, exactly as with `hush`, for
             the reason §6.8 gives.

             The order is not the obvious one. Whatever she is mid-sentence on
             is killed first, then the confirmation goes out, and only then does
             the mute land. Muting does not silence playback -- `isMuted` gates
             the capture path alone, at `voiceAudioEngine.ts:102` -- so the last
             line still reaches the operator. Nothing below this may clear the
             TTS buffer again or that confirmation is dropped before it arrives.

             `audio.isMuted` rather than the `isMicMuted` state, because this
             callback is stored in `performTurnRef` and installed once, so the
             render closure's copy of the state is stale. */
          const audio = audioRef.current;
          audio?.stopTTSPlayback();
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          if (decision.speak) speakLineRef.current(decision.speak, "verbatim");
          if (audio?.audioContext && !audio.isMuted) audio.toggleMute();
          setIsMicMuted(true);
          showToast("Voice off — type instead");
          break;
        }

        case "unmute": {
          /* Reachable by typing, and by typing only. `flushBatch` drops the
             captured batch while `isMuted` is set, so a spoken "unmute" never
             reaches the socket, never comes back as a transcript, and never
             reaches this router at all. That is why the mute confirmation names
             the way back rather than just agreeing. The composer, the mic
             toggle and the orb are the three doors that work. */
          const audio = audioRef.current;
          if (audio?.audioContext && audio.isMuted) audio.toggleMute();
          setIsMicMuted(false);
          if (decision.speak) speakLineRef.current(decision.speak, "verbatim");
          showToast("Voice on — just speak");
          break;
        }

        case "acknowledge":
          /* Praise, or a backchannel over the top of her. The right reply to
             both is to keep working — and, when she is mid-sentence, to keep
             TALKING, which is what the `backchannel` test above protects. A
             "yes" that was an answer never arrives here: it was re-routed to
             `converse` before the switch. */
          break;

        case "converse":
        default:
          if (source === "typed") protocol?.sendUserText(clean);
          break;
      }
    },
    [absorbProjects, editorLaneOpen, runEditorCommand, showToast, spokenApproval]
  );

  useEffect(() => {
    performTurnRef.current = performVoiceTurn;
  }, [performVoiceTurn]);

  // Typed input joins the spoken path at the same switch, so the composer and
  // the microphone cannot drift apart. This is the whole of what makes muting
  // a mode rather than a second screen.
  const handleUserUtterance = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      audioRef.current?.stopTTSPlayback();
      setLiveAssistantStream(null);
      setLiveUserSpeech(null);
      uncommittedUserSpeechRef.current = null;
      setDialogueHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "user" && last.content.trim() === clean) return prev;
        return [...prev, { id: `user-${Date.now()}`, role: "user", content: clean }];
      });
      rememberTurn("user", clean);
      performVoiceTurn(clean, "typed");
    },
    [performVoiceTurn]
  );

  // ── Ensure AudioContext & Mic are started upon user gesture ──────────────
  const ensureAudioStarted = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || audio.audioContext) return true;
    try {
      await audio.start();
      setIsAudioStarted(true);
      setIsMicMuted(false);
      return true;
    } catch (e) {
      console.error("Audio engine failed to start:", e);
      showToast("Allow microphone access in System Settings to speak");
      return false;
    }
  }, [showToast]);

  // ── Orb Click: hush if she is talking, otherwise open the mic ────────────
  const handleOrbClick = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio?.audioContext) {
      if (await ensureAudioStarted()) showToast("Listening");
      return;
    }
    if (audio.isTTSPlaying) {
      /* Talking over her is a HUSH. It used to call `stopCurrentTask` as well,
         which killed the delegated run — the exact conflation §6.8 forbids, and
         the most expensive version of it, because the gesture that means "I've
         heard enough, carry on" was the gesture that threw the work away. The
         voice stops; the work does not. Stop is the composer's Stop button and
         the Escape key, both of which say so. */
      audio.stopTTSPlayback();
      protocolRef.current?.sendTTSStop();
      setIsSpeaking(false);
      isSpeakingRef.current = false;
      showToast("Quiet — the work carries on");
      return;
    }
    /* "Tap the orb when you want me back."

       That is the promise `MUTE_ACKNOWLEDGEMENT` makes out loud, and this is
       where it was broken: muted and quiet, every branch above fell through and
       the tap did nothing at all. The one door the mute line names was the one
       door that was not there. */
    if (audio.isMuted) {
      const muted = audio.toggleMute();
      setIsMicMuted(muted);
      showToast(muted ? "Voice off — type instead" : "Voice on — just speak");
    }
  }, [ensureAudioStarted, showToast]);

  // ── The mode switch ─────────────────────────────────────────────────────
  // Muted is not a disabled microphone next to a disabled screen; it is the
  // text mode. Same transcript, same composer, same switch underneath.
  const handleToggleMic = useCallback(async () => {
    if (!audioRef.current?.audioContext) {
      if (await ensureAudioStarted()) showToast("Voice on — just speak");
      return;
    }
    const muted = audioRef.current.toggleMute();
    setIsMicMuted(muted);
    if (muted) audioRef.current.stopTTSPlayback();
    showToast(muted ? "Voice off — type instead" : "Voice on — just speak");
  }, [ensureAudioStarted, showToast]);

  /* ── Stopping ────────────────────────────────────────────────────────────
     One function behind the composer's Stop button and the Escape key, so the
     two cannot drift. It stops the voice as well as the work: a run stopped
     while she is mid-sentence should not go on narrating it.

     `onStop` is the parent's lane and is called too — the stage is now the only
     owner of Escape for this column, so nothing else will stop that run. */
  const handleStopRun = useCallback(() => {
    audioRef.current?.stopTTSPlayback();
    protocolRef.current?.sendTTSStop();
    // She was stopped mid-sentence: the transcript keeps what was said.
    commitSpokenTurnRef.current?.(true);
    TeminaliAgentBridge.stopCurrentTask();
    setIsSpeaking(false);
    isSpeakingRef.current = false;
    onStop?.();
    showToast("Stopped");
  }, [onStop, showToast]);

  useInterruptKey(isRunning, stageRef, handleStopRun);

  /* ── Up-arrow prompt history ─────────────────────────────────────────────
     A ref, not state: nothing renders from it, and the composer is remounted
     when the empty screen becomes a conversation — state there would be emptied
     by the first prompt sent. The ring itself is in `utils/promptHistory.ts`. */
  const historyRef = useRef<PromptHistory>(EMPTY_HISTORY);
  const navigateHistory = useCallback(
    (direction: "older" | "newer", current: string): string | null => {
      const step = direction === "older" ? older(historyRef.current, current) : newer(historyRef.current);
      if (!step) return null;
      historyRef.current = step.history;
      setInputText(step.value);
      return step.value;
    },
    [],
  );
  // Typing is how you leave the ring; there is no other exit and no mode to end.
  const handleComposerChange = useCallback((next: string) => {
    historyRef.current = stopBrowsing(historyRef.current);
    setInputText(next);
  }, []);

  // ── Composer Enter / Send Text ──────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    historyRef.current = remember(historyRef.current, text);
    setInputText("");
    pinnedToBottomRef.current = true;
    // Typing must never wait on a microphone permission prompt: the whole
    // point of one surface is that text works before voice does.
    handleUserUtterance(text);
  }, [inputText, handleUserUtterance]);

  // ── Leave the voice session; the conversation stays ─────────────────────
  const handleEndVoice = useCallback(() => {
    audioRef.current?.stopTTSPlayback();
    if (audioRef.current?.audioContext && !isMicMuted) audioRef.current.toggleMute();
    TeminaliAgentBridge.stopCurrentTask();
    setIsMicMuted(true);
    setLiveUserSpeech(null);
    setLiveAssistantStream(null);
    setIsSpeaking(false);
    isSpeakingRef.current = false;
    showToast("Voice off — type instead");
  }, [isMicMuted, showToast]);

  // ── Start over: clears the conversation here, and the live session too ───
  const handleCreateNew = useCallback(() => {
    audioRef.current?.stopTTSPlayback();
    TeminaliAgentBridge.stopCurrentTask();
    protocolRef.current?.sendClearHistory();
    /* A real new chat, not a blanked transcript. Clearing in place used to
       destroy the conversation you were in — there was only ever one. */
    newChatSession();
    setLiveUserSpeech(null);
    setLiveAssistantStream(null);
    setIsSpeaking(false);
    isSpeakingRef.current = false;
    lastSpokenRef.current = null;
    pinnedToBottomRef.current = true;
    showToast("New conversation");
  }, [newChatSession, showToast]);

  const handleRepeat = useCallback((text: string) => {
    speakLineRef.current(text, "verbatim");
  }, []);

  const isHearing = Boolean(liveUserSpeech) || (!isMicMuted && userEnergy > 0.04);
  const isThinking = Boolean(liveAssistantStream) && !isSpeaking;
  const isVoiceOn = isAudioStarted && !isMicMuted;

  const statusTone = !isWsConnected
    ? voiceNote.text
      ? "bg-rose-500"
      : "bg-amber-400"
    : isSpeaking
      ? "bg-[#00bf63] shadow-[0_0_10px_#00bf63]"
      : isHearing
        ? "bg-emerald-300 shadow-[0_0_10px_#6ee7b7]"
        : isThinking
          ? "bg-teal-400 shadow-[0_0_10px_#2dd4bf] animate-pulse"
          : "bg-[#00994f]";

  const statusTitle = !isWsConnected
    ? voiceNote.text || "Connecting Temi's voice…"
    : isSpeaking
      ? "Temi is speaking"
      : isHearing
        ? "Listening"
        : isThinking
          ? "Thinking"
          : "Voice is live";

  const closePopovers = useCallback(() => {
    setMenuOpen(false);
    setSettingsOpen(false);
  }, []);

  /* The orb and the composer are drawn once and placed twice: centred on the
     landing screen the way Cursor centres its box, docked to the bottom once
     there is a conversation to sit under. Two copies of this markup drifted
     apart the last time a surface had two layouts. */
  /* The orb alone. The process line used to hang under it as a floating pill
     and now rides in the composer's project tab, after the project name —
     `TemiComposer`'s `activity` slot. One strip saying where the work is and
     what it is doing beats two objects stacked over the box, and it gives the
     transcript back the row the pill was renting. */
  const presence = (
    <>
      <div className="pointer-events-auto">
        <TemiCanvasOrb
          size={80}
          getAudioState={() => ({
            userEnergy: audioRef.current?.getUserEnergy() ?? 0,
            assistantEnergy: audioRef.current?.getAssistantEnergy() ?? 0,
            isTTSPlaying: isSpeaking,
          })}
          isTTSPlaying={isSpeaking}
          isHearing={isHearing}
          isThinking={isThinking}
          onClick={handleOrbClick}
        />
      </div>
    </>
  );

  const composer = (
    <TemiComposer
      className={COLUMN}
      value={inputText}
      onChange={handleComposerChange}
      onSubmit={handleSubmit}
      isRunning={isRunning}
      onStop={handleStopRun}
      onNavigateHistory={navigateHistory}
      projectLabel={projectLabel}
      onChooseProject={() =>
        onOpenWorkspace ? onOpenWorkspace() : showToast("Open a workspace to choose a project")
      }
      /* The whole of the Teminali OS assistant's visible presence. Silent when
         there is nothing running; opens the full log when there is. */
      activity={<ConnectedAgentActivity onClick={() => setActivityOpen(true)} />}
      permissionLabel={permissionLabel}
      engineHead={engine.head}
      engineTail={engine.tail}
      engineTitle={`${engineLabel} does the work when Temi hands something over`}
      voiceOn={isVoiceOn}
      onToggleMic={() => void handleToggleMic()}
      onEndVoice={handleEndVoice}
      voiceLive={isAudioStarted}
      placeholder={isVoiceOn ? "Do anything — or just speak" : "Do anything"}
    />
  );

  return (
    <div
      ref={stageRef}
      className={`relative flex h-full flex-1 flex-col overflow-hidden bg-black text-[#ececec] select-text ${className}`}
    >
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="relative z-40 flex h-14 flex-shrink-0 items-center px-5">
        <h1 className="text-[17px] font-semibold tracking-tight text-white">
          Teminali <span className="font-normal text-[#b4b4b4]">Voice</span>
        </h1>

        {/* The live dot sits at the right edge of the message column, not at the
            edge of the window — it belongs to the conversation, not the chrome. */}
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <div className={`${COLUMN} flex justify-end px-5`}>
            <span
              title={statusTitle}
              aria-label={statusTitle}
              className={`h-2.5 w-2.5 rounded-full transition-all duration-300 ${statusTone}`}
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(false);
                setMenuOpen((previous) => !previous);
              }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-[#c9c9c9] transition-colors hover:bg-[#212121] hover:text-white"
              title="In this chat"
            >
              <SquarePlus size={20} strokeWidth={1.8} />
            </button>
            {menuOpen && (
              <TemiChatMenu
                onClose={() => setMenuOpen(false)}
                onCreateNew={handleCreateNew}
                onOpenWorkspace={onOpenWorkspace}
                onConnectGitHub={onConnectGitHub}
              />
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen((previous) => !previous);
              }}
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-[#c9c9c9] transition-colors hover:bg-[#212121] hover:text-white"
              title="Voice settings"
            >
              <SlidersHorizontal size={20} strokeWidth={1.8} />
            </button>
            {settingsOpen && (
              <TemiStageSettings
                onClose={() => setSettingsOpen(false)}
                machineLabel={machineLabel}
                onSelectVoice={(voiceKey) => {
                  protocolRef.current?.sendVoiceChange(voiceKey);
                  showToast("Voice updated");
                }}
              />
            )}
          </div>
        </div>
      </header>

      {/* ── What is wrong, where it can be seen ───────────────────────────
          `voiceNote` had exactly one surface: the `title` of a 2.5px dot. That
          is invisible on a screen recording, invisible to anyone who does not
          already suspect the dot means something, and unreachable by keyboard —
          so "voice is dead and there is no key" and "voice is dead and the
          gateway is down" looked identical, which is two different next steps
          behind one blank screen. A failure the operator can act on is written
          out in words. The dot stays; it is now the summary, not the record. */}
      {(voiceNote.text || storeApprovalPending || approvalPending) && (
        <div className="relative z-40 flex flex-shrink-0 flex-col items-center gap-2 px-5 pb-2">
          {voiceNote.text && (
            <div
              role="status"
              aria-live="polite"
              className={`${COLUMN} flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-[12.5px] leading-snug text-rose-100`}
            >
              <span className="flex-1">{voiceNote.text}</span>
              {/* The sentence named the fix and then left him to find it. The
                  key field is a modal two clicks away through a settings page
                  called "Local Models & Weights", which is not a place anybody
                  guesses from the word "key", so the banner opens it. First in
                  the row and filled rather than bare, because it is the thing
                  to do and Dismiss is the thing to do instead; first in the DOM
                  too, so a keyboard reaches the fix before the escape from it.
                  Only rendered behind a remedy: a button on "the gateway is not
                  running" would open a field that changes nothing, which is
                  worse than no button at all. */}
              {voiceNote.remedy === "gemini-key" && (
                <button
                  type="button"
                  onClick={() => setGeminiKeyModalOpen(true)}
                  className="flex-shrink-0 rounded-md bg-rose-500/25 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-rose-500/40"
                >
                  Add key
                </button>
              )}
              <button
                type="button"
                onClick={() => setVoiceNote(NO_VOICE_NOTE)}
                className="flex-shrink-0 rounded-md px-2 py-0.5 text-[11px] text-rose-200/80 transition-colors hover:bg-rose-500/20 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          )}
          {/* Spoken approval prompt: elevated glassmorphic card for both voice and hands-on interaction */}
          {storeApprovalPending ? (
            <div className={`${COLUMN} w-full max-w-2xl px-1 py-1`}>
              <SpokenApprovalPrompt pending={storeApprovalPending} />
            </div>
          ) : approvalPending && (
            <div
              role="group"
              aria-label="Permission request"
              className={`${COLUMN} flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3.5 py-2 text-[12.5px] text-amber-100`}
            >
              <span className="min-w-[160px] flex-1">
                <span className="block text-[11px] text-amber-200/80">{approvalPending.reason}</span>
                <span className="block max-h-24 overflow-y-auto break-all font-mono text-[11.5px] text-white">{approvalPending.command}</span>
              </span>
              <button
                type="button"
                onClick={() => commandApproval.approve(false)}
                className="flex-shrink-0 rounded-md bg-amber-400/20 px-2.5 py-1 text-[11.5px] text-white transition-colors hover:bg-amber-400/35"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => commandApproval.approve(true)}
                className="flex-shrink-0 rounded-md px-2.5 py-1 text-[11.5px] text-amber-100/90 transition-colors hover:bg-amber-400/20 hover:text-white"
                title={`Stop asking about ${commandHead(approvalPending.command)}`}
              >
                Always
              </button>
              <button
                type="button"
                onClick={() => commandApproval.deny()}
                className="flex-shrink-0 rounded-md px-2.5 py-1 text-[11.5px] text-amber-100/90 transition-colors hover:bg-amber-400/20 hover:text-white"
              >
                Refuse
              </button>
            </div>
          )}
        </div>
      )}

      {/* Click-away for the header popovers. Below them, above everything else. */}
      {(menuOpen || settingsOpen) && <div className="fixed inset-0 z-30" onClick={closePopovers} />}

      {isEmpty ? (
        /* The landing screen, laid out the way Cursor lays its empty chat out:
           the box centred on the canvas rather than pinned to the bottom, and
           the openers directly under it. The transcript is not drawn at all —
           there is one seeded greeting in it, and a welcome sentence stacked
           over a centred composer is the busyness this layout exists to avoid.
           It is not lost: it is the first thing in the conversation as soon as
           there is one. */
        <div className="relative z-30 flex flex-1 flex-col items-center justify-center px-5 pb-16">
          <div className="mb-8 flex flex-col items-center">{presence}</div>
          {composer}
          {/* Empty chat only. These are ways to start, and once the
              conversation exists, starting is over. */}
          <div className={`${COLUMN} mt-3`}>
            <TemiActionRow
              onDraft={setInputText}
              onConnectGitHub={onConnectGitHub}
              onOpenWorkspace={onOpenWorkspace}
            />
          </div>
        </div>
      ) : (
        <>
          {/* ── The conversation ─────────────────────────────────────────── */}
          <main
            ref={scrollRef}
            onScroll={handleTranscriptScroll}
            className="custom-scrollbar flex-1 overflow-y-auto transition-[margin-bottom] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{
              marginBottom: isPanelExpanded ? `${composerBottomOffset}px` : undefined,
            }}
          >
            {/* When collapsed, tail padding clears the floating orb & composer.
                When expanded, main pulls up right above the CLI streaming panel,
                keeping the last turn cleanly visible directly above the drawer edge. */}
            <div
              className="mx-auto flex w-full justify-center px-5 pt-6 transition-[padding-bottom] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{
                paddingBottom: isPanelExpanded ? "20px" : "300px",
              }}
            >
              <TemiTranscript
                turns={turns}
                onRepeat={handleRepeat}
                onCopied={() => showToast("Copied")}
                className={COLUMN}
              />
            </div>
          </main>

          {/* ── Temi's presence: the orb ───────────────────────────────── */}
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-[188px] z-20 flex flex-col items-center transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              isPanelExpanded ? "opacity-0 scale-90 pointer-events-none" : "opacity-100 scale-100"
            }`}
          >
            {presence}
          </div>

          {/* ── Composer ─────────────────────────────────────────────────── */}
          <div
            ref={composerContainerRef}
            className="absolute inset-x-0 bottom-6 z-30 flex justify-center px-5"
          >
            {composer}
          </div>
        </>
      )}

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toastMessage && (
        <div className="pointer-events-none fixed bottom-[104px] left-1/2 z-[60] -translate-x-1/2 rounded-full border border-[#3a3a3a] bg-[#2f2f2f]/95 px-3.5 py-1.5 text-[12px] text-[#f5f5f5] shadow-lg">
          {toastMessage}
        </div>
      )}
    </div>
  );
};
