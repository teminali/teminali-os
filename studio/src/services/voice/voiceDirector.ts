/**
 * VoiceDirector — Real-time Speech Curator / Voice Director Agent.
 *
 * Inspects model generations in real time as tokens arrive:
 * 1. Suppresses code blocks, command fences, JSON, and terminal output from spoken audio.
 * 2. Curates streaming prose into crisp, natural, conversational sentences.
 * 3. Applies conversational punctuation smoothing to eliminate stutter commas and long pauses.
 * 4. Ensures ongoing conversations avoid robotic "today" greetings.
 * 5. Batches coherent clauses/thoughts so the TTS engine streams smoothly without
 *    stopping and starting with awkward 700ms dead-air gaps between every tiny fragment.
 */

import { speakableText, sanitizeOngoingAssist } from "./speakable.ts";
import { describeToolCall, type NarratableToolCall } from "./progressNarration.ts";
import { isNonSpeechOrBlank } from "./transcriptRepair.ts";

export interface VoiceDirectorOptions {
  /** Callback fired whenever a curated speech chunk is ready to be spoken. */
  onSpeechChunk: (chunk: string, isFinal: boolean) => void;
  /** Whether this is a brand new fresh conversation or an ongoing turn. */
  isFreshConversation?: boolean;
  /** Maximum number of early streaming chunks to speak before waiting for completion. Default: 4. */
  maxStreamedChunks?: number;
}

export class VoiceDirector {
  private readonly options: VoiceDirectorOptions;
  private readonly maxStreamedChunks: number;
  private isFreshConversation: boolean;

  private rawAccumulated = "";
  private spokenLength = 0;
  private streamedChunkCount = 0;
  private isAborted = false;
  private isFinished = false;

  constructor(options: VoiceDirectorOptions) {
    this.options = options;
    this.isFreshConversation = Boolean(options.isFreshConversation);
    this.maxStreamedChunks = options.maxStreamedChunks ?? 4;
  }

  /**
   * Pure curation function: takes raw markdown/generation text and returns
   * the human-spoken version, stripping code fences, raw markdown tables,
   * syntax markers, and smoothing conversational punctuation.
   */
  public static curateSpeech(rawText: string, isFresh = false): string {
    if (!rawText) return "";

    // A fence that has not closed yet is the one thing `speakableText` cannot
    // see, because mid-stream it has only half of it. Close it here so the
    // half-written body is announced rather than recited character by
    // character. Everything after this is markdown the shared normaliser
    // already knows how to read aloud, and duplicating its rules here is how
    // the two of them came to disagree about code blocks.
    const openFences = (rawText.match(/```/g) || []).length;
    const closed = openFences % 2 === 1 ? `${rawText}\n\`\`\`` : rawText;

    let text = speakableText(
      closed
        // A table is a grid for the eye; read out it is a run of pipes.
        .replace(/^\|.*\|$/gm, "")
        .replace(/^\s*[-:| ]{3,}\s*$/gm, ""),
    );

    if (!isFresh) text = sanitizeOngoingAssist(text);

    return text.replace(/\s{2,}/g, " ").trim();
  }

  /**
   * Push an incoming token from the model stream into the Voice Director.
   * Decides if and when to emit a curated speech chunk.
   */
  public pushToken(token: string): void {
    if (this.isAborted || this.isFinished) return;
    this.rawAccumulated += token;

    if (this.streamedChunkCount >= this.maxStreamedChunks) {
      return;
    }

    // Check what part of the accumulated text hasn't been spoken yet
    const pendingRaw = this.rawAccumulated.slice(this.spokenLength);
    if (!pendingRaw.trim()) return;

    // Look for sentence/clause completion boundaries outside of open fences
    // A complete sentence ends with . ! ? followed by whitespace or double-newline
    const boundaryMatch = pendingRaw.match(/^([\s\S]+?[.!?](?:\s+|$)|[\s\S]+?\n\n+)/);
    if (!boundaryMatch) return;

    const rawMatch = boundaryMatch[1];
    // Check if we are currently inside an incomplete code fence
    const fencesSoFar = (this.rawAccumulated.slice(0, this.spokenLength + rawMatch.length).match(/```/g) || []).length;
    if (fencesSoFar % 2 !== 0) {
      // Inside a code fence: do not emit speech from within code!
      return;
    }

    const curated = VoiceDirector.curateSpeech(rawMatch, this.isFreshConversation);
    this.spokenLength += rawMatch.length;

    if (curated && !isNonSpeechOrBlank(curated)) {
      this.streamedChunkCount += 1;
      this.options.onSpeechChunk(curated, false);
    }
  }

  /**
   * Real-time notification of a tool call / command execution.
   */
  public onToolCall(call: NarratableToolCall): string | null {
    if (this.isAborted) return null;
    return describeToolCall(call);
  }

  /**
   * Called when the model stream finishes. Flushes any remaining unspoken curated prose.
   */
  public finish(fullText?: string): void {
    if (this.isAborted || this.isFinished) return;
    this.isFinished = true;

    // `fullText` is the caller's cleaned copy of the reply, and cleaning moves
    // characters: `sanitizeOngoingAssist` turns "today" into "now" and takes
    // two characters out of the middle of the very text `spokenLength` was
    // measured against. Slicing the cleaned string by the raw offset then
    // starts the tail two characters early, mid-word, and the operator hears
    // the join. Only trust the caller's text when it still agrees with what we
    // actually counted.
    const counted = this.rawAccumulated.slice(0, this.spokenLength);
    const sourceText =
      fullText !== undefined && fullText.startsWith(counted) ? fullText : this.rawAccumulated;
    const remainingRaw = sourceText.slice(this.spokenLength);

    if (remainingRaw.trim()) {
      const remainingCurated = VoiceDirector.curateSpeech(remainingRaw, this.isFreshConversation);
      if (remainingCurated && !isNonSpeechOrBlank(remainingCurated)) {
        this.spokenLength = sourceText.length;
        this.options.onSpeechChunk(remainingCurated, true);
        return;
      }
    }

    // Signal completion with empty final chunk if needed
    this.options.onSpeechChunk("", true);
  }

  /**
   * Returns how many characters of raw text have already been spoken.
   */
  public getSpokenLength(): number {
    return this.spokenLength;
  }

  /**
   * Abort this director's processing immediately (e.g. on user interruption).
   */
  public abort(): void {
    this.isAborted = true;
  }
}
