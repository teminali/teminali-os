/**
 * Recognition. Whisper through transformers.js, on CPU, with the guards in
 * `transcript-guard.js` standing between the model and the studio.
 *
 * The model is loaded lazily and once: it is tens of megabytes and the first
 * load fetches it from the Hugging Face cache or the network, which must not
 * happen inside a request that a listening operator is waiting on.
 */
import { pipeline } from "@huggingface/transformers";
import { decodeToPcm, voicedFraction, SAMPLE_RATE } from "./audio.js";
import { assessAudio, assessTranscript } from "./transcript-guard.js";

export const ASR_MODEL = process.env.TEMINALI_ASR_MODEL || "onnx-community/whisper-base";
const ASR_DTYPE = process.env.TEMINALI_ASR_DTYPE || "q8";

/**
 * Languages this build advertises. Whisper handles far more, but a language
 * the studio cannot route is not a capability, and Kiswahili is here because
 * it is the second language actually spoken at this machine.
 */
export const ASR_LANGUAGES = [
  "en-US", "en-GB", "sw-TZ", "sw-KE", "fr-FR", "de-DE", "es-ES", "pt-BR",
  "it-IT", "nl-NL", "ar-SA", "hi-IN", "zh-CN", "ja-JP", "ko-KR", "ru-RU",
];

let loading = null;

/** Load the recogniser once; concurrent callers share the same promise. */
export function loadAsr() {
  if (!loading) {
    loading = pipeline("automatic-speech-recognition", ASR_MODEL, {
      dtype: ASR_DTYPE,
      device: "cpu",
    });
  }
  return loading;
}

/** Whisper wants a bare language code, not a BCP-47 tag. */
function whisperLanguage(language) {
  if (!language || language === "auto") return null;
  return language.split("-")[0].toLowerCase();
}

/**
 * Transcribe one recorded utterance.
 *
 * Returns `{ text: "", reason }` rather than throwing when the audio holds no
 * speech: to the studio a rejected clip must be indistinguishable from silence,
 * because the alternative is an assistant that answers the room.
 */
export async function transcribeClip(buffer, { language = "auto" } = {}) {
  const samples = await decodeToPcm(buffer);
  const durationMs = (samples.length / SAMPLE_RATE) * 1000;
  const voiced = voicedFraction(samples);

  // Ask the model nothing when there is nothing to ask about. This is the
  // cheapest guard and it removes the whole class of silence hallucinations.
  const preflight = assessAudio({ voicedFraction: voiced, durationMs });
  if (!preflight.accept) {
    return { text: "", language, confidence: 0, reason: preflight.reason, durationMs, voiced };
  }

  const transcriber = await loadAsr();
  const options = { chunk_length_s: 30, stride_length_s: 5, task: "transcribe" };
  const pinned = whisperLanguage(language);
  if (pinned) options.language = pinned;

  let output;
  try {
    output = await transcriber(samples, options);
  } catch (error) {
    // A language Whisper does not know is a caller error, not a model failure.
    if (pinned && /language/i.test(error?.message ?? "")) {
      output = await transcriber(samples, { ...options, language: undefined });
    } else {
      throw error;
    }
  }

  const verdict = assessTranscript({
    text: Array.isArray(output) ? output.map((part) => part.text).join(" ") : output?.text,
    language,
    voicedFraction: voiced,
    durationMs,
  });

  return {
    text: verdict.text,
    language,
    // The pipeline gives no per-utterance confidence; voiced fraction is the
    // only honest signal available, and saying so beats inventing a number.
    confidence: verdict.accept ? Math.min(1, voiced * 2) : 0,
    reason: verdict.reason,
    durationMs,
    voiced,
  };
}
