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
 *   POST /speak       -> { text, language, voice, rate } in, audio bytes out
 *
 * Reference implementation and model choices are documented in
 * docs/VOICE_SIDECAR.md.
 */

import { localAsrStatus, localTtsStatus, speakLocal, transcribeLocal } from "./speech-local.js";

/** Cached probe, so an always-open microphone does not poll a dead port. */
let statusCache = { at: 0, value: null };
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
export async function voiceStatus(config, { force = false } = {}) {
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at < STATUS_TTL_MS) return statusCache.value;

  // 1. The VibeVoice sidecar, if someone is running one.
  const { signal, done } = timeoutSignal(Math.min(2500, config.voiceTimeoutMs));
  let sidecarDetail = null;
  try {
    const response = await fetch(new URL("/status", config.voiceUrl), { signal });
    if (response.ok) {
      const body = await response.json();
      if (body?.asr || body?.tts) {
        return cache({
          available: true,
          engine: "vibevoice",
          asr: body.asr ?? null,
          tts: body.tts ?? null,
        });
      }
      sidecarDetail = "The sidecar reported no speech models.";
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

  // 2. Local engines. This is the path that matters in the desktop build: the
  //    browser's own recogniser cannot work inside Electron, so without this
  //    there would be no voice at all.
  const [asr, tts] = await Promise.all([localAsrStatus(), localTtsStatus()]);
  if (asr.available || tts.available) {
    return cache({
      available: true,
      engine: "local",
      sidecarDetail,
      asr: asr.available
        ? {
            model: asr.modelName,
            engine: "whisper.cpp",
            languages: asr.multilingual ? ["auto"] : ["en"],
            streaming: false,
            embedding: false,
            multilingual: asr.multilingual,
            detail: asr.detail,
          }
        : null,
      tts: tts.available
        ? {
            model: "macOS system voices",
            engine: "say",
            voices: (tts.voices ?? []).map((voice) => voice.name),
            languages: [...new Set((tts.voices ?? []).map((voice) => voice.language))],
            streaming: false,
          }
        : null,
      detail: asr.available ? null : asr.detail,
    });
  }

  return cache({
    available: false,
    engine: null,
    detail: asr.detail ?? sidecarDetail ?? "No speech engine is available.",
  });
}

function cache(value) {
  statusCache = { at: Date.now(), value };
  return value;
}

/** Forward a recorded utterance for transcription. */
export async function transcribe(config, { body, contentType, language = "auto" }) {
  const status = await voiceStatus(config);
  // The local engine takes a raw audio buffer, not a multipart envelope.
  if (status.engine === "local") {
    return transcribeLocal(extractAudio(body, contentType), { language });
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

/** Render text to speech and stream the audio back. */
export async function speak(config, payload) {
  const status = await voiceStatus(config);
  if (status.engine === "local") {
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
    return {
      contentType: response.headers.get("content-type") || "audio/wav",
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
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
