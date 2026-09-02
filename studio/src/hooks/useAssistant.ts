/**
 * The screen assistant, as one session.
 *
 * There is exactly one of these in the application, created in `App`. The
 * microphone in the composer and the global hotkey are two doors into it, not
 * two features — which is why the microphone does not own a recorder of its
 * own and the hotkey does not own a second one.
 *
 * The shape of a turn:
 *
 *   listen  →  observe (concurrently)  →  ask an engine  →  validate  →  say  →  act
 *
 * The observation is fired the moment listening starts rather than when the
 * sentence ends, because it is the slow half: the accessibility tree comes back
 * in about 300 ms but the local vision pass takes several seconds, and those
 * seconds are free if they are spent while the operator is still talking.
 *
 * Which engine answers is a setting, not a constant. Frontier (Flash/Auto/Max),
 * Claude Code and Codex all take the same prompt and are held to the same
 * validator, so switching engines changes who answers and nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantService } from "../services/assistant/assistantService";
import { askEngine } from "../services/assistant/engine";
import { inventoryText, rankElements } from "../services/assistant/elements";
import { readPlan } from "../services/assistant/plan";
import { buildPrompt } from "../services/assistant/prompt";
import {
  DEFAULT_ASSISTANT_SETTINGS,
  type AssistantCapabilities,
  type AssistantEngine,
  type AssistantMode,
  type AssistantSettings,
  type Observation,
  type PlanStep,
  type RejectedStep,
  type ScreenElement,
  type StepOutcome,
} from "../services/assistant/types";
import type { UseVoiceResult } from "./useVoice";

const SETTINGS_KEY = "teminali_assistant_settings_v1";

/** The one pane that can actually turn Accessibility on. */
const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** An observation is worth reusing for as long as the screen is probably the same. */
const OBSERVATION_REUSE_MS = 20_000;

export type AssistantPhase =
  | "idle"
  | "listening"
  | "observing"
  | "thinking"
  | "confirming"
  | "acting"
  | "speaking";

export interface AssistantTurn {
  id: string;
  at: string;
  question: string;
  engine: AssistantEngine;
  mode: AssistantMode;
  say: string;
  steps: PlanStep[];
  rejected: RejectedStep[];
  actionsWithheld: boolean;
  outcomes: StepOutcome[];
  /** The ranked inventory the plan was validated against. */
  elements: ScreenElement[];
  observationId: string | null;
  error: string | null;
}

export interface UseAssistantResult {
  phase: AssistantPhase;
  settings: AssistantSettings;
  capabilities: AssistantCapabilities | null;
  turn: AssistantTurn | null;
  observation: Observation | null;
  /** True when the panel or overlay should be on screen. */
  open: boolean;
  /** Index of the step waiting for approval, or null. */
  awaiting: number | null;
  /** The element currently being pointed at, for the overlay. */
  target: ScreenElement | null;

  update: (patch: Partial<AssistantSettings>) => void;
  /** Called by the chat once, so the hotkey and the mic share one microphone. */
  attachVoice: (voice: UseVoiceResult | null) => void;
  /** Whether an utterance belongs to the assistant rather than the composer. */
  claimsUtterance: () => boolean;

  /** Open the session and start listening. The hotkey, the tray and the mic. */
  beginListening: () => Promise<void>;
  /** Run a turn from text. Voice submits through here too. */
  ask: (question: string) => Promise<void>;
  approve: () => void;
  skip: () => void;
  cancel: () => void;
  dismiss: () => void;
  refreshCapabilities: () => Promise<void>;
  requestPermissions: () => Promise<void>;
  /** Draw the ring on one element without running anything. */
  point: (elementId: string | null) => void;
}

function loadSettings(): AssistantSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ASSISTANT_SETTINGS };
    return { ...DEFAULT_ASSISTANT_SETTINGS, ...(JSON.parse(raw) as Partial<AssistantSettings>) };
  } catch {
    return { ...DEFAULT_ASSISTANT_SETTINGS };
  }
}

function turnId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `turn-${Date.now()}`;
}

export function useAssistant(): UseAssistantResult {
  const [settings, setSettings] = useState<AssistantSettings>(loadSettings);
  const [capabilities, setCapabilities] = useState<AssistantCapabilities | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>("idle");
  const [turn, setTurn] = useState<AssistantTurn | null>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [open, setOpen] = useState(false);
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);

  // Read through refs by the long-lived callbacks below: a turn takes seconds
  // and the settings can change inside one, but a captured value cannot.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const voiceRef = useRef<UseVoiceResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The look started when listening began, awaited when the sentence lands. */
  const pendingObservation = useRef<{ at: number; promise: Promise<Observation> } | null>(null);
  /** Resolves when the operator approves or skips the step being confirmed. */
  const gateRef = useRef<((decision: "approve" | "skip") => void) | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* Settings simply do not persist. */
    }
  }, [settings]);

  const update = useCallback((patch: Partial<AssistantSettings>) => {
    setSettings((previous) => ({ ...previous, ...patch }));
  }, []);

  const refreshCapabilities = useCallback(async () => {
    setCapabilities(await AssistantService.capabilities());
  }, []);

  useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

  /**
   * Ask for Accessibility, and make sure something visible happens.
   *
   * macOS raises its Accessibility dialog at most once per application, ever.
   * It also keys the grant to the code signature, and this build is ad-hoc
   * signed — the identity changes on every rebuild while the TCC entry made
   * against the old one survives. Between those two rules the common case is
   * that `AXIsProcessTrustedWithOptions(prompt:)` returns "not trusted" and
   * puts nothing on screen at all, which reads to the operator as a dead
   * button. The dialog's own affirmative button only opens System Settings
   * anyway, so when the prompt does not come back trusted we go straight
   * there. That is worth doing even when the dialog did appear: it returns
   * false while the dialog is still up, and Settings opening behind it is a
   * far smaller cost than a button that silently does nothing.
   */
  const requestPermissions = useCallback(async () => {
    let latest: AssistantCapabilities;
    try {
      latest = await AssistantService.requestPermissions();
    } catch {
      latest = await AssistantService.capabilities();
    }
    setCapabilities(latest);
    if (latest.supported && latest.helperBuilt && !latest.accessibilityTrusted) {
      // Not "_self": that would navigate the studio itself to an
      // x-apple.systempreferences: URL and leave a blank window.
      window.open(ACCESSIBILITY_PANE);
    }
  }, []);

  const attachVoice = useCallback((voice: UseVoiceResult | null) => {
    voiceRef.current = voice;
  }, []);

  const claimsUtterance = useCallback(() => settingsRef.current.mode !== "dictate", []);

  /* ── Observation ───────────────────────────────────────────────────────── */

  /**
   * Starts a look, or hands back one that is recent enough to still be true.
   *
   * Reuse is bounded in time rather than by a change signal because there is no
   * change signal to have: the screen belongs to other applications, and the
   * only honest statement about it is how long ago we looked.
   */
  const look = useCallback((force = false): Promise<Observation> => {
    const existing = pendingObservation.current;
    if (!force && existing && Date.now() - existing.at < OBSERVATION_REUSE_MS) return existing.promise;
    const promise = AssistantService.observe({ maxElements: 120, describe: true }).then((result) => {
      setObservation(result);
      return result;
    });
    // A rejection must not become an unhandled rejection while it waits to be
    // awaited by a sentence that may never come.
    promise.catch(() => {});
    pendingObservation.current = { at: Date.now(), promise };
    return promise;
  }, []);

  /* ── Execution ─────────────────────────────────────────────────────────── */

  const approve = useCallback(() => gateRef.current?.("approve"), []);
  const skip = useCallback(() => gateRef.current?.("skip"), []);

  const waitForOperator = useCallback(
    (index: number) =>
      new Promise<"approve" | "skip">((resolvePromise) => {
        setAwaiting(index);
        setPhase("confirming");
        gateRef.current = (decision) => {
          gateRef.current = null;
          setAwaiting(null);
          resolvePromise(decision);
        };
      }),
    [],
  );

  const runSteps = useCallback(
    async (observationId: string, steps: PlanStep[]) => {
      const autonomy = settingsRef.current.autonomy;

      for (let index = 0; index < steps.length; index += 1) {
        if (abortRef.current?.signal.aborted) return;
        const step = steps[index];

        // Pointing is how this assistant answers, so the ring is drawn for
        // every step regardless of whether the step will be executed.
        if ("element" in step) setTargetId(step.element);

        const mark = (status: StepOutcome["status"], detail?: string) => {
          setTurn((previous) =>
            previous
              ? {
                  ...previous,
                  outcomes: previous.outcomes.map((outcome) =>
                    outcome.index === index ? { ...outcome, status, detail } : outcome,
                  ),
                }
              : previous,
          );
        };

        // `guide` draws and explains and executes nothing at all — including
        // the pointer move, which is still the operator's cursor.
        if (autonomy === "guide") {
          mark("skipped", "Guidance only");
          continue;
        }

        const acts = step.kind !== "point" && step.kind !== "wait";
        if (acts && autonomy === "confirm") {
          const decision = await waitForOperator(index);
          if (decision === "skip") {
            mark("skipped", "Skipped by you");
            continue;
          }
        }

        setPhase("acting");
        mark("running");
        try {
          await AssistantService.act(observationId, step, abortRef.current?.signal);
          mark("done");
        } catch (error) {
          const message = error instanceof Error ? error.message : "The step could not be run.";
          mark("failed", message);
          // A failed step invalidates every step after it: they were planned
          // against a screen that this one was supposed to have changed.
          setTurn((previous) =>
            previous
              ? {
                  ...previous,
                  outcomes: previous.outcomes.map((outcome) =>
                    outcome.index > index && outcome.status === "pending"
                      ? { ...outcome, status: "skipped", detail: "The step before it did not run" }
                      : outcome,
                  ),
                }
              : previous,
          );
          return;
        }
      }
    },
    [waitForOperator],
  );

  /* ── The turn ──────────────────────────────────────────────────────────── */

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const active = settingsRef.current;
      const mode: AssistantMode = active.mode === "dictate" ? "talk" : active.mode;
      const id = turnId();
      setOpen(true);
      setTargetId(null);
      setTurn({
        id,
        at: new Date().toISOString(),
        question: text,
        engine: active.engine,
        mode,
        say: "",
        steps: [],
        rejected: [],
        actionsWithheld: false,
        outcomes: [],
        elements: [],
        observationId: null,
        error: null,
      });

      setPhase("observing");
      let seen: Observation;
      try {
        seen = await look();
      } catch (error) {
        setPhase("idle");
        setTurn((previous) =>
          previous
            ? { ...previous, error: error instanceof Error ? error.message : "The screen could not be read." }
            : previous,
        );
        return;
      }
      if (controller.signal.aborted) return;

      const elements = rankElements(seen.elements, { windowFrame: seen.window?.frame, limit: 60 });
      const prompt = buildPrompt({
        question: text,
        mode,
        observation: seen,
        elements,
        inventory: inventoryText(elements),
      });

      setPhase("thinking");
      let reply = "";
      try {
        reply = await askEngine(prompt, {
          engine: active.engine,
          frontierMode: active.frontierMode,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase("idle");
        setTurn((previous) =>
          previous
            ? { ...previous, error: error instanceof Error ? error.message : "The engine did not answer." }
            : previous,
        );
        return;
      }
      if (controller.signal.aborted) return;

      const plan = readPlan(reply, { elements, mode });
      const outcomes: StepOutcome[] = plan.steps.map((step, index) => ({ index, step, status: "pending" }));

      setTurn((previous) =>
        previous
          ? {
              ...previous,
              say: plan.say,
              steps: plan.steps,
              rejected: plan.rejected,
              actionsWithheld: plan.actionsWithheld,
              outcomes,
              elements,
              observationId: seen.id,
            }
          : previous,
      );

      // Spoken before the steps run, so the operator hears what is about to
      // happen rather than being told about it afterwards.
      if (active.speak && plan.say) {
        setPhase("speaking");
        try {
          await voiceRef.current?.speakReply(plan.say);
        } catch {
          /* A silent answer is still an answer. */
        }
      }
      if (controller.signal.aborted) return;

      if (plan.steps.length > 0) {
        await runSteps(seen.id, plan.steps);
      }
      if (!controller.signal.aborted) setPhase("idle");
    },
    [look, runSteps],
  );

  /* ── Entry points ──────────────────────────────────────────────────────── */

  const beginListening = useCallback(async () => {
    setOpen(true);
    // Fired now rather than when the sentence ends: the vision pass is several
    // seconds and they are free while the operator is still speaking.
    if (settingsRef.current.mode !== "dictate") void look(true);
    const voice = voiceRef.current;
    if (!voice) return;
    setPhase("listening");
    await voice.startDictation();
  }, [look]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    gateRef.current?.("skip");
    voiceRef.current?.silence();
    void voiceRef.current?.stop();
    setAwaiting(null);
    setPhase("idle");
  }, []);

  const dismiss = useCallback(() => {
    cancel();
    setOpen(false);
    setTargetId(null);
  }, [cancel]);

  const point = useCallback((elementId: string | null) => setTargetId(elementId), []);

  const target = useMemo(() => {
    if (!targetId || !turn) return null;
    return turn.elements.find((element) => element.id === targetId) ?? null;
  }, [targetId, turn]);

  // The voice engine's own state is the truth while it is listening; mirroring
  // it here keeps one indicator rather than two that can disagree.
  useEffect(() => {
    if (phase !== "listening") return;
    const voice = voiceRef.current;
    if (voice && voice.state === "idle") setPhase("idle");
  }, [phase]);

  return {
    phase,
    settings,
    capabilities,
    turn,
    observation,
    open,
    awaiting,
    target,
    update,
    attachVoice,
    claimsUtterance,
    beginListening,
    ask,
    approve,
    skip,
    cancel,
    dismiss,
    refreshCapabilities,
    requestPermissions,
    point,
  };
}
