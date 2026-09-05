/**
 * VibeVoice sidecar client.
 *
 * The studio never talks to the speech models directly. It calls the gateway,
 * the gateway calls a loopback sidecar, and the sidecar owns the model weights.
 * That split keeps three properties worth having: the renderer holds no model
 * credentials, audio never leaves the machine, and an operator who has not
 * installed the sidecar still gets a working studio on the browser engine.
 *
 * The sidecar contract is small and deliberately generic, so it can be backed
 * by VibeVoice, whisper.cpp, or anything else that answers these three routes:
 *
 *   GET  /status      -> { asr?: {...}, tts?: {...} }
 *   POST /transcribe  -> multipart audio in, { text, language, ... } out
 *   POST /speak       -> { text, language, voice, rate, stream? } in; audio
 *                        bytes out, or clause frames as they render when
 *                        `stream` was asked for and `/status` offered it
 *
 * Reference implementation and model choices are documented in
 * docs/VOICE_SIDECAR.md.
 *
 * ## The entitlement, and why it downgrades rather than refuses
 *
 * The sidecar tier is `voice.vibevoice`, which every plan carries since
 * 2026-09-05; see licence/entitlements.js for why it stopped being Pro-only.
 * Every function here therefore takes `allowVibeVoice`, and when it is false
 * the sidecar is not probed at all — the request is served by the local
 * engines instead. Not refused: served. The sidecar runs on the user's own
 * machine, so nothing is being rationed except quality, and a paywall that
 * takes away someone's microphone is a worse product than one that hands them
 * the ordinary voice. `/api/voice/status` says which tier they got and names
 * the capability that would raise it, so the UI can offer the upgrade without
 * anything having failed.
 */

import { Readable } from "node:stream";

import { localAsrStatus, localTtsStatus, rankLocalModel, speakLocal, transcribeLocal } from "./speech-local.js";

/**
 * Which engine listens and which one speaks, decided separately.
 *
 * The sidecar's recogniser is `whisper-base`, chosen for its 385 ms on CPU.
 * whisper.cpp on this machine runs `large-v3-turbo` on Metal, and it also
 * takes the vocabulary prompt the sidecar's transformers.js build cannot pass
 * at all (see voice-runtime/lexicon.js). So when both are up, recognition goes
 * to whichever model outranks the other, while synthesis stays with the
 * sidecar's Kokoro, which the local `say` does not match. Before this the
 * sidecar won both jobs outright the moment it answered, which is how a warm
 * 874 MB turbo sat unused behind a 147 MB base.
 *
 * `preference` is the operator's override: "local" or "sidecar" pins
 * recognition regardless of rank.
 *
 * Pure, so the rule is testable without a sidecar or a microphone.
 */
export function chooseEngines({ sidecar = null, localAsr = null, localTts = null, preference = "auto" } = {}) {
  const sidecarAsr = sidecar?.asr ?? null;
  const sidecarTts = sidecar?.tts ?? null;
  const localAsrOk = Boolean(localAsr?.available);
  const localRank = localAsrOk ? (localAsr.rank ?? rankLocalModel(localAsr.modelName)) : -1;
  const sidecarRank = sidecarAsr ? rankLocalModel(sidecarAsr.model) : -1;

  let asr = null;
  if (preference === "sidecar" && sidecarAsr) asr = { source: "sidecar" };
  else if (preference === "local" && localAsrOk) asr = { source: "local" };
  else if (localAsrOk && localRank > sidecarRank) asr = { source: "local" };
  else if (sidecarAsr) asr = { source: "sidecar" };
  else if (localAsrOk) asr = { source: "local" };

  let tts = null;
  if (sidecarTts) tts = { source: "sidecar" };
  else if (localTts?.available) tts = { source: "local" };

  return { asr, tts };
}

function localAsrDescriptor(asr) {
  return {
    model: asr.modelName,
    engine: "whisper.cpp",
    languages: asr.multilingual ? ["auto"] : ["en"],
    streaming: false,
    embedding: false,
    multilingual: asr.multilingual,
    rank: asr.rank,
    detail: asr.detail,
  };
}

function localTtsDescriptor(tts) {
  return {
    model: "macOS system voices",
    engine: "say",
    voices: (tts.voices ?? []).map((voice) => voice.name),
    languages: [...new Set((tts.voices ?? []).map((voice) => voice.language))],
    streaming: false,
  };
}

/**
 * The content type of a streamed `/speak` reply: one frame per rendered
 * clause, defined in docs/VOICE_SIDECAR.md. The gateway never parses it — it
 * relays the bytes as they arrive and lets the studio's player do the reading.
 */
export const SPEECH_STREAM_TYPE = "application/vnd.teminali.speech-stream";

/**
 * Cached probe, so an always-open microphone does not poll a dead port.
 *
 * Keyed by entitlement, because the entitled and unentitled answers are
 * genuinely different documents — one names the sidecar, the other names the
 * local engines. A single slot would serve whichever was asked for first to
 * whoever asked second, so an upgrade would appear not to have taken effect
 * for the length of the TTL.
 */
const statusCache = new Map();
const STATUS_TTL_MS = 15_000;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Node keeps the process alive for a pending timer; this one must not.
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Ask the sidecar what it can do. Never throws: an unreachable sidecar is an
 * ordinary state, not an error, and the answer says so.
 */
export async function voiceStatus(config, { force = false, allowVibeVoice = true } = {}) {
  const now = Date.now();
  const cached = statusCache.get(allowVibeVoice);
  if (!force && cached && now - cached.at < STATUS_TTL_MS) return cached.value;

  // 1. The VibeVoice sidecar, if someone is running one and this plan carries
  //    it. An unentitled caller skips the probe entirely rather than probing
  //    and discarding: the sidecar is a loopback round trip with a timeout, and
  //    spending it to reach an answer already known is just latency.
  let sidecarDetail = null;
  let sidecar = null;
  if (allowVibeVoice) {
    const { signal, done } = timeoutSignal(Math.min(2500, config.voiceTimeoutMs));
    try {
      const response = await fetch(new URL("/status", config.voiceUrl), { signal });
      if (response.ok) {
        const body = await response.json();
        if (body?.asr || body?.tts) {
          sidecar = { asr: body.asr ?? null, tts: body.tts ?? null };
        } else {
          sidecarDetail = "The sidecar reported no speech models.";
        }
      } else {
        sidecarDetail = `The voice sidecar answered ${response.status}.`;
      }
    } catch (error) {
      sidecarDetail =
        error?.name === "AbortError"
          ? "The voice sidecar did not answer in time."
          : `No voice sidecar is listening on ${config.voiceUrl.origin}.`;
    } finally {
      done();
    }
  }

  // What the UI needs to tell the two cases apart: a plan that cannot reach the
  // sidecar, versus a plan that can and found nothing there. Only the first is
  // an upgrade prompt; the second is an install prompt.
  const gated = allowVibeVoice ? null : "voice.vibevoice";

  // 2. Local engines. This is the path that matters in the desktop build: the
  //    browser's own recogniser cannot work inside Electron, so without this
  //    there would be no voice at all.
  const [asr, tts] = await Promise.all([localAsrStatus(), localTtsStatus()]);
  const chosen = chooseEngines({
    sidecar,
    localAsr: asr,
    localTts: tts,
    preference: config.asrEngine ?? "auto",
  });

  if (chosen.asr || chosen.tts) {
    const asrDescriptor =
      chosen.asr?.source === "local"
        ? localAsrDescriptor(asr)
        : chosen.asr?.source === "sidecar"
          ? { engine: "sidecar", ...sidecar.asr }
          : null;
    const ttsDescriptor =
      chosen.tts?.source === "sidecar"
        ? { engine: "sidecar", ...sidecar.tts }
        : chosen.tts?.source === "local"
          ? localTtsDescriptor(tts)
          : null;
    return cache(allowVibeVoice, {
      available: true,
      /* Kept for callers that read one engine name for the whole subsystem.
         `asr.engine` and `tts.engine` are what actually route a request now,
         because the two halves can legitimately come from different places. */
      engine:
        chosen.asr?.source === "sidecar" || chosen.tts?.source === "sidecar" ? "vibevoice" : "local",
      gated,
      sidecarDetail,
      asr: asrDescriptor,
      tts: ttsDescriptor,
      detail: asrDescriptor ? null : (asr.detail ?? sidecarDetail ?? null),
    });
  }

  return cache(allowVibeVoice, {
    available: false,
    engine: null,
    gated,
    detail: asr.detail ?? sidecarDetail ?? "No speech engine is available.",
  });
}

function cache(allowVibeVoice, value) {
  statusCache.set(allowVibeVoice, { at: Date.now(), value });
  return value;
}

/** Drop the probe cache. Called when the entitlement changes under a running gateway. */
export function forgetVoiceStatus() {
  statusCache.clear();
}

/** Forward a recorded utterance for transcription. */
export async function transcribe(config, {
  body, contentType, language = "auto", maxSegmentChars = 0, hints = [], allowVibeVoice = true,
}) {
  const status = await voiceStatus(config, { allowVibeVoice });
  // A sidecar may serve only one of the two capabilities: VOICE_SIDECAR.md
  // says the studio degrades per capability rather than losing voice
  // altogether, so one that advertises no `asr` must not be sent audio.
  // The local engine takes a raw audio buffer, not a multipart envelope.
  // Routed on which engine serves *recognition*, not on the whole-subsystem
  // name: a sidecar serving only Kokoro must not capture the microphone.
  if (!status.asr || status.asr.engine === "whisper.cpp") {
    return transcribeLocal(extractAudio(body, contentType), { language, maxSegmentChars, hints });
  }

  const { signal, done } = timeoutSignal(config.voiceTimeoutMs);
  try {
    const response = await fetch(new URL("/transcribe", config.voiceUrl), {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body,
      signal,
      duplex: "half",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(detail || `Transcription failed (${response.status}).`), {
        status: response.status === 404 ? 503 : response.status,
        code: "VOICE_TRANSCRIBE_FAILED",
      });
    }
    return await response.json();
  } finally {
    done();
  }
}

/**
 * Render text to speech. Answers `{ contentType, body }` with the whole file,
 * or `{ contentType, stream }` when the sidecar was asked to stream and did:
 * the first clause reaches the studio while the last is still rendering, which
 * is the entire point, so the reply is relayed rather than buffered.
 */
export async function speak(config, payload, { allowVibeVoice = true } = {}) {
  const status = await voiceStatus(config, { allowVibeVoice });
  // As in `transcribe`: a sidecar with no `tts` falls back rather than being
  // asked for synthesis it never claimed to offer.
  if (!status.tts || status.tts.engine === "say") {
    const audio = await speakLocal(payload.text, {
      language: payload.language,
      voice: payload.voice,
      rate: payload.rate,
    });
    return { contentType: audio.contentType, body: audio.body };
  }

  const { signal, done } = timeoutSignal(config.voiceTimeoutMs);
  try {
    const response = await fetch(new URL("/speak", config.voiceUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(detail || `Synthesis failed (${response.status}).`), {
        status: response.status === 404 ? 503 : response.status,
        code: "VOICE_SPEAK_FAILED",
      });
    }
    const contentType = response.headers.get("content-type") || "audio/wav";
    if (contentType.startsWith(SPEECH_STREAM_TYPE) && response.body) {
      return { contentType, stream: Readable.fromWeb(response.body) };
    }
    return { contentType, body: Buffer.from(await response.arrayBuffer()) };
  } finally {
    // Clears the guard. The sidecar's headers reach us with its first clause
    // frame (Node holds them until the first write), so the guard bounds the
    // time to the first clause; a stream that is already flowing is bounded by
    // the operator, who can cut it off, not by a timer.
    done();
  }
}

/** Read a bounded request body without buffering an unbounded upload. */
export async function readBounded(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("The audio upload exceeds the allowed size."), {
        status: 413,
        code: "VOICE_AUDIO_TOO_LARGE",
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Pull the audio part out of a multipart body.
 *
 * The renderer posts multipart/form-data because that is what an HTTP file
 * upload looks like, but the local engine wants the bytes. Rather than pulling
 * in a parser for one field, we find the boundary and slice between the headers
 * and the closing delimiter — which is all a single-file multipart body is.
 */
export function extractAudio(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!boundaryMatch) return body;
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);

  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    const headerStart = cursor + boundary.length;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;

    const headers = body.subarray(headerStart, headerEnd).toString("latin1");
    const next = body.indexOf(boundary, headerEnd);
    if (next === -1) break;

    if (/name="audio"/i.test(headers)) {
      // Trailing CRLF belongs to the delimiter, not the file.
      return body.subarray(headerEnd + 4, next - 2);
    }
    cursor = next;
  }
  return body;
}
