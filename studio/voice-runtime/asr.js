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
import { classifySounds } from "./sounds.js";

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
 *
 * `sounds` asks for the AudioSet labels as well as the words. It is opt-in per
 * request because it is the studio's ambient log that wants them, and that log
 * can be switched off; the repair and re-scoring passes ask for words only and
 * should not pay for a classification they will throw away.
 *
 * ## Why only wordless clips are classified
 *
 * Measured on this machine: recognising a 2.5 s utterance takes ~250 ms and
 * classifying the same clip takes ~220 ms, and the two do not overlap — ONNX
 * runs inference synchronously, so an `await` buys nothing and the costs add.
 * Paying it on every clip would put ~220 ms in front of every reply.
 *
 * It buys almost nothing there either. Speech dominates the classifier: the
 * same utterance reads `Speech` at 0.85, and a car underneath a talking person
 * does not clear the reporting threshold, so a spoken clip almost always
 * classifies to nothing at all. The clip where a car *is* the loudest thing is
 * the clip with no words in it — which is exactly the branch that skips
 * recognition and has nothing waiting on it.
 *
 * The cost of the rule: a car that passes while the operator is mid-sentence
 * is not logged. The alternative was a quarter-second on every turn.
 */
export async function transcribeClip(buffer, { language = "auto", sounds = false } = {}) {
  const samples = await decodeToPcm(buffer);
  const durationMs = (samples.length / SAMPLE_RATE) * 1000;
  const voiced = voicedFraction(samples);

  // A classifier failure must never cost the operator their transcript.
  const listen = () => (sounds ? classifySounds(samples).catch(() => []) : Promise.resolve([]));

  // Ask the model nothing when there is nothing to ask about. This is the
  // cheapest guard and it removes the whole class of silence hallucinations.
  //
  // This is also the branch a car drives past on: no words, so no recognition,
  // but the clip is exactly the one worth labelling. Rejecting the transcript
  // must not throw away the sound.
  const preflight = assessAudio({ voicedFraction: voiced, durationMs });
  if (!preflight.accept) {
    return {
      text: "", language, confidence: 0, reason: preflight.reason,
      durationMs, voiced, sounds: await listen(),
    };
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
    // The audio held something the voiced-frame test took for speech, and it
    // turned out not to be: a hallucination the guards caught, or a noise loud
    // enough to look voiced. Either way there are no words, so ask what it was.
    sounds: verdict.text ? [] : await listen(),
  };
}
