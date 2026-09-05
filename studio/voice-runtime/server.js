/**
 * The loopback speech sidecar. Implements the three routes in
 * `studio/docs/VOICE_SIDECAR.md` so the gateway needs no knowledge of which
 * models are behind them.
 *
 * Capabilities are advertised only once they are warm. A cold `/status` that
 * omits `tts` is not a failure: the gateway reads it as "no synthesis here"
 * and falls back to the local tier, so the operator keeps a voice while the
 * models load instead of waiting on a probe that cannot answer in time.
 */
import { createServer } from "node:http";
import { encodeWav, float32ToPcm16 } from "./audio.js";
import { ASR_LANGUAGES, ASR_MODEL, loadAsr, transcribeClip } from "./asr.js";
import { SOUND_MODEL, loadSounds } from "./sounds.js";
import { SPEECH_STREAM_TYPE, encodeFrame } from "./stream.js";
import { DEFAULT_VOICE, TTS_MODEL, loadTts, listVoices, synthesise, synthesiseClauses } from "./tts.js";

const MAX_AUDIO_BYTES = Number(process.env.TEMINALI_VOICE_MAX_AUDIO_BYTES || 25 * 1024 * 1024);

const warm = { asr: false, tts: false, sounds: false, voices: [DEFAULT_VOICE] };

/** Load both models in the background; the server serves what is ready. */
export async function warmUp({ log = console.error } = {}) {
  const jobs = [
    loadAsr().then(() => { warm.asr = true; log(`[voice] ASR ready: ${ASR_MODEL}`); }),
    loadTts()
      .then(() => listVoices())
      .then((voices) => { warm.voices = voices; warm.tts = true; log(`[voice] TTS ready: ${TTS_MODEL} (${voices.length} voices)`); }),
    // Third and least important: recognition works without it, and a sidecar
    // that never finishes loading it simply never advertises `sounds`.
    loadSounds().then(() => { warm.sounds = true; log(`[voice] sound labels ready: ${SOUND_MODEL}`); }),
  ];
  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === "rejected") log(`[voice] warm-up failed: ${result.reason?.message ?? result.reason}`);
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) {
        reject(Object.assign(new Error("Audio too large."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * The gateway forwards the studio's multipart envelope verbatim, so parse it
 * the same way a browser would. `Response.formData` is undici's parser; it
 * saves a dependency and it is the same code path the platform uses.
 */
async function readAudioPart(body, contentType) {
  if (!contentType?.includes("multipart/form-data")) {
    return { audio: body, language: "auto", sounds: false };
  }
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  const file = form.get("audio");
  if (!file || typeof file === "string") throw Object.assign(new Error("No audio part."), { status: 400 });
  const language = form.get("language");
  const sounds = form.get("sounds");
  return {
    audio: Buffer.from(await file.arrayBuffer()),
    language: typeof language === "string" && language ? language : "auto",
    sounds: sounds === "1" || sounds === "true",
  };
}

/**
 * The streaming form of `/speak`. Headers go out before the first clause is
 * rendered, each clause follows as a frame the moment it is ready, and the
 * render stops when the studio hangs up: a barge-in must not leave the CPU
 * finishing a sentence nobody will hear. Inference holds the event loop, so the
 * closed socket is noticed at the next clause boundary, not instantly; the
 * clause rendered in between is discarded.
 */
async function streamSpeech(response, text, options, log) {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  // Node holds the status line and headers until the first write, so they
  // reach the wire with the first clause; the gateway's timeout covers that.
  response.writeHead(200, { "content-type": SPEECH_STREAM_TYPE, "cache-control": "no-store" });

  let sent = 0;
  try {
    for await (const clause of synthesiseClauses(text, { ...options, signal: controller.signal })) {
      if (controller.signal.aborted) break;
      const header = {
        clause: clause.clause,
        start: clause.start,
        end: clause.end,
        sampleRate: clause.sampleRate,
        samples: clause.samples.length,
      };
      response.write(encodeFrame(header, float32ToPcm16(clause.samples)));
      sent += 1;
    }
    if (controller.signal.aborted) log(`[voice] speak stream cut off by the client after ${sent} clause(s)`);
    else response.write(encodeFrame({ done: true }));
  } catch (error) {
    log(`[voice] POST /speak stream failed after ${sent} clause(s): ${error?.message}`);
    if (!controller.signal.aborted) response.write(encodeFrame({ error: error?.message ?? "Synthesis failed." }));
  }
  response.end();
}

export function createVoiceServer({ log = console.error } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/status") {
        const body = {};
        if (warm.asr) {
          body.asr = { model: ASR_MODEL, languages: ASR_LANGUAGES, streaming: false, embedding: false, sounds: warm.sounds };
        }
        // `streaming` means `/speak` accepts `"stream": true` and answers in
        // clause frames; a whole-file request is still served without it.
        if (warm.tts) body.tts = { model: TTS_MODEL, voices: warm.voices, streaming: true };
        return json(response, 200, body);
      }

      if (request.method === "POST" && url.pathname === "/transcribe") {
        if (!warm.asr) return json(response, 503, { error: "Recognition is still loading." });
        const raw = await readBody(request);
        const { audio, language, sounds } = await readAudioPart(raw, request.headers["content-type"]);
        const result = await transcribeClip(audio, { language, sounds: sounds && warm.sounds });
        if (result.reason) log(`[voice] rejected a clip: ${result.reason} (voiced ${result.voiced.toFixed(2)})`);
        return json(response, 200, {
          text: result.text,
          language: result.language,
          confidence: result.confidence,
          // Present whenever they were asked for, empty list included: the
          // studio needs to tell "nothing was there" from "nobody looked".
          ...(sounds ? { sounds: result.sounds ?? [] } : {}),
        });
      }

      if (request.method === "POST" && url.pathname === "/speak") {
        if (!warm.tts) return json(response, 503, { error: "Synthesis is still loading." });
        const payload = JSON.parse((await readBody(request)).toString("utf8") || "{}");
        if (!payload.text?.trim()) return json(response, 400, { error: "Nothing to speak." });
        const options = { voice: payload.voice || DEFAULT_VOICE, rate: payload.rate };
        if (payload.stream === true) return streamSpeech(response, payload.text, options, log);
        const { samples, sampleRate } = await synthesise(payload.text, options);
        const wav = encodeWav(samples, sampleRate);
        response.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
        return response.end(wav);
      }

      return json(response, 404, { error: "No such route." });
    } catch (error) {
      log(`[voice] ${request.method} ${url.pathname} failed: ${error?.message}`);
      return json(response, error?.status ?? 500, { error: error?.message ?? "Sidecar failure." });
    }
  });
}
