/**
 * What stops a recogniser inventing speech.
 *
 * Whisper is a generative model. Handed silence, hiss, a cough or a passing
 * car it does not return nothing; it returns its best guess at what a human
 * would have said, and with no language pinned it will happily guess in a
 * language nobody in the room speaks. That is the failure the operator hit on
 * 2026-09-05: a session that produced Devanagari, then "Hanna, hanna, hanna,
 * hanna, hanna, hanna", then a line of Arabic that is not a sentence.
 *
 * Everything here is a pure function so it can be tested without a model.
 */

/** Unicode blocks, as escapes so this file stays ASCII on disk. */
const SCRIPTS = {
  latin: /[A-Za-z\u00c0-\u024f]/g,
  arabic: /[\u0600-\u06ff\u0750-\u077f]/g,
  devanagari: /[\u0900-\u097f]/g,
  cyrillic: /[\u0400-\u04ff]/g,
  han: /[\u4e00-\u9fff\u3400-\u4dbf]/g,
  kana: /[\u3040-\u30ff]/g,
  hangul: /[\uac00-\ud7af]/g,
  thai: /[\u0e00-\u0e7f]/g,
  hebrew: /[\u0590-\u05ff]/g,
};

/** Languages the studio might reasonably be asked for, by script. */
const LATIN_LANGUAGES = new Set([
  "en", "sw", "fr", "de", "es", "pt", "it", "nl", "sv", "no", "da", "fi",
  "pl", "cs", "tr", "id", "ms", "vi", "ro", "hu", "af", "yo", "ha", "zu",
]);

/**
 * Lines Whisper emits when there is nothing to transcribe. They come from its
 * training data \u2014 subtitle files \u2014 and they are the single most common
 * hallucination. Compared case-insensitively after punctuation is stripped.
 */
export const SILENCE_ARTEFACTS = [
  "thank you", "thanks for watching", "thank you for watching",
  "please subscribe", "like and subscribe", "subscribe to my channel",
  "you", "uh", "um",
  "amara.org", "subtitles by the amara.org community",
  "transcription by castingwords", "\u3054\u89c6\u8074\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3057\u305f",
  "\u5b57\u5e55\u7531 amara.org \u793e\u7fa4\u63d0\u4f9b",
];

/** Strip punctuation and collapse whitespace, for comparisons only. */
function normalise(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** The dominant script of a string, or null when it has no letters. */
export function dominantScript(text) {
  let best = null;
  let bestCount = 0;
  for (const [name, pattern] of Object.entries(SCRIPTS)) {
    const count = (text.match(pattern) ?? []).length;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return bestCount === 0 ? null : best;
}

/**
 * A looping n-gram. "Hanna, hanna, hanna, hanna, hanna, hanna" is the model
 * stuck in a cycle, not a person repeating themselves: a real repetition
 * carries other words with it.
 */
export function isDegenerate(text) {
  const words = normalise(text).split(" ").filter(Boolean);
  if (words.length < 4) return false;

  const unique = new Set(words);
  // Six words with one or two distinct stems is a loop, not a sentence.
  if (words.length >= 5 && unique.size <= Math.max(1, Math.floor(words.length / 4))) return true;

  // A phrase repeated back to back three or more times.
  for (let size = 1; size <= 4; size += 1) {
    if (words.length < size * 3) break;
    let runs = 1;
    for (let start = size; start + size <= words.length; start += size) {
      const previous = words.slice(start - size, start).join(" ");
      const current = words.slice(start, start + size).join(" ");
      if (previous === current) {
        runs += 1;
        if (runs >= 3) return true;
      } else {
        runs = 1;
      }
    }
  }
  return false;
}

/** One of Whisper's stock silence fillers, and nothing else. */
export function isSilenceArtefact(text) {
  const cleaned = normalise(text);
  if (!cleaned) return true;
  return SILENCE_ARTEFACTS.includes(cleaned);
}

/**
 * The transcript is in a script the requested language does not use. This is
 * the Devanagari-and-Arabic failure: language detection latching onto noise.
 * Only enforced when a concrete language was asked for; "auto" means the
 * operator genuinely might switch languages mid-session.
 */
export function isScriptMismatch(text, language) {
  if (!language || language === "auto") return false;
  const base = language.split("-")[0].toLowerCase();
  const script = dominantScript(text);
  if (!script) return false;
  if (LATIN_LANGUAGES.has(base)) return script !== "latin";
  return false;
}

/**
 * The single decision the sidecar makes about a candidate transcript. Returns
 * the text to use, or null with a reason, which is logged but never spoken:
 * a rejected turn must look exactly like silence to the studio, or the
 * operator learns that the assistant argues with the room.
 */
export function assessAudio({
  voicedFraction = 1,
  durationMs = Infinity,
  minVoicedFraction = 0.08,
  minDurationMs = 250,
} = {}) {
  if (durationMs < minDurationMs) return { accept: false, reason: "too-short" };
  if (voicedFraction < minVoicedFraction) return { accept: false, reason: "no-speech" };
  return { accept: true, reason: null };
}

export function assessTranscript({
  text,
  language = "auto",
  voicedFraction = 1,
  durationMs = Infinity,
  minVoicedFraction = 0.08,
  minDurationMs = 250,
}) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { accept: false, reason: "empty", text: "" };
  const audio = assessAudio({ voicedFraction, durationMs, minVoicedFraction, minDurationMs });
  if (!audio.accept) return { accept: false, reason: audio.reason, text: "" };
  if (isDegenerate(trimmed)) return { accept: false, reason: "degenerate", text: "" };
  if (isSilenceArtefact(trimmed)) return { accept: false, reason: "silence-artefact", text: "" };
  if (isScriptMismatch(trimmed, language)) return { accept: false, reason: "script-mismatch", text: "" };
  return { accept: true, reason: null, text: trimmed };
}
