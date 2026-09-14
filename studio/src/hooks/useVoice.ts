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
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    // Settings are saved whole, so a default that changes is pinned at its old
    // value on every existing machine. 1.02 was the shipped rate until
    // 2026-09-05; only that exact value is treated as "never chosen".
    if (parsed.ttsRate === 1.02) delete parsed.ttsRate;
    const wakeWords = Array.isArray(parsed.wakeWords)
      ? Array.from(new Set(["temy", "temi", "teminali", "timmy", ...parsed.wakeWords]))
      : DEFAULT_VOICE_SETTINGS.wakeWords;
    return { ...DEFAULT_VOICE_SETTINGS, ...parsed, wakeWords };
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
  approve: (edited?: string) => Promise<void>;
  discard: () => void;
  recoverRejected: () => Promise<void>;
  /** Stop a spoken reply without it counting as an interruption. */
  silence: () => void;
  /** Silence the microphone without ending the conversation. */
  setMuted: (muted: boolean) => void;
  /** Flip the microphone between silenced and live. */
  toggleMute: () => void;
  /** Reset the 1-minute inactivity sleep timer. */
  touch: () => void;
  update: (patch: Partial<VoiceSettings>) => void;
  /** Tell the engine a reply is ready to be read aloud. */
  speakReply: (text: string) => Promise<void>;
  /** Enqueue a sentence chunk to explain on the go during live token streaming. */
  enqueueSpeechChunk: (chunk: string, isFinal: boolean) => Promise<void>;
  /** Speak a line outside a voice turn — the screen assistant's path. */
  speakAside: (text: string, options?: { expectsAnswer?: boolean }) => Promise<void>;
  /** Tell the voice layer what the run just started doing, for the HUD and the occasional spoken line. */
  noteProgress: (line: string) => void;
  /** The streamed part of a reply is spoken; the digest of the rest is being made. */
  noteDigesting: () => void;
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
        submit: (text, options) => hostRef.current.submit(text, options),
        lastAssistantText: () => hostRef.current.lastAssistantText(),
        isBusy: () => hostRef.current.isBusy(),
        interrupt: () => hostRef.current.interrupt?.(),
        complete: (prompt, signal) => hostRef.current.complete?.(prompt, signal) ?? Promise.resolve(""),
        hints: () => hostRef.current.hints?.() ?? [],
        // Every optional host method must be forwarded here, or the engine
        // silently sees `undefined` and takes its fallback: this one was
        // missing, so "how's it going?" got the canned line, never the run.
        progressSummary: () => hostRef.current.progressSummary?.() ?? null,
        runProgress: () => hostRef.current.runProgress?.() ?? null,
        onSpeechProgress: (event) => hostRef.current.onSpeechProgress?.(event),
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

  return {
    ...snapshot,
    settings,
    startConversation: useCallback(() => start("conversation"), [start]),
    startDictation: useCallback(() => start("push-to-talk"), [start]),
    endDictation: useCallback(() => engine.release(), [engine]),
    stop: useCallback(() => engine.stop(), [engine]),
    approve: useCallback((edited?: string) => engine.approve(edited), [engine]),
    discard: useCallback(() => engine.discard(), [engine]),
    recoverRejected: useCallback(() => engine.recoverRejected(), [engine]),
    silence: useCallback(() => engine.silence(), [engine]),
    setMuted: useCallback((muted) => engine.setMuted(muted), [engine]),
    // Reads the engine rather than the render's snapshot, so a double click
    // cannot toggle twice from one stale value.
    toggleMute: useCallback(() => engine.setMuted(!engine.snapshot().muted), [engine]),
    touch: useCallback(() => engine.touch(), [engine]),
    update,
    speakReply: useCallback((text: string) => engine.speakReply(text), [engine]),
    enqueueSpeechChunk: useCallback((chunk: string, isFinal: boolean) => engine.enqueueSpeechChunk(chunk, isFinal), [engine]),
    speakAside: useCallback((text: string, options?: { expectsAnswer?: boolean }) => engine.speakAside(text, options), [engine]),
    noteProgress: useCallback((line: string) => engine.noteProgress(line), [engine]),
    noteDigesting: useCallback(() => engine.noteDigesting(), [engine]),
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
