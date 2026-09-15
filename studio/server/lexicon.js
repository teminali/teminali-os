/**
 * Domain vocabulary repair.
 *
 * Whisper's decoder in transformers.js takes no `initial_prompt`. The
 * `prompt_ids` field exists on `WhisperGenerationConfig` but the generate()
 * implementation leaves it commented out (node_modules/@huggingface/
 * transformers/src/models.js), and the tokenizer has no `get_prompt_ids`, so
 * the usual way of biasing Whisper toward a project's proper nouns is simply
 * not available to this build.
 *
 * So the bias is applied after the fact. Measured on the synthesised bench in
 * this repo's scratchpad, whisper-base heard the product's own name as
 * "to Minnally", "to Minoli", "timidly" and "terminally". A word the operator says every day should
 * not be a coin toss.
 *
 * The match is phonetic and exact: two spellings collide only when they reduce
 * to the same consonant skeleton. No edit distance, deliberately — "terminal"
 * and "teminali" are one consonant apart, and a repair that rewrites the word
 * an operator actually said is worse than the misrecognition it replaces.
 * Spellings that do not collide are handled by naming them as aliases, which
 * is a claim someone made on purpose rather than a similarity the code guessed.
 */

/**
 * Consonant skeleton. Vowels carry the least information in a Whisper
 * misrecognition, and the sounds that survive are the ones worth comparing.
 */
export function phoneticKey(text) {
  const letters = String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
  if (!letters) return "";
  const folded = letters
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/j/g, "g")
    .replace(/v/g, "f")
    .replace(/w/g, "u")
    .replace(/y/g, "i");
  // Doubling is spelling, not sound: "minnally" and "minali" are the same word
  // to an ear. Collapse before the vowels go.
  let spoken = "";
  for (const ch of folded) if (ch !== spoken.at(-1)) spoken += ch;
  return [...spoken].filter((ch) => !"aeiou".includes(ch)).join("");
}

/**
 * The terms this studio says out loud. Product and model names, the runtimes,
 * and the words that name a place on disk — the ones a recogniser has never
 * seen in its training text and so will always spell as something else.
 */
export const DOMAIN_TERMS = [
  "Teminali", "Teminali OS", "Frontier", "Breeze", "Whisper", "ONNX",
  "gateway", "studio", "agent-runtime",
  "mcp-runtime", "performance-runtime", "quality-runtime", "visual-runtime",
  "Electron", "npm", "npx", "tsc", "git", "grep", "ripgrep", "ngram",
  "diligence", "AudioSet", "Kiswahili",
];

/**
 * Spellings a recogniser produced for a term whose consonants do not line up.
 * Every entry here was observed, not imagined; the comment says where.
 */
export const DOMAIN_ALIASES = {
  // whisper-base and whisper-small, synthesised bench, utterance path02/ident04.
  // "terminally" is deliberately absent: it reduces to the same skeleton as
  // "terminal", a word this operator says about a shell several times an hour.
  Teminali: ["timidly", "to minnally", "to minoli", "to minally"],
  // whisper-base, utterance ident03
  ngram: ["and gram", "n gram"],
};

/**
 * An alias may not be a word English already uses. whisper-base hears "git" as
 * "get", but a lexicon that rewrites every spoken "get" into "git" would do
 * more damage in an hour than the misrecognition does in a week. Repairs are
 * for words the language does not otherwise have.
 */
export const MIN_KEY_LENGTH = 3;

/**
 * Build the lookup. Keys are phonetic; the value is the spelling to restore.
 * A term whose key collides with an earlier term is dropped rather than
 * overwriting it — an ambiguous repair is not a repair.
 */
export function buildLexicon(terms = DOMAIN_TERMS, aliases = DOMAIN_ALIASES) {
  const lexicon = new Map();
  const ambiguous = new Set();
  const claim = (phrase, canonical) => {
    const key = phoneticKey(phrase);
    if (!key || key.length < MIN_KEY_LENGTH) return;
    const held = lexicon.get(key);
    if (held && held !== canonical) { ambiguous.add(key); return; }
    lexicon.set(key, canonical);
  };
  for (const term of terms) claim(term, term);
  for (const [canonical, spellings] of Object.entries(aliases)) {
    for (const spelling of spellings) claim(spelling, canonical);
  }
  for (const key of ambiguous) lexicon.delete(key);
  return lexicon;
}

/**
 * Extra vocabulary from the environment: the folder and project names that
 * belong to this machine and to no other. Comma or newline separated.
 */
export function vocabularyFromEnv(value = process.env.TEMINALI_ASR_VOCABULARY) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

const MAX_WINDOW = 3;

/**
 * Rewrite the phrases in `text` that a domain term explains.
 *
 * Windows of one to three words are tried longest-first, so "to Minoli Code"
 * resolves to "Teminali OS" rather than leaving "Code" stranded. Punctuation
 * riding on a word is carried through; a term that already matches its own
 * canonical spelling is left exactly as the model wrote it, capital letters
 * and all.
 */
export function repairVocabulary(text, lexicon = buildLexicon()) {
  const source = String(text ?? "");
  if (!source.trim() || lexicon.size === 0) return source;
  const tokens = source.split(/(\s+)/);
  const words = [];
  for (let i = 0; i < tokens.length; i += 2) words.push({ raw: tokens[i], gap: tokens[i + 1] ?? "" });

  const out = [];
  for (let i = 0; i < words.length; ) {
    let matched = false;
    for (let span = Math.min(MAX_WINDOW, words.length - i); span >= 1 && !matched; span--) {
      const window = words.slice(i, i + span);
      // Trailing punctuation belongs to the sentence, not to the term.
      const lead = window[0].raw.match(/^\W*/)[0];
      const tail = window[span - 1].raw.match(/\W*$/)[0];
      const phrase = window.map((w) => w.raw).join(" ");
      const canonical = lexicon.get(phoneticKey(phrase));
      if (!canonical) continue;
      const already = phrase.slice(lead.length, phrase.length - tail.length || undefined);
      const settled = already.toLowerCase() === canonical.toLowerCase();
      out.push({ raw: settled ? phrase : `${lead}${canonical}${tail}`, gap: window[span - 1].gap });
      i += span;
      matched = true;
    }
    if (!matched) { out.push(words[i]); i += 1; }
  }
  return out.map((w) => w.raw + w.gap).join("");
}
