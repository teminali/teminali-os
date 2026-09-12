import React, { useCallback, useEffect, useRef, useState } from "react";
import { SlidersHorizontal, SquarePlus } from "lucide-react";
import { TemiCanvasOrb } from "./TemiCanvasOrb";
import { TemiTranscript, type DialogueTurn } from "./TemiTranscript";
import { TemiActivityDialog } from "./TemiActivityDialog";
import { TemiChatMenu, TemiStageSettings } from "./TemiStagePanels";
import { TemiActionRow, TemiComposer } from "./TemiComposer";
import { ConnectedAgentActivity } from "./AgentActivityTicker";
import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import { PROFILES_LIST, useStudioStore } from "../../store/studioStore";
import { PERMISSION_LABELS } from "../chat/ModelPicker";
import { VoiceAudioEngine } from "../../services/voice/voiceAudioEngine";
import { GeminiLiveEngine } from "../../services/voice/geminiLiveEngine";
import { CaptionPacer } from "../../services/voice/captionPacer";
import { TeminaliAgentBridge } from "../../services/voice/teminaliAgentBridge";
import { routeVoiceTurn } from "../../services/voice/voiceTurnRouter";
import { runProgressFromActivity } from "../../services/voice/runProgressFromActivity";
import { dialogueFromMessages, messagesFromDialogue } from "../../utils/sessionDialogue";
import { EMPTY_HISTORY, newer, older, remember, stopBrowsing, type PromptHistory } from "../../utils/promptHistory";
import { useInterruptKey } from "../../hooks/useInterruptKey";
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

export const TemiVoiceStage: React.FC<TemiVoiceStageProps> = ({
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
  const [voiceNote, setVoiceNote] = useState("");
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
  const setActiveEngine = useAssistantActivityStore((state) => state.setActiveEngine);
  const logAction = useAssistantActivityStore((state) => state.logAction);

  const currentProfile = useStudioStore((state) => state.currentProfile);
  const agentSelection = useStudioStore((state) => state.agentSelection);
  // The engine that will do the work, named the way the chat composer names it.
  const engineLabel =
    agentSelection?.label ?? PROFILES_LIST.find((profile) => profile.id === currentProfile)?.name ?? "Frontier Auto";
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
  const captionCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Move the held reply into the transcript.

     `truncateToSpoken` is for a turn the operator cut off. What lands in the
     transcript is then what she actually said, not what she was going to say —
     a transcript that records words the speaker was silenced before reaching is
     a record of something that did not happen. */
  const commitSpokenTurn = useCallback((truncateToSpoken: boolean) => {
    if (captionCommitTimer.current) {
      clearTimeout(captionCommitTimer.current);
      captionCommitTimer.current = null;
    }
    const pacer = pacerRef.current;
    const pending = pendingFinalRef.current;
    assistantTurnActiveRef.current = false;
    if (!pending) {
      setLiveAssistantStream(null);
      return;
    }
    const spoken = truncateToSpoken
      ? pacer.advanceTo(secondsPlayedRef.current) || pending
      : pacer.revealAll();
    pacer.completeTurn(truncateToSpoken ? spoken : pending, secondsPlayedRef.current);
    pendingFinalRef.current = null;
    setDialogueHistory((prev) => [
      ...prev,
      { id: `asst-${Date.now()}`, role: "assistant", content: spoken },
    ]);
    setLiveAssistantStream(null);
  }, []);
  const commitSpokenTurnRef = useRef(commitSpokenTurn);
  commitSpokenTurnRef.current = commitSpokenTurn;
  const protocolRef = useRef<GeminiLiveEngine | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  // The socket effect runs once and must keep running once — putting the turn
  // handler in its dependency list would reopen the live session on every render.
  const performTurnRef = useRef<((text: string, source: "spoken" | "typed") => void) | null>(null);
  // What Temi last said, so "say that again" has something to say again.
  const lastSpokenRef = useRef<string | null>(null);
  const isSpeakingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the operator is reading the live end of the conversation. Scrolling
  // up to re-read something must not be yanked back by the next turn arriving.
  const pinnedToBottomRef = useRef(true);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2400);
  }, []);

  // ── The transcript is kept, not faded ────────────────────────────────────
  // Both modes scroll back over the whole conversation: muted, this is an
  // ordinary text chat and scrollback is the point; unmuted, it is the record
  // of what was actually heard, which is exactly what you reach for when a
  // spoken answer went past too quickly.
  const turns: DialogueTurn[] = React.useMemo(() => {
    const live: DialogueTurn[] = [];
    if (liveUserSpeech) {
      live.push({ id: "live-user", role: "user", content: liveUserSpeech, pending: true });
    }
    if (liveAssistantStream) {
      live.push({ id: "live-assistant", role: "assistant", content: liveAssistantStream, pending: true });
    }
    return live.length ? [...dialogueHistory, ...live] : dialogueHistory;
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

  // ── Initialize the Real 8000 AudioEngine & ProtocolManager ───────────────
  useEffect(() => {
    const audio = new VoiceAudioEngine();
    const protocol = new GeminiLiveEngine();

    audioRef.current = audio;
    protocolRef.current = protocol;

    audio.onAudioChunkReady = (buf) => protocol.sendAudioChunk(buf);
    audio.onTTSPlaybackStarted = () => {
      isSpeakingRef.current = true;
      setIsSpeaking(true);
      protocol.sendTTSStart();
    };
    audio.onTTSPlaybackStopped = () => {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      protocol.sendTTSStop();
      /* Debounced: the worklet reports "stopped" after 120ms of silence, which
         is the ordinary gap between two synthesised sentences as often as it is
         the end of the reply. Committing on the first one would cut the caption
         off mid-answer. */
      if (captionCommitTimer.current) clearTimeout(captionCommitTimer.current);
      captionCommitTimer.current = setTimeout(() => {
        if (!isSpeakingRef.current) commitSpokenTurnRef.current?.(false);
      }, 450);
    };

    audio.onTTSProgress = (seconds) => {
      secondsPlayedRef.current = seconds;
      const shown = pacerRef.current.advanceTo(seconds);
      setLiveAssistantStream(shown);
      const pending = pendingFinalRef.current;
      if (pending && shown.length >= pending.length) {
        // The voice has said everything that was generated: the turn is over.
        commitSpokenTurnRef.current?.(false);
      }
    };

    protocol.onConnected = () => {
      setIsWsConnected(true);
    };
    protocol.onDisconnected = () => {
      setIsWsConnected(false);
    };

    protocol.onMessage = (msg) => {
      const { type, content } = msg;

      // 1. Live Whisper Transcription
      if (type === "partial_user_request") {
        // Our own directive, mid-flight back to us -- not speech. Showing it
        // would caption the operator with words they never said.
        if (GeminiLiveEngine.isAssistantDirectiveEcho(content ?? "")) return;
        setLiveUserSpeech(content);
      } else if (type === "final_user_request") {
        setLiveUserSpeech(null);
        if (content) {
          const clean = content.trim();
          // A directive re-entering as a user turn must not be transcribed and
          // must not reach the switch: classified as work it delegates again,
          // and the loop never closes. See `isAssistantDirectiveEcho`.
          if (GeminiLiveEngine.isAssistantDirectiveEcho(clean)) return;
          // Update last user bubble if from this same turn, or append new turn
          setDialogueHistory((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "user") {
              return [...prev.slice(0, -1), { ...last, content: clean }];
            }
            return [...prev, { id: `user-${Date.now()}`, role: "user", content: clean }];
          });

          // Everything the operator says now goes through one switch. A status
          // question is answered from the live run, a stop lands on the run, and
          // only real work reaches the assistant.
          performTurnRef.current?.(clean, "spoken");
        }
      }

      // 2. Live Assistant Text Generation
      else if (type === "partial_assistant_answer") {
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          pacerRef.current.beginTurn();
          secondsPlayedRef.current = 0;
          audio.resetTTSProgress();
        }
        pacerRef.current.setText(content ?? "");
        setLiveAssistantStream(pacerRef.current.advanceTo(secondsPlayedRef.current));
      } else if (type === "final_assistant_answer") {
        if (content) {
          lastSpokenRef.current = content;
          /* Generation has finished; the voice has not. The reply is held here
             and committed by the speaker — either when the caption catches up
             with it, or when playback has been quiet long enough to mean the
             end of the turn rather than the gap between two sentences. */
          pendingFinalRef.current = content;
          pacerRef.current.setText(content);
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
      }

      // 4. Interruption / Barge-In Cut
      else if (type === "tts_interrupt") {
        audio.stopTTSPlayback();
        setIsSpeaking(false);
        commitSpokenTurnRef.current?.(true);
      }
    };

    /* The engine reaches Gemini Live directly and mints its own credential on
       the way: the gateway holds the API key and hands back a single-use
       ephemeral token, so the renderer never sees the key and the stage never
       learns an address. That is why `connect()` takes no argument any more,
       and why the operator's one-line note arrives through the engine rather
       than from a status call here -- a token is `uses: 1`, so a second fetch
       just to render a sentence would burn one. */
    let cancelled = false;
    protocol.onNote = (note) => {
      if (!cancelled) setVoiceNote(note);
    };
    void protocol.connect();

    // Continuous audio energy sampling for the 3D Orb
    const sampleEnergy = () => {
      setUserEnergy(audio.getUserEnergy());
      animFrameRef.current = requestAnimationFrame(sampleEnergy);
    };
    animFrameRef.current = requestAnimationFrame(sampleEnergy);

    return () => {
      cancelled = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      audio.cleanup();
      protocol.disconnect();
    };
  }, [logAction]);

  // ── One switch for everything the operator says (spoken or typed) ────────
  //
  // `routeVoiceTurn` decides; this performs. The split is deliberate: the
  // decision is pure and tested, and everything socket-shaped lives here.
  const performVoiceTurn = useCallback(
    (text: string, source: "spoken" | "typed") => {
      const clean = text.trim();
      if (!clean) return;

      // Read the store rather than the render's closure: this runs from a
      // WebSocket callback that was installed once and would otherwise see the
      // run as it looked when the socket opened.
      const activity = useAssistantActivityStore.getState();
      const busy = activity.isTaskRunning;
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
      // A spoken turn is already being answered by the model — it begins
      // generating the moment its own VAD closes the turn. A typed one is not.
      if (source === "spoken" && decision.suppressPipelineAnswer) {
        protocol?.sendBargeIn();
        audioRef.current?.stopTTSPlayback();
      }

      const action = decision.action;
      switch (action.kind) {
        case "delegate": {
          showToast("Handing this to the assistant…");
          // Temi says one grounded line, and the model's own reply is
          // suppressed above. Asking the persona to improvise the "on it" is
          // what produced invented accounts of work that had not started:
          // a prompt to acknowledge an action it cannot observe gets answered
          // by describing the action. See `machineAction.ts`.
          if (decision.speak) {
            setDialogueHistory((prev) => [
              ...prev,
              { id: `asst-${Date.now()}`, role: "assistant", content: decision.speak as string },
            ]);
            protocol?.sendAssistantDirective(decision.speak);
          }
          void TeminaliAgentBridge.delegateTask(action.prompt, {
            // The kind travels with the prompt so the closing line knows
            // whether it is reporting work or answering a question.
            action: action.action,
            onProgress: (summary) => showToast(summary),
            onCompleted: (finalReport) => {
              setDialogueHistory((prev) => [
                ...prev,
                { id: `asst-${Date.now()}`, role: "assistant", content: finalReport },
              ]);
              protocolRef.current?.sendAssistantDirective(finalReport);
            },
          });
          break;
        }

        case "answer":
        case "repeat":
          // Answered here, from the run. The model never sees the question,
          // because its persona prompt has never heard of the work in flight.
          setDialogueHistory((prev) => [
            ...prev,
            { id: `asst-${Date.now()}`, role: "assistant", content: action.text },
          ]);
          protocol?.sendAssistantDirective(action.text);
          break;

        case "stop":
          TeminaliAgentBridge.stopCurrentTask();
          showToast("Stopped");
          if (decision.speak) protocol?.sendAssistantDirective(decision.speak);
          break;

        case "hush":
          // The voice stops; the work does not. Conflating the two once cost a
          // build to a request for quiet — see §6.8.
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          audioRef.current?.stopTTSPlayback();
          break;

        case "acknowledge":
          // Praise. The right reply is to keep working.
          break;

        case "converse":
        default:
          if (source === "typed") protocol?.sendUserText(clean);
          break;
      }
    },
    [showToast]
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
      setDialogueHistory((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: clean },
      ]);
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

  // ── Orb Click: interrupt if she is talking, otherwise open the mic ───────
  const handleOrbClick = useCallback(async () => {
    if (!audioRef.current?.audioContext) {
      if (await ensureAudioStarted()) showToast("Listening");
      return;
    }
    if (audioRef.current.isTTSPlaying) {
      audioRef.current.stopTTSPlayback();
      protocolRef.current?.sendTTSStop();
      TeminaliAgentBridge.stopCurrentTask();
      setIsSpeaking(false);
      showToast("Interrupted");
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
    protocolRef.current?.sendAssistantDirective(text);
  }, []);

  const isHearing = Boolean(liveUserSpeech) || (!isMicMuted && userEnergy > 0.04);
  const isThinking = Boolean(liveAssistantStream) && !isSpeaking;
  const isVoiceOn = isAudioStarted && !isMicMuted;

  const statusTone = !isWsConnected
    ? voiceNote
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
    ? voiceNote || "Connecting Temi's voice…"
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
            className="custom-scrollbar flex-1 overflow-y-auto"
          >
            {/* The tail padding clears the floating orb and composer, so the
                last turn can always be scrolled fully into view above them. */}
            <div className="mx-auto flex w-full justify-center px-5 pb-[300px] pt-6">
              <TemiTranscript
                turns={turns}
                onRepeat={handleRepeat}
                onCopied={() => showToast("Copied")}
                className={COLUMN}
              />
            </div>
          </main>

          {/* ── Temi's presence: the orb ─────────────────────────────────
              172px was measured against a block that also held the process
              pill — 8px of margin and a ~24px pill. With the pill moved into
              the composer's project tab the block is the orb alone, so half of
              that 32px is given back as clearance (the orb must not sit on the
              box) and the other half is the compaction the move was for. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[188px] z-20 flex flex-col items-center">
            {presence}
          </div>

          {/* ── Composer ─────────────────────────────────────────────────── */}
          <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center px-5">{composer}</div>
        </>
      )}

      {/* ── The activity log, only when asked for ────────────────────────── */}
      <TemiActivityDialog open={isActivityOpen} onClose={() => setActivityOpen(false)} />

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toastMessage && (
        <div className="pointer-events-none fixed bottom-[104px] left-1/2 z-[60] -translate-x-1/2 rounded-full border border-[#3a3a3a] bg-[#2f2f2f]/95 px-3.5 py-1.5 text-[12px] text-[#f5f5f5] shadow-lg">
          {toastMessage}
        </div>
      )}
    </div>
  );
};
