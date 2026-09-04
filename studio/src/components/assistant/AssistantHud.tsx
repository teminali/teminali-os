import React, { useEffect } from "react";
import { AlertTriangle, Check, Eye, Loader2, MousePointer2, SkipForward, X, ArrowLeft, RotateCw, Mic, MicOff } from "lucide-react";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/Primitives";
import { describeStep } from "../../services/assistant/plan";
import type { AssistantPhase, UseAssistantResult } from "../../hooks/useAssistant";
import type { VoiceState } from "../../services/voice";

/**
 * What the assistant is doing, and what it is about to do.
 *
 * Two rules from DESIGN.md §1.8 shape this panel and are worth naming, because
 * an assistant that can click things is the surface where breaking either of
 * them costs the most:
 *
 *  - **State is legible.** Every phase says which thing is happening in words,
 *    not as a spinner that could mean any of six.
 *  - **A refused step is shown, not swallowed.** If the engine asked for six
 *    things and four were run, the two that were not are listed with the reason
 *    they were not. "It mostly worked" is not something the operator should
 *    have to discover later.
 */

const PHASE_LABEL: Record<AssistantPhase, string> = {
  idle: "Ready",
  listening: "Listening",
  observing: "Looking at the screen",
  thinking: "Working it out",
  confirming: "Waiting for you",
  acting: "Doing it",
  speaking: "Answering",
};

const PHASE_TONE: Record<AssistantPhase, React.ComponentProps<typeof StatusDot>["tone"]> = {
  idle: "muted",
  listening: "success",
  observing: "accent",
  thinking: "reason",
  confirming: "warning",
  acting: "warning",
  speaking: "accent",
};

/**
 * While the microphone is open the voice engine is the one that knows what is
 * happening, and it passes through four states before the assistant hears a
 * word. Labelling all four as "Listening" would be a header that says one thing
 * while the review bar below it asks for another.
 */
const VOICE_LABEL: Partial<Record<VoiceState, string>> = {
  listening: "Listening",
  hearing: "Listening",
  deciding: "Working out if that was for me",
  repairing: "Cleaning that up",
  review: "Check what I heard",
  sending: "Sending",
};

export interface AssistantHudProps {
  assistant: UseAssistantResult;
  /** Live transcript from the microphone, so the panel shows what it heard. */
  transcript?: string;
  /** The microphone's own state, which leads while it is open. */
  voiceState?: VoiceState;
}

/**
 * Which switch to actually flip, which is the half the old message left out.
 *
 * Accessibility is granted to the application responsible for the pointer
 * helper, never to the helper itself, and that application is not always the
 * one whose name is on the window. A packaged run is "Teminali Code". A
 * development run is attributed to whatever launched it — the terminal that ran
 * `npm start`, not Electron and not the product — so the only honest advice
 * there is to test from the installed app.
 */
function accessibilityHelp(): string {
  const off = "Accessibility is off, so the assistant cannot point at or click anything.";
  const host = (window as { teminali?: { host?: { name?: string; isPackaged?: boolean } | null } }).teminali?.host;
  if (!host) return off;
  if (host.isPackaged) {
    return `${off} Turn on \u201C${host.name}\u201D under System Settings \u203A Privacy & Security \u203A Accessibility.`;
  }
  return `${off} This is a development run, which macOS attributes to whatever launched it \u2014 usually your terminal, not \u201C${host.name}\u201D. Grant it there, or test from the installed app.`;
}

export const AssistantHud: React.FC<AssistantHudProps> = ({ assistant, transcript, voiceState }) => {
  const { phase, turn, capabilities, settings, awaiting } = assistant;

  // Allow closing via Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && assistant.open) {
        assistant.dismiss();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assistant]);

  if (!assistant.open) return null;

  const busy = phase !== "idle";
  const heading =
    phase === "listening" && voiceState ? (VOICE_LABEL[voiceState] ?? PHASE_LABEL[phase]) : PHASE_LABEL[phase];
  const missing: string[] = [];
  if (capabilities && capabilities.supported) {
    if (!capabilities.helperBuilt) missing.push("The pointer helper is not built — run npm run build:pointer.");
    else {
      if (!capabilities.screenRecordingGranted) missing.push("Screen Recording is off, so the assistant cannot see the screen.");
      if (!capabilities.accessibilityTrusted) missing.push(accessibilityHelp());
    }
  } else if (capabilities && !capabilities.supported) {
    missing.push(capabilities.detail ?? "Screen control is not available on this system.");
  }

  const handleBackToStudio = () => {
    void (window as unknown as { teminali?: { assistant?: { focusStudio?: () => Promise<void> } } }).teminali?.assistant?.focusStudio?.();
  };

  const handleRetry = () => {
    if (turn?.question) {
      void assistant.ask(turn.question);
    }
  };

  const hasFailedStep = turn && (turn.error || turn.outcomes.some((o) => o.status === "failed") || turn.rejected.length > 0);

  return (
    <div className="w-full max-w-composer rounded-2xl bg-surface border border-edge-popover overflow-hidden shadow-xl animate-fadeIn">
      {/* Header — always says which of the seven things is happening. */}
      <div className="flex items-center gap-2 px-3.5 h-10 border-b border-edge bg-surface-raised/40">
        <StatusDot tone={PHASE_TONE[phase]} pulse={busy} />
        <span className="text-sm font-medium text-ink-high">{heading}</span>
        <span className="text-2xs text-ink-faint">
          {settings.mode === "dictate" ? "Dictation" : settings.mode === "talk" ? "Talk" : "Agent"}
          {" · "}
          {settings.engine === "frontier" ? `Frontier ${settings.frontierMode}` : settings.engine === "claude" ? "Claude Code" : "Codex"}
        </span>
        <div className="flex-1" />

        {/* Hands-Free continuous voice mode toggle */}
        <button
          type="button"
          onClick={() => assistant.update({ handsFree: !settings.handsFree })}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs font-medium transition-colors ${
            settings.handsFree
              ? "bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25"
              : "bg-surface-hover text-ink-faint hover:text-ink-muted border border-edge"
          }`}
          title={settings.handsFree ? "Hands-free continuous commanding is ON" : "Hands-free continuous commanding is OFF"}
        >
          {settings.handsFree ? <Mic size={11} className="text-accent animate-pulse" /> : <MicOff size={11} />}
          <span>{settings.handsFree ? "Hands-Free" : "Push-to-Talk"}</span>
        </button>

        {busy && (
          <Button variant="ghost" size="xs" onClick={assistant.cancel} icon={<X size={12} />}>
            Stop
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={assistant.dismiss}
          aria-label="Dismiss assistant"
          icon={<X size={13} />}
        >
          Dismiss
        </Button>
      </div>

      {/* Permissions. Named individually, because each one loses a different
          capability and "grant access" would not say which. */}
      {missing.length > 0 && (
        <div className="px-3.5 py-2.5 border-b border-edge space-y-1.5">
          {missing.map((line) => (
            <p key={line} className="flex items-start gap-2 text-2xs text-warning">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" strokeWidth={1.8} />
              <span className="text-ink-muted">{line}</span>
            </p>
          ))}
          {capabilities?.helperBuilt && !capabilities.accessibilityTrusted && (
            <Button variant="secondary" size="xs" onClick={() => void assistant.requestPermissions()}>
              Ask macOS for Accessibility
            </Button>
          )}
        </div>
      )}

      <div className="px-3.5 py-3 space-y-3">
        {/* What it heard. Shown while listening so a misheard word is caught
            before it becomes a plan. */}
        {phase === "listening" && voiceState !== "review" && (
          <p className="text-sm text-ink-muted">
            {transcript ? transcript : <span className="text-ink-placeholder">Say what you need.</span>}
          </p>
        )}

        {turn?.question && phase !== "listening" && (
          <p className="text-2xs text-ink-faint">You said: {turn.question}</p>
        )}

        {turn?.error && <p className="text-sm text-danger">{turn.error}</p>}

        {/* The answer. */}
        {turn?.say && <p className="text-md text-ink-prose leading-relaxed">{turn.say}</p>}

        {(phase === "observing" || phase === "thinking") && !turn?.say && (
          <p className="flex items-center gap-2 text-sm text-ink-faint">
            <Loader2 size={13} className="animate-spin" />
            {phase === "observing" ? "Reading the screen" : "Deciding what to do"}
          </p>
        )}

        {/* The steps. Hovering one draws its ring without running anything. */}
        {turn && turn.outcomes.length > 0 && (
          <ol className="space-y-1">
            {turn.outcomes.map((outcome) => {
              const isAwaiting = awaiting === outcome.index;
              return (
                <li
                  key={outcome.index}
                  onMouseEnter={() => "element" in outcome.step && assistant.point(outcome.step.element)}
                  onMouseLeave={() => assistant.point(null)}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-ds ease-ds ${
                    isAwaiting ? "bg-surface-raised" : "hover:bg-surface-hover"
                  }`}
                >
                  <span className="w-4 flex-shrink-0 flex items-center justify-center">
                    {outcome.status === "done" ? (
                      <Check size={12} className="text-success" />
                    ) : outcome.status === "running" ? (
                      <Loader2 size={12} className="animate-spin text-ink-muted" />
                    ) : outcome.status === "failed" ? (
                      <X size={12} className="text-danger" />
                    ) : outcome.status === "skipped" ? (
                      <SkipForward size={12} className="text-ink-disabled" />
                    ) : (
                      <MousePointer2 size={12} className="text-ink-faint" />
                    )}
                  </span>
                  <span className={`text-sm flex-1 min-w-0 truncate ${outcome.status === "skipped" ? "text-ink-disabled" : "text-ink-muted"}`}>
                    {describeStep(outcome.step, turn.elements)}
                  </span>
                  {outcome.detail && <span className="text-2xs text-ink-faint flex-shrink-0">{outcome.detail}</span>}
                  {isAwaiting && (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <Button variant="primary" size="xs" onClick={assistant.approve}>
                        Do it
                      </Button>
                      <Button variant="ghost" size="xs" onClick={assistant.skip}>
                        Skip
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {/* Withheld and refused. Never silent. */}
        {turn?.actionsWithheld && (
          <p className="text-2xs text-ink-faint">
            This mode explains and points. Switch to Agent for the assistant to act.
          </p>
        )}
        {turn && turn.rejected.length > 0 && (
          <details className="text-2xs text-ink-faint">
            <summary className="cursor-pointer hover:text-ink-muted">
              {turn.rejected.length} step{turn.rejected.length === 1 ? "" : "s"} not run
            </summary>
            <ul className="mt-1 space-y-0.5 pl-3">
              {turn.rejected.map((entry) => (
                <li key={`${entry.index}-${entry.reason}`}>· {entry.reason}</li>
              ))}
            </ul>
          </details>
        )}

        {/* What it looked at. The operator can always see the evidence. */}
        {assistant.observation && (
          <p className="flex items-center gap-1.5 text-2xs text-ink-faint">
            <Eye size={11} strokeWidth={1.8} />
            {assistant.observation.application.name}
            {" · "}
            {assistant.observation.elements.length} control
            {assistant.observation.elements.length === 1 ? "" : "s"}
            {assistant.observation.truncated ? " (partial)" : ""}
            {assistant.observation.sceneDescription ? " · described" : ""}
          </p>
        )}

        {/* Action bar for user controls: Back to Teminali Code, Retry, Dismiss */}
        {turn && (
          <div className="flex items-center justify-between pt-2.5 border-t border-edge/60 mt-1">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                onClick={handleBackToStudio}
                icon={<ArrowLeft size={12} />}
              >
                Back to Teminali Code
              </Button>
              {turn.question && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleRetry}
                  icon={<RotateCw size={12} />}
                >
                  Take Another Look
                </Button>
              )}
            </div>
            <Button
              variant="ghost"
              size="xs"
              onClick={assistant.dismiss}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
