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
 * Local whisper.cpp handles recognition on Metal, while synthesis is
 * performed by Metal-accelerated Breeze-TTS-2 (Bella voice).
 *
 * Pure, so the rule is testable without a sidecar or a microphone.
 *
 * `preference` is the operator's override: "local" or "sidecar" pins
 * recognition regardless of rank.
 *
 * Pure, so the rule is testable without a sidecar or a microphone.
 */
export function chooseEngines({ sidecar = null, localAsr = null, localTts = null, breezeTts = null, preference = "auto" } = {}) {
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
  if (breezeTts?.available) tts = { source: "breeze" };
  else if (sidecarTts) tts = { source: "sidecar" };
  else if (localTts?.available) tts = { source: "local" };

  return { asr, tts };
}

export async function breezeTtsStatus(breezeUrl = "http://127.0.0.1:8081") {
  try {
    const res = await fetch(new URL("/v1/voices", breezeUrl), {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        available: true,
        engine: "breeze-server",
        model: data?.tts?.model || "breeze-tts-2-q8_0",
        voices: Array.isArray(data) ? data.map((v) => v.id) : (data?.tts?.voices || ["bella"]),
        streaming: true,
      };
    }
  } catch {}
  return { available: false, detail: "breeze-server is not reachable on port 8081" };
}

export function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const header = Buffer.alloc(44);
  const dataSize = pcmBuffer.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * numChannels * bitDepth) / 8, 28);
  header.writeUInt16LE((numChannels * bitDepth) / 8, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export async function speakViaBreeze(text, { voice = "bella", breezeUrl = "http://127.0.0.1:8081" } = {}) {
  const form = new FormData();
  form.append("text", text);
  form.append("voice_id", voice || "bella");
  form.append("instruction", "Speak clearly with a warm natural Italian cadence.");

  const response = await fetch(new URL("/v1/audio/speech", breezeUrl), {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Breeze TTS failed (${response.status})`), {
      status: response.status,
      code: "BREEZE_TTS_FAILED",
    });
  }

  const rawPcm = Buffer.from(await response.arrayBuffer());
  const wav = pcmToWav(rawPcm, 24000, 1, 16);
  return { contentType: "audio/wav", body: wav };
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
 * clause. The gateway relays the bytes as they arrive.
 */
export const SPEECH_STREAM_TYPE = "application/vnd.teminali.speech-stream";

const statusCache = new Map();
const STATUS_TTL_MS = 15_000;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Ask the local voice subsystem what it can do. Never throws: an unreachable
 * server is an ordinary state, not an error, and the answer says so.
 */
export async function voiceStatus(config, { force = false, allowVibeVoice = true } = {}) {
  const now = Date.now();
  const cached = statusCache.get(allowVibeVoice);
  if (!force && cached && now - cached.at < STATUS_TTL_MS) return cached.value;

  const gated = allowVibeVoice ? null : "voice.vibevoice";

  const [asr, tts, breeze] = await Promise.all([
    localAsrStatus(),
    localTtsStatus(),
    allowVibeVoice ? breezeTtsStatus(config.voiceUrl) : Promise.resolve({ available: false }),
  ]);

  const chosen = chooseEngines({
    sidecar: null,
    localAsr: asr,
    localTts: tts,
    breezeTts: breeze,
    preference: config.asrEngine ?? "auto",
  });

  if (chosen.asr || chosen.tts) {
    const asrDescriptor =
      chosen.asr?.source === "local"
        ? localAsrDescriptor(asr)
        : null;
    const ttsDescriptor =
      chosen.tts?.source === "breeze"
        ? {
            model: "breeze-tts-2-q8_0",
            engine: "breeze-server",
            voices: breeze.voices ?? ["bella"],
            languages: ["it", "en"],
            streaming: true,
          }
        : chosen.tts?.source === "local"
          ? localTtsDescriptor(tts)
          : null;

    return cache(allowVibeVoice, {
      available: true,
      engine: chosen.tts?.source === "breeze" ? (allowVibeVoice ? "vibevoice" : "local") : "local",
      gated,
      sidecarDetail: null,
      asr: asrDescriptor,
      tts: ttsDescriptor,
      detail: asrDescriptor ? null : (asr.detail ?? null),
    });
  }

  return cache(allowVibeVoice, {
    available: false,
    engine: null,
    gated,
    detail: asr.detail ?? "No speech engine is available.",
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
  return transcribeLocal(extractAudio(body, contentType), { language, maxSegmentChars, hints });
}

/**
 * Render text to speech using Breeze-TTS-2 C++.
 * Relays streaming replies as they arrive, or returns audio/wav buffers.
 */
export async function speak(config, payload, { allowVibeVoice = true } = {}) {
  const status = await voiceStatus(config, { allowVibeVoice });

  if (config.voiceUrl?.port === "8081" && !payload.stream) {
    return speakViaBreeze(payload.text, {
      voice: payload.voice || "bella",
      breezeUrl: config.voiceUrl,
    });
  }

  // Relay path for streaming or mock test servers
  const { signal, done } = timeoutSignal(config.voiceTimeoutMs);
  try {
    const response = await fetch(new URL("/speak", config.voiceUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (response.ok) {
      const contentType = response.headers.get("content-type") || "audio/wav";
      if (contentType.startsWith(SPEECH_STREAM_TYPE) && response.body) {
        return { contentType, stream: Readable.fromWeb(response.body) };
      }
      return { contentType, body: Buffer.from(await response.arrayBuffer()) };
    }
  } catch (err) {
    if (status.tts?.engine === "breeze-server") {
      return await speakViaBreeze(payload.text, {
        voice: payload.voice || "bella",
        breezeUrl: config.voiceUrl,
      });
    }
    throw err;
  } finally {
    done();
  }

  if (status.tts?.engine === "say") {
    const audio = await speakLocal(payload.text, {
      language: payload.language,
      voice: payload.voice,
      rate: payload.rate,
    });
    return { contentType: audio.contentType, body: audio.body };
  }

  throw Object.assign(new Error("No TTS engine is available. Breeze-server is required on port 8081."), {
    status: 503,
    code: "VOICE_SPEAK_FAILED",
  });
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
