/**
 * The Gemini Live half of the voice lane.
 *
 * This is a drop-in for the `Realtime8000ProtocolManager` that used to live in
 * `voiceAudioEngine.ts` and talk a binary WebSocket protocol to a local Python
 * pipeline on :8000 (Whisper in, Kokoro out). That pipeline is gone. The shape
 * of this class is deliberately unchanged from it — same callbacks, same
 * `send*` methods, same six inbound message types — because the consumer,
 * `components/voice/TemiVoiceStage.tsx`, is a large state machine that was
 * tuned against that surface and should not have to learn a new one.
 *
 * It has since grown exactly one thing that lane never had: a seventh inbound
 * message, `tool_call`, and a `sendToolResponse()` to answer it. That is Gemini
 * Live function calling, and it is how Temi reaches the Teminali OS assistant
 * herself instead of a regex in `machineAction.ts` deciding for her before she
 * ever sees the turn. `ASK_THE_ASSISTANT` below records what that cost.
 *
 * Everything that changed is behind the surface:
 *
 *  - the SDK owns the socket, so there is no `url` to pass to `connect()`;
 *    the engine fetches its own single-use token instead (`geminiLiveToken.ts`)
 *  - the server runs its own VAD and its own barge-in, so several of the old
 *    control messages no longer have a counterpart. They are kept as
 *    documented no-ops rather than deleted — see TASK 5 comments below.
 *  - two sample-rate conversions the Python lane did elsewhere now happen here.
 *    Both are load-bearing; both are explained where they are implemented.
 *
 * The reference implementation this mapping was read off is the sandbox at
 * `../full-duplex-assistant/web/script.js` (`startRealtime()`), which has been
 * driving a real Gemini Live session for weeks.
 */

import {
  GoogleGenAI,
  Modality,
  Type,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { TEMI_PERSONA, TEMI_DEFAULT_VOICE } from "./temiPersona.ts";
import { fetchGeminiLiveToken, describeGeminiLive } from "./geminiLiveToken.ts";
import { DEFAULT_ENDPOINTER, endpointStall } from "./turnTaking.ts";
import { MicEndpointer } from "./micEndpoint.ts";

/**
 * Native-audio Live model. Measured working with `enableAffectiveDialog`, which
 * the half-cascade models reject: she hears how something was said, not only
 * what was said. The gateway may name a different model when it mints the
 * token; that wins, because the token is minted for a specific model.
 */
const DEFAULT_MODEL = "gemini-2.5-flash-native-audio-latest";

/** Gemini Live takes 16 kHz PCM in. Not negotiable; it is in the mime type. */
const MIC_RATE = 16000;
/**
 * The AudioContext in `voiceAudioEngine.ts` is pinned to `new AudioCtx({
 * sampleRate: 48000 })`, and `pcmWorkletProcessor` runs at context rate, so
 * every Int16 that arrives at `sendAudioChunk` is a 48 kHz sample.
 */
const MIC_CONTEXT_RATE = 48000;
/** Gemini Live always returns PCM16 mono at 24 kHz. */
const MODEL_AUDIO_RATE = 24000;
/** …and the playback worklet runs at the context rate. See `upsampleTo48k`. */
const PLAYBACK_RATE = 48000;

/** The eight bytes `voiceAudioEngine.flushBatch()` writes in front of a frame:
    a big-endian uint32 timestamp, then a big-endian uint32 flags word whose
    bit 0 is "TTS is playing". The Python lane used both for its own echo
    suppression; Gemini does that server-side, so we only skip past them. */
const FRAME_HEADER_BYTES = 8;

/**
 * How long Gemini's own VAD waits on silence before it closes the operator's
 * turn.
 *
 * It was 700 ms, and 700 ms is inside a thinking pause. "Open dukabot" —
 * pause — "and run the tests" reached the shell as two separate turns, so each
 * half was routed on its own and the tests ran against whatever project the
 * first half had not finished opening.
 *
 * The number is not invented here. `turnTaking.ts` measured where a person's
 * pauses actually fall: under ~500 ms is a breath between words, 600–1000 ms
 * is a pause between phrases while the next one is composed, and past ~1.8 s
 * even a trailing "and" has been abandoned. `DEFAULT_ENDPOINTER.maxSilenceMs`
 * is that ceiling, and it is read from there rather than copied so the two
 * cannot drift apart.
 *
 * The ceiling and not the middle, because Gemini's window is FIXED: its VAD
 * takes one number and cannot shorten it for a sentence that sounds finished
 * the way `Endpointer` does. A window under the speaker's own pause splits the
 * sentence every single time; one over it costs about a second at the end of a
 * turn. The `pacingCeilingMs` of 2000 is a cap on a LEARNED FLOOR rather than
 * a silence window, so it is the bound this sits under, not the target.
 */
export const END_OF_TURN_SILENCE_MS = DEFAULT_ENDPOINTER.maxSilenceMs;

/**
 * How much audio to hold while the detector makes up its mind. Onset is three
 * voiced frames at 20 ms plus the 32 ms window they are seen in, so a little
 * over 90 ms; eight 42.7 ms chunks is 340 ms, comfortably more, and 11 KB.
 */
const PREBUFFER_CHUNKS = 8;

/** A single utterance is never this long. Lifted from `conversation.ts`. */
const MAX_UTTERANCE_MS = 15_000;

/** Frames stop arriving for this long and the mic is gone, not quiet. */
const FRAME_STALL_MS = 2_000;

export const ENDPOINT_STALL_NOTE =
  "I could not tell when you stopped, so I took the turn. Say that again if I cut you off.";

/**
 * Reconnect backoff after a socket that opened and then closed.
 *
 * The old lane retried on a flat 2000 ms with no cap and no end. Every retry
 * mints a fresh single-use token, so a Google-side outage cost a token every
 * two seconds for as long as the app stayed open — all night, if it stayed
 * open all night — while the operator was shown a lane that simply never came
 * back.
 *
 * 1 s doubling to a 15 s ceiling: 1, 2, 4, 8, 15, 15. Anything transient (the
 * far end recycling a connection, one dropped frame of wifi) is back inside
 * the first two attempts.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 15_000;

/**
 * The slower schedule, for a token that could not be minted at all: no network
 * at the cafe table yet, a captive portal, a gateway still starting up.
 *
 * 5 s doubling to a 60 s ceiling: 5, 10, 20, 40, 60, 60 — about three minutes
 * of trying, which is the span a wifi drop or a portal sign-in actually
 * occupies. Deliberately slower than the socket ladder, because a failed mint
 * is a round trip through the gateway and out to Google and hammering it helps
 * nobody.
 */
export const TOKEN_RETRY_BASE_MS = 5_000;
export const TOKEN_RETRY_CAP_MS = 60_000;

/** Consecutive failures before the lane stops trying and says so. Six, so the
    socket ladder gives up after ~45 s and the token ladder after ~3 min:
    nothing that has refused six times in that span accepts the seventh, and
    past that point the operator needs a sentence rather than more spent
    quota. */
export const MAX_RECONNECT_ATTEMPTS = 6;

/**
 * How long to wait for the Live socket itself to open.
 *
 * `ai.live.connect()` returns a promise that a captive portal can leave
 * pending for the life of the process — the portal accepts the connection and
 * nothing ever answers the upgrade. `connecting` would then stay true forever
 * and only a restart brings voice back. 10 s is not measured against a
 * handshake; it is measured against the credential, which the gateway mints
 * with a 60 s window in which a new session must be opened
 * (`GEMINI_LIVE_SESSION_WINDOW_MS`). A handshake still unfinished at 10 s is
 * already eating that window.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** The same wedge one layer up: the gateway itself reaches Google to mint, so
    a hung upstream is a request that never answers. */
export const TOKEN_FETCH_TIMEOUT_MS = 8_000;

/** How far ahead of Google's stated hang-up the replacement session is built. */
export const GO_AWAY_LEAD_MS = 1_000;

/** What the operator is told once the lane has stopped trying. It names the
    way back, because there is one and it is not obvious. */
export const RECONNECT_GAVE_UP_NOTE =
  "Voice could not reach Gemini after several tries and has stopped. Switch the microphone off and on to try again.";

/** `base * 2^(attempt - 1)`, capped. Attempt 1 is the first retry. */
export function backoffDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** (step - 1));
}

/**
 * Is this token failure worth another go?
 *
 * `gateway-unreachable` always was — a gateway that has not finished starting
 * is up within seconds. Everything else was terminal for the whole session,
 * and that is the failure this repairs: opening the laptop away from the
 * network and joining wifi a minute later left voice dead until the app was
 * restarted, because the single mint that was attempted failed and nothing
 * ever attempted another.
 *
 * `no-key`, `sdk-unavailable` and `quota` stay terminal, because none of them
 * becomes true again while the operator waits: they want a key pasted, a
 * reinstall, or a billing cycle. Retrying them would only bury the sentence
 * that says so under a loop nobody can act on.
 */
export function isRetryableTokenFailure(reason: string): boolean {
  return reason === "gateway-unreachable"
    || reason === "gateway-error"
    || reason === "mint-failed"
    || reason === "no-token"
    || reason === "unknown";
}

/** A protobuf duration as milliseconds: "10s", "9.5s". 0 when absent or in a
    shape this does not recognise, which reads as "hanging up now". */
export function parseDurationMs(value: string | undefined | null): number {
  const match = /^(\d+(?:\.\d+)?)s$/.exec((value ?? "").trim());
  if (!match) return 0;
  return Math.max(0, Math.round(Number(match[1]) * 1000));
}

/** When to build the replacement session after a `goAway`: a second before
    the stated end, or immediately when the server did not state one. */
export function goAwayRestartDelayMs(timeLeft: string | undefined | null): number {
  const left = parseDurationMs(timeLeft);
  if (left <= 0) return 0;
  return Math.max(0, left - GO_AWAY_LEAD_MS);
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * The promise itself is not cancellable — the caller has to decide what to do
 * with a socket that opens after we stopped waiting for it. `connect()` closes
 * it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The seven shapes this engine emits, and nothing else. The consumer switches
    on `type`, so adding an eighth here is a change to a contract, not a detail.
    `tool_call` is the newest and the only one with no ancestor in the Python
    lane: it is the model asking for hands, and the stage is expected to answer
    every one of them through `sendToolResponse()`. */
/**
 * What one turn cost, in milliseconds from the moment he stopped speaking.
 * `commitMs` is ours, `firstAudioMs` is what he waits.
 */
export interface TurnTiming {
  /** Our endpointer's verdict to `activityEnd` on the wire. */
  commitMs: number;
  /** He stopped speaking to her first content back. */
  turnStartMs: number;
  /** He stopped speaking to the first byte of her voice. This is the wait. */
  firstAudioMs: number;
  /** The silence window the endpointer sized for this turn. */
  windowMs: number;
}

export type GeminiLiveMessage =
  | { type: "partial_user_request"; content: string }
  | { type: "final_user_request"; content: string }
  | { type: "partial_assistant_answer"; content: string }
  | { type: "final_assistant_answer"; content: string }
  | { type: "tts_audio"; int16: Int16Array }
  | { type: "tts_interrupt" }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> };

/**
 * Average 48 kHz Int16 down to 16 kHz Int16.
 *
 * This is `downsampleTo16k` from the sandbox (`web/script.js:852`) with one
 * difference, stated so nobody reads it as a mistake: the sandbox rounds the
 * output length per chunk, which at 2048 input samples asks for 683 outputs and
 * builds the last one from two samples instead of three. Here the leftover
 * input samples are carried into the next chunk instead, so the ratio is
 * exactly 3:1 forever and the stream neither stretches nor drifts.
 *
 * It averages rather than decimating, and that part matters: dropping two of
 * every three samples aliases everything above 8 kHz back down into the band
 * the recogniser listens to, and consonants are exactly what lives up there.
 */
function downsampleTo16k(input: Int16Array, carry: Int16Array): { out: Int16Array; carry: Int16Array } {
  const ratio = MIC_CONTEXT_RATE / MIC_RATE; // exactly 3
  const total = carry.length + input.length;
  const outLength = Math.floor(total / ratio);
  const out = new Int16Array(outLength);

  const at = (i: number) => (i < carry.length ? carry[i] : input[i - carry.length]);

  for (let o = 0; o < outLength; o++) {
    let sum = 0;
    const base = o * ratio;
    for (let k = 0; k < ratio; k++) sum += at(base + k);
    out[o] = (sum / ratio) | 0;
  }

  const consumed = outLength * ratio;
  const leftover = new Int16Array(total - consumed);
  for (let i = 0; i < leftover.length; i++) leftover[i] = at(consumed + i);
  return { out, carry: leftover };
}

/**
 * Linear-interpolate 24 kHz Int16 up to 48 kHz Int16.
 *
 * THIS IS NOT COSMETIC AND IT IS EASY TO DELETE BY ACCIDENT. Gemini returns
 * PCM16 at 24000 Hz. `worklets/ttsPlaybackProcessor.js` writes exactly one
 * queued sample per output frame — read its `process()`; there is no resampling
 * anywhere in it — and the AudioContext it runs in is 48000 Hz. Hand it 24 kHz
 * samples and every one of them lasts half as long as it should: Temi plays
 * back at double speed and an octave high.
 *
 * The old Python lane never hit this because it resampled before the renderer
 * ever saw the audio — `realtime-voice/code/upsample_overlap.py:54`,
 * `resample_poly(audio_float, 48000, 24000)`. That file is gone, so the
 * conversion moved here. If you are deleting this because "the worklet handles
 * it", it does not.
 *
 * Linear interpolation is enough at 2x: the inserted sample sits between two
 * real ones, and the error is inaudible against a 24 kHz-bandlimited source.
 * The last real sample of each chunk is kept as the anchor for the next one,
 * because otherwise every chunk boundary interpolates from zero and the stream
 * clicks at the buffer rate.
 */
function upsampleTo48k(input: Int16Array, anchor: number): { out: Int16Array; anchor: number } {
  const factor = PLAYBACK_RATE / MODEL_AUDIO_RATE; // exactly 2
  const out = new Int16Array(input.length * factor);
  let previous = anchor;
  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    out[i * 2] = ((previous + current) / 2) | 0;
    out[i * 2 + 1] = current;
    previous = current;
  }
  return { out, anchor: previous };
}

/** Base64 in chunks: `String.fromCharCode(...bytes)` on a whole 40 ms frame
    blows the argument limit on some engines, and this is on the hot path. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * The one tool Temi has, and the reason this file grew a function-calling path.
 *
 * Measured 2026-09-12, spoken to her over a live session with nothing
 * delegated: asked the total size of the operator's Desktop she said "12.4
 * gigabytes" — it is 38G. Asked how much storage he had left she said "512
 * gigabytes", which is more than the whole 460Gi disk, of which 27Gi were
 * actually free. Challenged on both, she said "the system provided those
 * numbers, instantly": a fabricated provenance defending a fabricated number.
 * Nothing had been delegated and nothing could be, because a regex in
 * `machineAction.ts` decided what reached the agent, and it decided before she
 * ever saw the turn.
 *
 * So the decision moves to her. She is a small, fast, native-audio model with
 * no filesystem and no clock; the Teminali OS assistant behind her reads and
 * edits files, runs commands, inspects the machine and searches the web. The
 * declaration below is written for the MODEL to read, not for us, and the line
 * doing the real work is the last one: a pause beats a confident wrong figure.
 * The failure above was not a missing capability. It was a model that preferred
 * any answer to a visible gap, and no list of tools fixes that on its own.
 *
 * One declaration, not several. Every one costs tokens in a session whose
 * binding constraint is window, and a single obviously-correct door is easier
 * for a small model to find than a menu it has to choose from.
 *
 * The call is left BLOCKING, which is the SDK default: `behavior` is unset, so
 * the model stops and waits rather than talking over the agent. @google/genai
 * 2.22.0 does expose the alternative — `FunctionDeclaration.behavior`, the
 * `Behavior` enum, and `FunctionResponse.scheduling` / `willContinue` for
 * NON_BLOCKING calls — and it is still not taken, because it would let her keep
 * generating into a turn whose facts have not arrived, which is the exact
 * failure mode above.
 *
 * The pause itself DID turn out to be the problem, and was solved without that
 * knob. `spoken_note` was written here as the answer to it and did not cover
 * it: the stage rendered the line as a toast, so she was silent for the whole
 * agent run. The block now ends the moment the call arrives, with a response
 * carrying no facts at all, and the report comes back afterwards as its own
 * turn. See `assistantHandoff.ts` and DESIGN.md §6.0.20. `spoken_note` is now
 * what its description here has always claimed: a line she actually says.
 */
const ASK_THE_ASSISTANT: FunctionDeclaration = {
  name: "ask_the_assistant",
  description:
    "Ask the Teminali OS assistant, a far more capable agent sitting behind you. " +
    "It can read and edit any file in this workspace, run shell commands, inspect this " +
    "machine and its disks, and search the web for current information. You cannot do any " +
    "of those things yourself. Call it whenever the answer depends on something you have " +
    "not actually been told: file contents, folder sizes, free space, what is installed, " +
    "what changed recently, anything happening on the web, anything about the state of this " +
    "computer. Never guess a number, a path, a version or a date, and never claim a fact " +
    "came from the system when it did not. A wrong specific answer is much worse than a " +
    "pause: the user will happily wait a few seconds, but one confident wrong figure costs " +
    "their trust in everything else you say. When in any doubt, call this.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      task: {
        type: Type.STRING,
        description:
          "The complete instruction to hand to the assistant. It has none of this " +
          "conversation's context, so write a full, self-contained request: not 'how big is " +
          "it' but 'Report the total size of the user's Desktop folder in gigabytes.' " +
          "Include every path, name and detail the user gave you.",
      },
      spoken_note: {
        type: Type.STRING,
        description:
          "One short, natural line you will say out loud while the assistant works, so the " +
          "user is not left in silence. For example 'Let me look.' or 'One second, checking.' " +
          "Keep it to a few words and do not promise a specific answer in it.",
      },
    },
    required: ["task", "spoken_note"],
  },
};

export class GeminiLiveEngine {
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  onMessage: ((msg: any) => void) | null = null;
  /**
   * The one sentence the operator sees about the state of the voice lane —
   * "" when all is well, something actionable otherwise. Fired on every token
   * fetch, which means first connect and every reconnect. The engine reports it
   * because the engine is the only thing that fetches tokens: they are
   * `uses: 1`, so a second fetch anywhere else would spend one for nothing.
   */
  onNote: ((note: string) => void) | null = null;

  /**
   * One turn's latency, emitted when her first audio lands. Separate from
   * `onMessage` so that adding measurement could not change the message union
   * the shell switches on.
   */
  onTiming: ((timing: TurnTiming) => void) | null = null;

  private ai: GoogleGenAI | null = null;
  private session: Session | null = null;
  private connecting = false;

  /** Set by `disconnect()` so a deliberate close does not schedule a reconnect.
      Carried over unchanged from the old protocol manager. */
  explicitlyDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed attempts, cleared the moment a socket opens. The
      ladder in `scheduleReconnect()` is indexed by this and gives up on it. */
  private reconnectAttempts = 0;
  /** Armed by a `goAway`: Google has said when it will hang up, and this is
      the replacement session being built before it does. */
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The handle that turns the next connect into a continuation rather than an
   * introduction.
   *
   * Gemini ends a Live session on its own schedule — a duration cap, a token
   * that has run out its half hour — and until this existed the reconnect that
   * followed opened a session with no memory of the conversation it was
   * replacing, mid-conversation, without saying so. The server hands a fresh
   * handle out repeatedly through a session; only the newest is worth keeping.
   */
  private resumptionHandle: string | null = null;
  /** True while `restartSession()` is tearing one session down to build the
      next: its `onclose` is expected and must not look like a dropped link. */
  private replacingSession = false;

  private model = DEFAULT_MODEL;
  private voice = TEMI_DEFAULT_VOICE;

  /** Running transcripts. Gemini streams both sides as deltas and never resends
      the whole line, so the accumulation has to happen on this side. */
  private inputTranscript = "";
  private outputTranscript = "";

  /** Generation guard — see `sendBargeIn()`. */
  private generation = 0;
  private suppressedGeneration = -1;
  private turnActive = false;

  /**
   * Ids of function calls the model has issued and is still waiting on.
   *
   * It does three jobs, and they are all the same question — is the model still
   * waiting for THIS id. It gates `sendToolResponse()` so an answer is never
   * posted to a call that was cancelled, abandoned or outlived by its session;
   * it holds `turnComplete` back so a turn that pauses for a tool is not
   * committed as if it had finished; and being a set rather than a flag, it is
   * correct if Gemini ever issues two calls in one turn.
   */
  private pendingToolCalls = new Set<string>();

  /**
   * Our own end-of-turn detector, replacing Google's. Fed from
   * `sendAudioChunk` with the same 16 kHz PCM that goes on the wire.
   */
  private readonly endpointer = new MicEndpointer();

  /**
   * The stopwatch, four stamps long. Before this the live lane contained no
   * `Date.now()` at all: the thing he was complaining about was the one thing
   * nothing measured, and two successive opinions about its cause were wrong.
   *
   * `spokeAt` is the last frame we judged to be speech; `committedAt` is when
   * we told Gemini the turn was over; `turnStartedAt` is her first content
   * back; `firstAudioAt` is the first byte of her voice. The number he
   * actually feels is `firstAudioAt - spokeAt`, and `committedAt - spokeAt` is
   * the part this file owns.
   */
  private timing = { spokeAt: 0, committedAt: 0, turnStartedAt: 0, firstAudioAt: 0 };

  /** Is a user-activity bracket open on the wire? */
  private activityOpen = false;
  private activityOpenedAt = 0;
  /** Chunks captured before the bracket opened, oldest first. */
  private readonly prebuffer: Int16Array[] = [];

  private micCarry: Int16Array = new Int16Array(0);
  /** Odd trailing byte of a base64 audio chunk. Gemini's chunks are not
      guaranteed to split on a sample boundary, and one orphaned byte would
      shift every following sample by 8 bits — white noise, not audio. */
  private pcmByteCarry = new Uint8Array(0);
  private upsampleAnchor = 0;

  /**
   * Open a session. No URL argument any more: the address is the SDK's problem
   * and the credential is a token this method fetches for itself.
   */
  async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.session) return;
    this.explicitlyDisconnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connecting = true;

    /**
     * Flipped when this attempt is abandoned, and read by every callback the
     * attempt installs.
     *
     * React StrictMode unmounts and remounts the stage on every development
     * launch, and the stage builds a NEW engine on each mount. The first
     * engine's `connect()` is still in flight when its `disconnect()` runs, so
     * without this its socket finishes opening a moment later and two live
     * sessions stream Temi into the same playback worklet — both of them
     * hearing the microphone, both of them answering.
     */
    let abandoned = false;
    /** True once this attempt's socket has closed. Read exactly once, right
        after the await below, where it means "closed before it was ever
        assigned" — rare, and unrecoverable if ignored. */
    let closedEarly = false;

    try {
      // Every connect spends a fresh token. `uses: 1` and ~30 minutes of life
      // mean the one from the last attempt is already worthless. The timeout is
      // the cafe-wifi guard: the gateway reaches Google to mint, and behind a
      // captive portal that request answers never. Without a deadline here
      // `connecting` stays true for the life of the app and the only way back
      // is a restart.
      const result = await fetchGeminiLiveToken(AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS));
      // The stage went away while the mint was in flight. Say nothing and open
      // nothing: the engine that replaced this one mints its own token and
      // reports its own note.
      if (this.explicitlyDisconnected) return;
      this.onNote?.(describeGeminiLive(result));
      if (!result.ok) {
        this.onError?.(new Error(`${result.reason}: ${result.detail}`));
        // A mint can fail for a reason that fixes itself — no network yet, a
        // gateway still starting, Google refusing one request — and those are
        // retried on the slow ladder. `no-key`, `sdk-unavailable` and `quota`
        // are not: they stay terminal, because a loop over them would bury the
        // note above under something the operator cannot act on.
        if (isRetryableTokenFailure(result.reason)) this.scheduleReconnect(true);
        return;
      }

      if (result.model) this.model = result.model;
      if (result.voice) this.voice = result.voice;

      // v1alpha is not a preference. Ephemeral tokens exist only on that API
      // version, and the SDK defaults to v1beta, where this token is rejected.
      this.ai = new GoogleGenAI({ apiKey: result.token, httpOptions: { apiVersion: "v1alpha" } });

      this.resetStreamState();

      const pending = this.ai.live.connect({
        model: this.model,
        config: {
          // `Modality.AUDIO` is the string "AUDIO"; the enum is used so the
          // SDK's own types accept it.
          responseModalities: [Modality.AUDIO],
          // Native-audio only. She answers the tone as well as the words.
          enableAffectiveDialog: true,
          // Both transcriptions on: they are the only source of the captions,
          // and of the user turns the shell routes as commands.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            // We do our own endpointing. Google's server VAD waits a flat
            // `END_OF_TURN_SILENCE_MS` after he stops, and a measured
            // conversational turn here is a little over three seconds, so that
            // one constant was about half of the wait. `micEndpoint.ts` runs
            // the adaptive endpointer the dictation lane has always used and
            // commits between 600 and 1800 ms depending on how finished the
            // sentence sounds, so `sendAudioChunk` sends `activityEnd` itself.
            //
            // Disabling this is also what makes `activityStart`/`activityEnd`
            // legal to send at all: the SDK rejects them while automatic
            // detection is on. The cost is that `serverContent.interrupted`
            // stops being server-driven, which is why the endpointer's
            // `speech-start` sends `activityStart` rather than being ignored —
            // that is what still interrupts her when he talks over her.
            automaticActivityDetection: { disabled: true },
          },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
          },
          systemInstruction: TEMI_PERSONA,
          // Declared ALONGSIDE `enableAffectiveDialog`, not instead of it.
          // Checked against this repo's own @google/genai 2.22.0 rather than
          // from memory: `LiveConnectConfig` carries `tools?: ToolListUnion`
          // and `enableAffectiveDialog?: boolean` as independent fields, and
          // the native-audio model takes both. Nothing above was traded away
          // for this line.
          tools: [{ functionDeclarations: [ASK_THE_ASSISTANT] }],
          // Ask for a resumption handle, and offer the one we already hold.
          // An empty object is the whole request: it turns
          // `sessionResumptionUpdate` on. With a handle it also says "continue
          // that conversation", which is what makes a reconnect invisible
          // instead of amnesiac. See `resumptionHandle`.
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
        },
        callbacks: {
          onopen: () => {
            if (abandoned) return;
            // A socket that opened is the only proof the ladder is not needed.
            this.reconnectAttempts = 0;
            this.onConnected?.();
          },
          onmessage: (message: LiveServerMessage) => {
            if (abandoned) return;
            try {
              this.handleServerMessage(message);
            } catch (err) {
              this.onError?.(err);
            }
          },
          onerror: (event: ErrorEvent) => {
            if (abandoned) return;
            this.onError?.(event);
          },
          onclose: () => {
            if (abandoned) return;
            closedEarly = true;
            this.session = null;
            if (this.replacingSession) return;
            this.onDisconnected?.();
            if (!this.explicitlyDisconnected) this.scheduleReconnect();
          },
        },
      });

      let session: Session;
      try {
        session = await withTimeout(
          pending,
          CONNECT_TIMEOUT_MS,
          "Gemini Live did not finish opening the session in time.",
        );
      } catch (err) {
        abandoned = true;
        // It may still open, seconds from now, behind a portal that has just
        // let us through. Nothing is listening to it by then, so close it
        // rather than leave a second socket holding the microphone.
        void pending.then(
          (late) => {
            try {
              late.close();
            } catch {
              // Already gone, which is the outcome we wanted.
            }
          },
          () => {
            // The open failed after we stopped waiting. Already reported below.
          },
        );
        throw err;
      }

      // Same StrictMode race as after the mint, one await later: the stage let
      // go while the socket was opening. Close it here or it streams audio for
      // a component that no longer exists.
      if (this.explicitlyDisconnected) {
        abandoned = true;
        try {
          session.close();
        } catch {
          // Already gone.
        }
        return;
      }
      // The socket opened and closed again before this line ran — an auth
      // refusal usually, which arrives as a close rather than a throw.
      // `onclose` has already cleared `this.session` and armed a retry, and
      // assigning a dead session over that would make the retry's
      // `if (this.session) return;` a wedge nothing recovers from.
      if (closedEarly) return;
      this.session = session;
    } catch (err) {
      this.session = null;
      this.onError?.(err);
      if (!this.explicitlyDisconnected && !this.replacingSession) this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Try again, later each time, and eventually stop.
   *
   * The retry goes back through `connect()`, which mints a new token — reusing
   * the spent one would fail every time and look like an outage. That is also
   * why this cannot run forever: at a flat two seconds it minted a single-use
   * token every two seconds for as long as Google kept refusing, which is a
   * quota bill for a lane the operator had already given up on.
   *
   * `slow` picks the token ladder over the socket ladder; see the constants.
   */
  private scheduleReconnect(slow = false) {
    if (this.reconnectTimer || this.explicitlyDisconnected) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      // Stop, and say so. Silence here is the worst of the options: the lane is
      // dead, nothing is coming, and the operator is still talking to it.
      this.onNote?.(RECONNECT_GAVE_UP_NOTE);
      this.onError?.(new Error(`Gemini Live gave up after ${MAX_RECONNECT_ATTEMPTS} attempts.`));
      return;
    }
    // A handle the server has forgotten is refused on every attempt, and from
    // here a refused resume looks exactly like any other failed open. After two
    // tries the next one starts a fresh session instead: losing the history is
    // a cost, never coming back at all is not.
    if (this.reconnectAttempts >= 3) this.resumptionHandle = null;
    const delay = slow
      ? backoffDelayMs(this.reconnectAttempts, TOKEN_RETRY_BASE_MS, TOKEN_RETRY_CAP_MS)
      : backoffDelayMs(this.reconnectAttempts, RECONNECT_BASE_MS, RECONNECT_CAP_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.explicitlyDisconnected) void this.connect();
    }, delay);
  }

  /**
   * Google said it is about to hang up. Build the replacement before it does.
   *
   * `goAway` is the warning ahead of a session Gemini ends itself — a duration
   * cap, or a token that has run its half hour. Reading it is the difference
   * between a seam the operator never notices and a socket that dies
   * mid-sentence and comes back with no memory of the conversation.
   */
  private scheduleGoAwayRestart(timeLeft: string | undefined): void {
    if (this.goAwayTimer || this.explicitlyDisconnected) return;
    this.goAwayTimer = setTimeout(() => {
      this.goAwayTimer = null;
      if (!this.explicitlyDisconnected) void this.restartSession();
    }, goAwayRestartDelayMs(timeLeft));
  }

  disconnect(): void {
    this.explicitlyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.goAwayTimer) {
      clearTimeout(this.goAwayTimer);
      this.goAwayTimer = null;
    }
    this.reconnectAttempts = 0;
    // A deliberate stop ends the conversation. A later `connect()` on this
    // engine starts a new one rather than resuming the session the operator
    // closed.
    this.resumptionHandle = null;
    this.closeSession();
    this.ai = null;
    this.resetStreamState();
  }

  private closeSession() {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.close();
    } catch {
      // A socket that is already gone is the outcome we wanted.
    }
  }

  /**
   * Tear the session down and build a fresh one.
   *
   * Two of the old control messages land here, because in Gemini Live the
   * session *is* the thing they were changing: the voice is fixed at setup and
   * the conversation history is the session's own state. There is no message
   * for either, so the only honest implementation is a new session.
   */
  private async restartSession(): Promise<void> {
    if (this.explicitlyDisconnected) return;
    this.replacingSession = true;
    try {
      this.closeSession();
      this.resetStreamState();
      await this.connect();
    } finally {
      this.replacingSession = false;
    }
  }

  private resetStreamState() {
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.turnActive = false;
    // A call issued by the old session cannot be answered into the new one:
    // the id means nothing there, and the model behind it has no memory of
    // asking. Dropping them here is also the release valve for the wedge
    // described in `sendBargeIn()`.
    this.pendingToolCalls.clear();
    this.micCarry = new Int16Array(0);
    this.pcmByteCarry = new Uint8Array(0);
    this.upsampleAnchor = 0;
    // A bracket belongs to the socket it was opened on. Carried across a
    // reconnect it would leave `activityOpen` true against a session that
    // never saw the `activityStart`, and every turn after it would stream
    // audio Gemini has been told nothing about. The learned pause rhythm is
    // deliberately kept: it is a fact about him, not about the socket.
    this.activityOpen = false;
    this.activityOpenedAt = 0;
    this.prebuffer.length = 0;
    this.endpointer.reset();
    this.endpointer.setTranscript("");
    this.timing = { spokeAt: 0, committedAt: 0, turnStartedAt: 0, firstAudioAt: 0 };
  }

  // ---------------------------------------------------------------- inbound

  private emit(msg: GeminiLiveMessage) {
    this.onMessage?.(msg);
  }

  /**
   * The generation number that content arriving right now belongs to.
   *
   * A turn's generation is minted by `beginTurn()`, on the first content of
   * the turn, so anything asking this from inside `handleServerMessage` is
   * simply told `generation`. The `+ 1` is for the one caller that asks
   * BETWEEN turns: `sendBargeIn()`, which usually fires before the model has
   * produced anything at all and therefore has to condemn a turn that has not
   * started yet. Both want the same answer, so both ask the same question here
   * instead of restating it and drifting apart.
   */
  private incomingGeneration(): number {
    return this.turnActive ? this.generation : this.generation + 1;
  }

  /**
   * Number the turn whose first content has just arrived, and reset the
   * per-turn resampler state that belongs to it. Idempotent within a turn:
   * `turnActive` is the "already minted" flag, and only a turn boundary puts
   * it down again (`turnComplete`, `interrupted`, `resetStreamState()`).
   *
   * Called from every branch that can carry the first thing a turn produces:
   * her words, her voice, her hands. It used to be the audio branch alone, and
   * that left `sendBargeIn()` able to outlive the turn it condemned. Nothing
   * retires a suppression except the counter moving past it, so a condemned
   * turn that produced no audio never advanced the counter, and the
   * suppression sat armed and silenced the NEXT turn instead: a question
   * nobody had barged in on came back mute. That was masked in practice rather
   * than prevented, because `ask_the_assistant` requires a `spoken_note` and a
   * condemned turn therefore almost always had audio in it.
   *
   * The anchor and carry resets stay welded to the mint. They are per-turn
   * resampler state, and the first sample of a new turn has to interpolate up
   * from silence rather than from the last sample of the turn before it.
   * Moving the mint earlier does not move them in any way that matters:
   * nothing between the first word of a turn and its first frame touches
   * either, so the first frame still finds the anchor at zero.
   */
  private beginTurn(): void {
    if (this.timing.turnStartedAt === 0) this.timing.turnStartedAt = Date.now();
    if (this.turnActive) return;
    this.turnActive = true;
    this.generation += 1;
    this.upsampleAnchor = 0;
    this.pcmByteCarry = new Uint8Array(0);
  }

  private handleServerMessage(message: LiveServerMessage) {
    const content = message.serverContent;

    // Both of the next two are TOP-LEVEL fields, and both can ride in on a
    // message whose `serverContent` branch returns early below, so they are
    // read first.

    // The handle that lets the next session continue this conversation instead
    // of introducing itself. `resumable: false` means the server is mid
    // generation and a resume from that point would lose state, so that handle
    // is not kept; every other update replaces the one we hold.
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.newHandle && resumption.resumable !== false) {
      this.resumptionHandle = resumption.newHandle;
    }

    // "I am about to hang up." Gemini ends a Live session on its own schedule,
    // and before this was read the first sign of it was a dead socket
    // mid-sentence followed by a reconnect that had forgotten everything.
    // `timeLeft` is a protobuf duration ("10s"); the replacement is built a
    // second before the stated end, or at once when the server does not say.
    if (message.goAway) {
      this.scheduleGoAwayRestart(message.goAway.timeLeft);
    }

    // Read before the `interrupted` branch below, which returns early. Gemini
    // cancels outstanding calls exactly when the user talks over her, so a
    // cancellation and an interrupt can ride in on the same message; handling
    // it second would leave the id pending and let a late `sendToolResponse()`
    // through.
    //
    // Nothing is emitted to the stage. It may well have an agent run in flight
    // for this id and it should let that finish — killing real work because the
    // user changed the subject is worse than wasting it. What must not happen
    // is the answer going back: the model has stopped waiting, it is already
    // generating the next turn, and a response arriving now would be read as
    // the answer to a question nobody asked.
    const cancelledIds = message.toolCallCancellation?.ids;
    if (cancelledIds?.length) {
      for (const id of cancelledIds) this.pendingToolCalls.delete(id);
    }

    // Server-side barge-in: its VAD heard the user over her. Drop everything
    // still queued, because the audio already in the worklet is a reply to a
    // sentence the user has stopped waiting for.
    if (content?.interrupted) {
      this.upsampleAnchor = 0;
      this.pcmByteCarry = new Uint8Array(0);
      this.turnActive = false;
      // Same reasoning as the cancellation above, for the case where the server
      // interrupts without naming ids. An interrupted turn is over; a tool call
      // that belonged to it has nowhere to land.
      this.pendingToolCalls.clear();
      this.emit({ type: "tts_interrupt" });
      return;
    }

    const inputText = content?.inputTranscription?.text;
    if (inputText) {
      this.inputTranscript += inputText;
      // What he has said so far is how the endpointer sizes its wait: a
      // sentence that already parses as finished is committed sooner than
      // one still hanging on "and".
      this.endpointer.setTranscript(this.inputTranscript);
      this.emit({ type: "partial_user_request", content: this.inputTranscript });
    }

    const outputText = content?.outputTranscription?.text;
    if (outputText) {
      // Her words are usually the first content of a turn, so this is usually
      // where its generation is minted. See `beginTurn()`.
      //
      // Before `finalizeUserTurn()` and not after, because that emit RE-ENTERS
      // this engine: the stage answers `final_user_request` synchronously and
      // several of those paths call `sendBargeIn()`. Either order happens to
      // condemn the right turn today, since `incomingGeneration()` supplies
      // the `+ 1` an unminted turn needs. Minting first means the re-entrant
      // barge-in names the turn on the wire directly instead, so the two are
      // not left depending on the same arithmetic staying in step.
      this.beginTurn();

      // Her first word is the only proof the user's turn ended. Nothing else in
      // the stream says so — there is no `inputTranscription` terminator — so
      // without this the operator's half of the conversation is never finalised
      // and never reaches the router. It runs above the suppression gate and
      // outside it, deliberately: the operator spoke whether or not we are
      // keeping the reply, and a turn dropped here is lost to the router for
      // good.
      this.finalizeUserTurn();

      // Her WORDS are gated exactly as her audio is, for the same reason and
      // against the same counter. Until this gate existed only the audio had
      // one, so a superseded generation was silent but still became her
      // caption and still went into `final_assistant_answer`. Measured on a
      // live call, 2026-09-12: the shell barged in and answered from the
      // agent's report, and the operator got the single line "It is not
      // something I keep an eye on directly.38 gigabytes.", the abandoned
      // conversational turn and the directed answer accumulated into one
      // string with nothing between them.
      //
      // `incomingGeneration()` and not `this.generation`. By this line
      // `beginTurn()` has run and the two are the same number, so the call is
      // uniformity rather than arithmetic: all three gates in this method ask
      // one question one way, and an edit to one cannot quietly disagree with
      // the others. It is also the form that stays correct if the mint is ever
      // moved back below this branch, which is the arrangement that produced
      // the measured line above.
      if (this.incomingGeneration() !== this.suppressedGeneration) {
        this.outputTranscript += outputText;
        this.emit({ type: "partial_assistant_answer", content: this.outputTranscript });
      }
    }

    // Audio arrives on the SDK fast path as `message.data`; when the SDK does
    // not lift it, it is still down in the model turn's inline parts.
    const chunks: string[] = [];
    if (message.data) chunks.push(message.data);
    else {
      for (const part of content?.modelTurn?.parts || []) {
        if (part?.inlineData?.data) chunks.push(part.inlineData.data);
      }
    }

    if (chunks.length) {
      // First audio of a turn that opened with audio. On every other turn the
      // number is already minted and this costs a flag read.
      this.beginTurn();
      if (this.incomingGeneration() !== this.suppressedGeneration) {
        for (const b64 of chunks) this.emitAudio(b64);
      }
    }

    // She is asking for hands. `toolCall` is a TOP-LEVEL field of the message,
    // not part of `serverContent`, and it can arrive on the same message as the
    // transcript deltas and audio above. Read after them, so the stage sees her
    // spoken note before the call it belongs to; read before `turnComplete`
    // below, which has to know a call is pending on this very message.
    const calls = message.toolCall?.functionCalls;
    if (calls?.length) {
      // Gated on the counter her audio and her words are already gated on, and
      // for a sharper reason than either.
      //
      // `sendBargeIn()` is a LOCAL guard: when the shell answers a turn itself
      // the model carries on server-side, and if that turn was "run the tests"
      // the rules path in `machineAction.ts` has already delegated it by the
      // time she reaches for `ask_the_assistant` to delegate it again. Both
      // land, and THE TESTS RUN TWICE — measured on a live call, and the worst
      // thing in this file to do in front of an audience.
      //
      // `incomingGeneration()` and not `this.generation`, for exactly the
      // reason the transcript gate gives: a tool call usually arrives before
      // any audio of its turn, so the raw counter still names the previous one.
      //
      // A dropped call is not tracked and not emitted, so nothing will answer
      // it. That is the cost `sendBargeIn()` already documents for the calls it
      // abandons: the model is left waiting until the next reconnect or
      // `restartSession()` runs `resetStreamState()`. Waiting is recoverable;
      // running the suite twice on camera is not.
      // A call is content, and on a delegating turn it is frequently the
      // FIRST content: the measured frame order puts `toolCall` ahead of both
      // the audio and the transcript. Minting on it is what keeps a barge-in
      // from outliving the turn it condemned when that turn's only observable
      // output was a pair of hands. See `beginTurn()`.
      this.beginTurn();
      const suppressed = this.incomingGeneration() === this.suppressedGeneration;
      for (const call of calls) {
        // `FunctionCall.name` and `.id` are both optional in the SDK's types.
        // A nameless call is unanswerable — there is nothing to send back a
        // response *for* — so it is dropped rather than forwarded as a task the
        // stage cannot close. An empty id is still tracked and still emitted:
        // Gemini has populated it on every call seen on this API version, and
        // if it ever does not, the server matches a response by name, which is
        // unambiguous in a one-tool session.
        const name = call.name ?? "";
        if (!name) continue;
        if (suppressed) continue;
        const id = call.id ?? "";
        this.pendingToolCalls.add(id);
        this.emit({ type: "tool_call", id, name, args: call.args ?? {} });
      }
    }

    if (content?.turnComplete) {
      // Backstop for a turn she answered with silence: the user's line still
      // has to be finalised or it is lost. This runs even with a call pending —
      // she heard the user either way, and a turn she answered by delegating is
      // the turn whose transcript matters most.
      this.finalizeUserTurn();

      // A turn that ends in a tool call has not ended. The model stops, waits
      // for the response, and then keeps speaking in the SAME turn. Committing
      // here would post "Let me look." as her final answer and hand the router
      // a fragment of a sentence. It would also clear `turnActive`, and that
      // flag is load-bearing for the audio: `beginTurn()` bumps `generation`
      // and resets `upsampleAnchor` / `pcmByteCarry` only when the flag is
      // down. Clear it here and the continuation lands on a new generation,
      // with the anchor back at zero, interpolating its first sample up from
      // silence mid-sentence.
      //
      // Measured since, and on this model the guard never fires. Across 12
      // harness sessions on 2026-09-12 there was exactly ONE `turnComplete`
      // per delegating turn, and it arrived after the function response had
      // been answered and she had stopped speaking. The order every single
      // time: setupComplete, a thought text part, `toolCall` with
      // `turnComplete` false, audio and transcript, `generationComplete`,
      // `turnComplete`. The guard stays because it is the correct handling for
      // a model that does interleave one, not because the question is open,
      // and on this one it costs a set lookup and nothing else.
      if (this.pendingToolCalls.size) return;

      this.turnActive = false;
      const answer = this.outputTranscript;
      this.outputTranscript = "";
      if (answer) {
        // A question means his answer is already on its way, so the next
        // turn commits on a shorter silence. Same rule the dictation lane
        // has always used.
        if (answer.trimEnd().endsWith("?")) this.endpointer.markQuestionAsked();
        this.emit({ type: "final_assistant_answer", content: answer });
      }
    }
  }

  private finalizeUserTurn() {
    if (!this.inputTranscript) return;
    const request = this.inputTranscript;
    this.inputTranscript = "";
    this.endpointer.setTranscript("");
    this.emit({ type: "final_user_request", content: request });
  }

  private emitAudio(b64: string) {
    // The stopwatch reads out here and nowhere else: the first byte of her
    // voice is the moment he stops waiting.
    if (this.timing.firstAudioAt === 0 && this.timing.spokeAt !== 0) {
      this.timing.firstAudioAt = Date.now();
      this.onTiming?.({
        commitMs: this.timing.committedAt - this.timing.spokeAt,
        turnStartMs: Math.max(0, this.timing.turnStartedAt - this.timing.spokeAt),
        firstAudioMs: this.timing.firstAudioAt - this.timing.spokeAt,
        windowMs: this.endpointer.stats.windowMs,
      });
    }
    const incoming = base64ToBytes(b64);

    // Re-attach any half sample left over from the previous chunk before
    // reading Int16s, or the whole stream shifts by a byte.
    let bytes: Uint8Array;
    if (this.pcmByteCarry.length) {
      bytes = new Uint8Array(this.pcmByteCarry.length + incoming.length);
      bytes.set(this.pcmByteCarry, 0);
      bytes.set(incoming, this.pcmByteCarry.length);
      this.pcmByteCarry = new Uint8Array(0);
    } else {
      bytes = incoming;
    }
    const usable = bytes.length - (bytes.length % 2);
    if (usable < bytes.length) this.pcmByteCarry = bytes.slice(usable);
    if (usable === 0) return;

    // PCM16 little-endian, which is what an Int16Array view reads on every
    // platform this app ships to.
    const at24k = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
    const { out, anchor } = upsampleTo48k(at24k, this.upsampleAnchor);
    this.upsampleAnchor = anchor;
    this.emit({ type: "tts_audio", int16: out });
  }

  // --------------------------------------------------------------- outbound

  /**
   * A frame from `voiceAudioEngine`: 8 header bytes, then 2048 Int16 samples at
   * the AudioContext's 48000 Hz. Strip the header, average 3:1 down to the
   * 16000 Hz Gemini insists on, and hand it over as base64.
   *
   * The header is not forwarded. Its flags word told the Python pipeline when
   * our own speaker was live so it could gate its recogniser; Gemini's VAD and
   * echo handling are server-side and want the raw stream.
   */
  sendAudioChunk(buffer: ArrayBuffer): void {
    if (!this.session) return;
    if (buffer.byteLength <= FRAME_HEADER_BYTES) return;

    const samples = new Int16Array(buffer, FRAME_HEADER_BYTES);
    const { out, carry } = downsampleTo16k(samples, this.micCarry);
    this.micCarry = carry;
    if (!out.length) return;

    // The header we do not forward is still worth reading. Its flags word says
    // whether our own speaker was live when this batch was captured, which is
    // exactly the `ducked` signal the detector needs, and it is per frame
    // rather than per event: a start/stop callback can only ever be right
    // about the frames after it.
    this.endpointer.setDucked((new DataView(buffer).getUint32(4, false) & 1) === 1);

    const events = this.endpointer.push(out, MIC_RATE);
    const started = events.some((event) => event.type === "speech-start");
    const ended = events.find((event) => event.type === "speech-end" || event.type === "discarded");

    if (started && !this.activityOpen) this.openActivity();

    // Audio only flows inside an open bracket. Before one opens it goes to the
    // prebuffer, because the detector cannot call speech-start until it has
    // heard the onset — three voiced frames plus a window to see them in, a
    // little over 90 ms. Sent bare, that onset would fall outside the bracket
    // and his first word would go missing. Held, it arrives immediately after
    // `activityStart`, in order, and nothing is lost.
    if (this.activityOpen) this.sendPcm(out);
    else this.holdPcm(out);

    if (ended) this.closeActivity(this.endpointer.stats.lastVoicedAt);
    else if (this.activityOpen) this.guardAgainstEndlessTurn();
  }

  /**
   * Tell Gemini a turn has begun, and release everything we were holding.
   *
   * With automatic detection off this is also the interrupt: the default
   * `activityHandling` is `START_OF_ACTIVITY_INTERRUPTS`, so this is what cuts
   * her off when he talks over her. The endpointer reports a `speech-start`
   * inside `resumeWindowMs` of an endpoint it already fired as
   * `resumedAfterEndpoint` — he carried on and we called the turn too early —
   * and that lands here too, which is the right answer to being wrong.
   */
  private openActivity(): void {
    if (!this.session || this.activityOpen) return;
    this.activityOpen = true;
    this.activityOpenedAt = Date.now();
    try {
      this.session.sendRealtimeInput({ activityStart: {} });
    } catch (err) {
      this.onError?.(err);
    }
    for (const held of this.prebuffer) this.sendPcm(held);
    this.prebuffer.length = 0;
  }

  /** Tell Gemini the turn is over, and start the stopwatch. */
  private closeActivity(spokeAt: number): void {
    if (!this.session || !this.activityOpen) return;
    this.activityOpen = false;
    this.activityOpenedAt = 0;
    this.timing = {
      spokeAt: spokeAt || Date.now(),
      committedAt: Date.now(),
      turnStartedAt: 0,
      firstAudioAt: 0,
    };
    try {
      this.session.sendRealtimeInput({ activityEnd: {} });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * The failure mode that server VAD used to make impossible.
   *
   * Google always closed a turn eventually. Ours will not if the detector
   * never says he stopped — a fan, a held note, a floor that learned wrong —
   * and the turn would then hang forever with no reply and no error. Same
   * ceiling the dictation lane uses, same helper.
   */
  private guardAgainstEndlessTurn(): void {
    const now = Date.now();
    const stall = endpointStall({
      turnStartedAt: this.activityOpenedAt,
      lastFrameAt: now,
      now,
      maxUtteranceMs: MAX_UTTERANCE_MS,
      frameStallMs: FRAME_STALL_MS,
    });
    if (!stall) return;
    this.onNote?.(ENDPOINT_STALL_NOTE);
    this.endpointer.reset();
    this.closeActivity(now);
  }

  /** Hold a chunk until a bracket opens, keeping only the recent past. */
  private holdPcm(out: Int16Array): void {
    this.prebuffer.push(out);
    while (this.prebuffer.length > PREBUFFER_CHUNKS) this.prebuffer.shift();
  }

  private sendPcm(out: Int16Array): void {
    if (!this.session) return;
    const data = bytesToBase64(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    try {
      this.session.sendRealtimeInput({ audio: { data, mimeType: `audio/pcm;rate=${MIC_RATE}` } });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /** A typed turn. `sendClientContent` is the ordered channel, which is what a
      typed line wants: it lands in context in sequence rather than racing the
      realtime audio stream. */
  sendUserText(text: string): void {
    const line = (text ?? "").trim();
    if (!line || !this.session) return;
    try {
      this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: line }] }], turnComplete: true });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * A line the Teminali OS shell wants spoken now, in Temi's voice: an answer
   * built from the live agent run, or its final report. It is not a user turn,
   * but the model has one way in, so it enters bracketed and the persona is
   * told what the bracket means.
   */
  sendAssistantDirective(text: string): void {
    const line = (text ?? "").trim();
    if (!line || !this.session) return;
    const framed = `[Say this to the user now: ${line}]`;
    try {
      this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: framed }] }], turnComplete: true });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * Is this "user turn" actually our own directive coming back?
   *
   * On the Python lane this was a real defence. `server.py` delivered a
   * directive through `on_final`, the same callback a spoken turn used, so it
   * returned as `final_user_request` and was indistinguishable from speech.
   * That closed a loop: the shell delegated, said "On it.", the directive came
   * back as a user turn, the switch classified it as work and delegated again.
   * Observed 2026-09-10, with the queue filling with identical tasks and the
   * assistant talking to itself.
   *
   * With Gemini Live that specific loop cannot happen: a directive goes in
   * through `sendClientContent` as text, and a text turn produces no
   * `inputTranscription` — only spoken audio does — so it never re-enters as a
   * `final_user_request`. The predicate stays anyway, for two reasons. It is
   * still the correct guard if a bracketed line ever reaches the user turn path
   * by another route, and `tests/voice-directive-echo.test.mjs` pins it as a
   * pure predicate. The regex is unchanged from the version that shipped.
   */
  static isAssistantDirectiveEcho(text: string): boolean {
    return /^\[\s*Say this to the user now\b/i.test((text ?? "").trim());
  }

  /**
   * Stop the reply that is being spoken, because the turn is being answered
   * here instead — a status question, a stop, praise — so two voices never
   * answer one sentence.
   *
   * Gemini Live has no "cancel this generation" message. Be clear about what
   * this therefore is and is not: it is a LOCAL guard. The model may well
   * carry on generating server-side, and we will keep receiving its audio and
   * its transcript; we simply stop forwarding them. The generation counter is
   * what makes that precise: both halves of the superseded generation are
   * dropped, her voice and her words together, and neither half of the next
   * real turn is.
   *
   * If no turn is in flight yet, the barge-in suppresses the NEXT one. That is
   * the common case, not an edge: the shell decides to answer locally the
   * moment the transcript lands, which is before she has said a word.
   */
  sendBargeIn(): void {
    this.suppressedGeneration = this.incomingGeneration();
    // `turnActive` is deliberately NOT cleared here, and that is a fix, not an
    // omission. Clearing it told the next chunk of the SAME turn that it was a
    // new turn, so `beginTurn()` minted it a fresh generation, and a fresh
    // generation is not the one this barge-in condemned: she would carry on
    // speaking over the answer the shell had just given. That was survivable
    // only by accident of who calls this. Every call site is inside the
    // stage's synchronous handling of `final_user_request`, and the engine
    // emits that at her first word, so the flag was usually already down. The
    // accident got narrower still once a turn's generation began at its first
    // CONTENT rather than its first audio, because her first word now raises
    // the flag before the barge-in it triggers can read it.
    //
    // The semantics are the simpler statement of the same thing: a barge-in
    // does not end her turn, it refuses to forward it. The turn ends where it
    // always did, at `turnComplete`, at `interrupted`, or at the reset in
    // `resetStreamState()` when the session is replaced.
    this.outputTranscript = "";
    this.upsampleAnchor = 0;
    this.pcmByteCarry = new Uint8Array(0);
    // Abandon anything the assistant is still working on for her.
    //
    // A call in flight when the shell barges in belongs to a question the user
    // has stopped waiting for. By the time the agent reports back, the operator
    // has been answered here and has usually said something else. Delivering
    // the result then would resume the superseded turn inside the new one, and
    // the generation counter cannot reach that far. It now gates both halves of
    // a turn, the audio and the transcript alike, so nothing of the generation
    // this barge-in condemns is heard or captioned. But a continuation spoken
    // after a late function response arrives once a later turn has already
    // started, so it is numbered with that later generation, which nothing has
    // condemned, and it would be heard and read in full. Answering a question
    // nobody is still asking is the same class of failure as inventing the
    // answer, which is what this whole path exists to stop.
    //
    // The honest cost, since this is a LOCAL guard and the server never hears
    // it: the model is left waiting on a call we will never answer, and that
    // half of the turn is wedged until the next `restartSession()` or reconnect
    // runs `resetStreamState()`. That case is narrow. A real barge-in, the user
    // genuinely talking over her, is caught by the server's own VAD, which
    // sends `toolCallCancellation` and clears the model's wait for us. This
    // line only covers the case where the shell decided to answer and the user
    // never spoke at all.
    this.pendingToolCalls.clear();
    this.emit({ type: "tts_interrupt" });
  }

  /**
   * Hand the assistant's answer back to the model, which is mid-turn waiting
   * for it. She then says it in her own words, in her own voice, continuing the
   * sentence she paused rather than reading a report out.
   *
   * `result` is a plain string and goes in under one `result` key. The SDK's
   * own note on `FunctionResponse.response` says that with neither an "output"
   * nor an "error" key present the whole object is treated as the function's
   * output, which is exactly what is wanted here: one field, no schema for a
   * small model to pick apart, just the text to relay.
   *
   * Three ways this drops the response instead of sending it, and they collapse
   * into a single membership test because they are one question — is the model
   * still waiting for THIS id:
   *
   *  - no session, or one torn down under us between the call and the answer.
   *    An agent run takes seconds to minutes and a reconnect inside that window
   *    is ordinary, not exceptional; the new session never asked, and the id
   *    means nothing to it. It drops silently rather than throwing, because
   *    throwing would surface as an error on a run that actually succeeded, and
   *    the stage has no repair to make.
   *  - the server cancelled it (`toolCallCancellation`), which is what Gemini
   *    sends when the user talks over her.
   *  - the shell barged in locally and abandoned it (`sendBargeIn`).
   */
  sendToolResponse(id: string, name: string, result: string): void {
    if (!this.session) return;
    if (!this.pendingToolCalls.has(id)) return;
    this.pendingToolCalls.delete(id);

    const response: { id?: string; name: string; response: Record<string, unknown> } = {
      name,
      response: { result: result ?? "" },
    };
    // An empty id is better omitted than sent as "": with no id the server
    // matches the response to the call by name, which is unambiguous while this
    // session declares one tool. See the `call.id ?? ""` note in the handler.
    if (id) response.id = id;

    try {
      this.session.sendToolResponse({ functionResponses: [response] });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * No-ops, and they stay no-ops.
   *
   * The Python lane used these to gate its own microphone while our speaker was
   * live, because its recogniser would otherwise transcribe Temi. Gemini runs
   * its VAD and its barge-in on the server and expects an unbroken input
   * stream, so telling it about our playback is neither possible nor wanted.
   * They are kept because the consumer calls them on every spoken turn, and
   * deleting them would only move an `if` into the state machine.
   */
  sendTTSStart(): void {}

  /** See `sendTTSStart`. */
  sendTTSStop(): void {}

  /**
   * Gemini Live fixes the voice at session setup; there is no message that
   * changes it mid-session. So this stores the choice and builds a new session
   * with it, which costs a reconnect and a fresh token. The conversation so far
   * is lost with the old session — an honest cost of the model, not a bug here.
   */
  sendVoiceChange(voice: string): void {
    const next = (voice ?? "").trim();
    if (!next || next === this.voice) return;
    this.voice = next;
    // Deliberately NOT resumed, even though a handle is usually held now: the
    // voice is part of the session's setup, and a resumed session restores the
    // setup it was saved with. Keeping the history here risks keeping the old
    // voice with it, which is the one thing this method was called to change.
    this.resumptionHandle = null;
    void this.restartSession();
  }

  /**
   * No-op. The Python lane passed a speed to Kokoro; Gemini's native audio has
   * no rate control, and the persona is where pace is asked for now. Kept
   * because the settings panel still offers the slider to the other lane.
   */
  sendSpeedChange(_speed: number): void {}

  /** The session *is* the history, so clearing it means a new session — and
      dropping the resumption handle with it, since resuming would restore
      exactly the conversation this was asked to forget. */
  sendClearHistory(): void {
    this.resumptionHandle = null;
    void this.restartSession();
  }
}
