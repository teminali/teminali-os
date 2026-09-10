/**
 * VoiceTextSync — Synchronizes visual on-screen text typing with voice speech.
 *
 * In rapid LLMs like Gemini Flash, model tokens arrive at 100+ tokens/sec,
 * finishing generation in under 2 seconds. Spoken voice, however, proceeds at
 * a natural human cadence (~160 words/min, ~22-26 chars/sec).
 *
 * Rather than relying on an artificial decoupled timer, VoiceTextSync is directly
 * driven by audio playback events (SpeechProgressEvent: onStart, onBoundary, onEnd):
 * - While the audio is preparing / synthesising, the message remains in thinking state.
 * - As each word is spoken by the TTS engine, the visual text reveals in lockstep with the voice.
 * - Instant passthrough during text-only turns (no voice lag for typing operators).
 * - Instant freeze on interruption / barge-in (unspoken continuation is cleanly discarded).
 * - Seamless settlement when all speech completes.
 */

import type { SpeechProgressEvent } from "./types";

export interface VoiceTextSyncOptions {
  onUpdate: (visibleText: string) => void;
  /** Fired when the text has fully finished rendering on screen. */
  onFinish?: () => void;
  /** Natural character pace per second. Default: 24 chars/sec (~160 wpm). */
  charsPerSec?: number;
}

/**
 * Returns the end character index of the word located at or immediately following charIndex.
 */
export function wordEndIndex(text: string, charIndex: number): number {
  if (!text) return 0;
  if (charIndex >= text.length) return text.length;
  let idx = charIndex;
  while (idx < text.length && /\s/.test(text[idx])) {
    idx++;
  }
  const nextSpace = text.indexOf(" ", idx);
  return nextSpace === -1 ? text.length : nextSpace;
}

/**
 * Maps the sequence of audible spoken words against the full target generation text,
 * accounting for markdown formatting symbols (*, _, `, #, |).
 * Returns the end character index within target that covers all audible words so far.
 */
export function matchAudibleLengthInTarget(target: string, audible: string): number {
  if (!target || !audible) return 0;
  if (target.startsWith(audible)) return audible.length;

  const audibleWords = audible.trim().split(/\s+/).filter(Boolean);
  if (audibleWords.length === 0) return 0;

  const clean = (w: string) =>
    w.toLowerCase().replace(/[*_~`#|]/g, "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

  const targetTokens: { word: string; clean: string; end: number }[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(target)) !== null) {
    targetTokens.push({
      word: match[0],
      clean: clean(match[0]),
      end: match.index + match[0].length,
    });
  }

  let tPtr = 0;
  let wordsMatched = 0;
  let lastMatchedTargetEnd = 0;

  for (let aPtr = 0; aPtr < audibleWords.length; aPtr++) {
    const aClean = clean(audibleWords[aPtr]);
    if (!aClean) continue;

    while (tPtr < targetTokens.length) {
      const targetClean = targetTokens[tPtr].clean;
      if (
        targetClean === aClean ||
        (targetClean && aClean && (targetClean.includes(aClean) || aClean.includes(targetClean)))
      ) {
        lastMatchedTargetEnd = targetTokens[tPtr].end;
        tPtr++;
        wordsMatched++;
        break;
      }
      tPtr++;
    }
  }

  return wordsMatched > 0 ? lastMatchedTargetEnd : Math.min(target.length, audible.length);
}

export class VoiceTextSync {
  private fullTarget = "";
  private displayedText = "";
  private isVoiceTurn = false;
  private isDone = false;
  private isStreamFinished = false;
  private completedChunks: string[] = [];
  private currentChunk = "";
  private currentCharIndex = 0;
  private watchdogTimer: number | null = null;
  private readonly onUpdate: (visibleText: string) => void;
  private readonly onFinish?: () => void;

  constructor(options: VoiceTextSyncOptions) {
    this.onUpdate = options.onUpdate;
    this.onFinish = options.onFinish;
  }

  public start(isVoiceTurn: boolean): void {
    this.clearWatchdog();
    this.isVoiceTurn = isVoiceTurn;
    this.fullTarget = "";
    this.displayedText = "";
    this.completedChunks = [];
    this.currentChunk = "";
    this.currentCharIndex = 0;
    this.isDone = false;
    this.isStreamFinished = false;
  }

  public pushTarget(target: string): void {
    this.fullTarget = target;
    if (!this.isVoiceTurn) {
      // In text mode: instantaneous, no audio delay
      this.displayedText = target;
      this.onUpdate(target);
      return;
    }

    // In voice turn, if speech has already reached certain words, re-sync with the updated target
    if (this.completedChunks.length > 0 || this.currentChunk) {
      this.updateVisibleText();
    }
  }

  public onSpeechProgress(event: SpeechProgressEvent): void {
    if (!this.isVoiceTurn || this.isDone) return;
    this.clearWatchdog();

    if (event.isAllSpeechDone) {
      this.complete();
      return;
    }

    if (event.isChunkEnd) {
      if (event.chunk.trim()) {
        this.completedChunks.push(event.chunk.trim());
      }
      this.currentChunk = "";
      this.currentCharIndex = 0;
    } else {
      this.currentChunk = event.chunk;
      this.currentCharIndex = event.charIndex;
    }

    this.updateVisibleText();

    // If generation stream finished and this was a chunk ending
    if (this.isStreamFinished && event.isChunkEnd && this.completedChunks.length > 0) {
      this.armWatchdog(1200);
    }
  }

  /**
   * Advance immediately to at least this character index if speech playback has reached it.
   */
  public advanceTo(charIndex: number): void {
    if (charIndex > this.displayedText.length) {
      const nextLength = Math.min(this.fullTarget.length, charIndex);
      this.displayedText = this.fullTarget.slice(0, nextLength);
      this.onUpdate(this.displayedText);
      if (this.displayedText.length >= this.fullTarget.length && this.isStreamFinished) {
        this.complete();
      }
    }
  }

  public finish(): void {
    this.isStreamFinished = true;
    if (!this.isVoiceTurn) {
      this.complete();
      return;
    }
    // In voice mode, give speech up to 3.5 seconds to commence or finish
    this.armWatchdog(3500);
  }

  public interrupt(): void {
    this.clearWatchdog();
    this.isDone = true;
    // Freeze text at exactly whatever was audible
    this.fullTarget = this.displayedText;
    this.onUpdate(this.displayedText);
    this.onFinish?.();
  }

  public flush(): void {
    this.clearWatchdog();
    this.complete();
  }

  public stop(): void {
    this.clearWatchdog();
    this.isDone = true;
  }

  public get isPacing(): boolean {
    return this.isVoiceTurn && !this.isDone;
  }

  private updateVisibleText(): void {
    let audibleText = "";
    if (this.currentChunk) {
      const wordEnd = wordEndIndex(this.currentChunk, this.currentCharIndex);
      const activePiece = this.currentChunk.slice(0, wordEnd);
      audibleText = [...this.completedChunks, activePiece].filter(Boolean).join(" ");
    } else {
      audibleText = this.completedChunks.join(" ");
    }

    if (!audibleText.trim()) return;

    const targetIndex = matchAudibleLengthInTarget(this.fullTarget, audibleText);
    const nextText = targetIndex > 0 ? this.fullTarget.slice(0, targetIndex) : audibleText;

    if (nextText.length > this.displayedText.length) {
      this.displayedText = nextText;
      this.onUpdate(nextText);
    }
  }

  private complete(): void {
    this.clearWatchdog();
    this.isDone = true;
    this.displayedText = this.fullTarget;
    this.onUpdate(this.fullTarget);
    this.onFinish?.();
  }

  private armWatchdog(ms: number): void {
    this.clearWatchdog();
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      if (!this.isDone) {
        this.complete();
      }
    }, ms);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
