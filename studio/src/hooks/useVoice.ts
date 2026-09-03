/**
 * React binding for the voice engine.
 *
 * The engine is a long-lived object that outlives any single render, so it is
 * held in a ref and its snapshots are mirrored into state. The host callbacks
 * are read through a ref too: they close over chat state that changes on every
 * token, and rebuilding the engine that often would drop the microphone
 * mid-sentence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_VOICE_SETTINGS,
  VoiceEngine,
  type VoiceHost,
  type VoiceMode,
  type VoiceSettings,
  type VoiceSnapshot,
} from "../services/voice";

const SETTINGS_KEY = "teminali_voice_settings_v1";

function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
    return { ...DEFAULT_VOICE_SETTINGS, ...(JSON.parse(raw) as Partial<VoiceSettings>) };
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export interface UseVoiceResult extends VoiceSnapshot {
  settings: VoiceSettings;
  /** Start hands-free conversation mode. */
  startConversation: () => Promise<void>;
  /** Begin a push-to-talk capture. */
  startDictation: () => Promise<void>;
  /** End a push-to-talk capture and commit what was heard. */
  endDictation: () => Promise<void>;
  stop: () => Promise<void>;
  /** Toggle whichever mode is configured. */
  toggle: () => Promise<void>;
  approve: (edited?: string) => Promise<void>;
  discard: () => void;
  recoverRejected: () => Promise<void>;
  /** Stop a spoken reply without it counting as an interruption. */
  silence: () => void;
  update: (patch: Partial<VoiceSettings>) => void;
  /** Tell the engine a reply is ready to be read aloud. */
  speakReply: (text: string) => Promise<void>;
  /** Speak a line outside a voice turn — the screen assistant's path. */
  speakAside: (text: string) => Promise<void>;
  captureEnrolmentClip: (seconds?: number) => Promise<{ samples: Float32Array; sampleRate: number }>;
  finishEnrolment: (clips: Array<{ samples: Float32Array; sampleRate: number }>) => boolean;
  clearEnrolment: () => void;
  probe: () => Promise<void>;
}

export function useVoice(host: VoiceHost): UseVoiceResult {
  const hostRef = useRef(host);
  hostRef.current = host;

  const [settings, setSettings] = useState<VoiceSettings>(loadSettings);

  // One engine for the lifetime of the mount. It reads the host through the
  // ref, so a re-render never disturbs an open microphone.
  const engine = useMemo(
    () =>
      new VoiceEngine({
        submit: (text) => hostRef.current.submit(text),
        lastAssistantText: () => hostRef.current.lastAssistantText(),
        isBusy: () => hostRef.current.isBusy(),
        complete: (prompt, signal) => hostRef.current.complete?.(prompt, signal) ?? Promise.resolve(""),
        hints: () => hostRef.current.hints?.() ?? [],
      }),
    [],
  );

  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(() => engine.snapshot());

  useEffect(() => engine.subscribe(setSnapshot), [engine]);

  useEffect(() => {
    engine.configure(settings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* Settings simply do not persist. */
    }
  }, [engine, settings]);

  useEffect(() => {
    void engine.probe();
    return () => {
      void engine.stop();
    };
  }, [engine]);

  const update = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const start = useCallback((mode: VoiceMode) => engine.start(mode), [engine]);

  const toggle = useCallback(async () => {
    if (snapshot.state !== "idle") {
      await engine.stop();
      return;
    }
    await engine.start(settings.mode);
  }, [engine, snapshot.state, settings.mode]);

  return {
    ...snapshot,
    settings,
    startConversation: useCallback(() => start("conversation"), [start]),
    startDictation: useCallback(() => start("push-to-talk"), [start]),
    endDictation: useCallback(() => engine.release(), [engine]),
    stop: useCallback(() => engine.stop(), [engine]),
    toggle,
    approve: useCallback((edited?: string) => engine.approve(edited), [engine]),
    discard: useCallback(() => engine.discard(), [engine]),
    recoverRejected: useCallback(() => engine.recoverRejected(), [engine]),
    silence: useCallback(() => engine.silence(), [engine]),
    update,
    speakReply: useCallback((text: string) => engine.speakReply(text), [engine]),
    speakAside: useCallback((text: string) => engine.speakAside(text), [engine]),
    captureEnrolmentClip: useCallback((seconds?: number) => engine.captureEnrolmentClip(seconds), [engine]),
    finishEnrolment: useCallback(
      (clips: Array<{ samples: Float32Array; sampleRate: number }>) => engine.finishEnrolment(clips) !== null,
      [engine],
    ),
    clearEnrolment: useCallback(() => engine.clearEnrolment(), [engine]),
    probe: useCallback(async () => {
      await engine.probe();
    }, [engine]),
  };
}
