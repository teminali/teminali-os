/**
 * Patterns matching Whisper or other ASR non-speech artifact tokens.
 * These are emitted on silence, room noise, or pauses and should never reach the assistant.
 */
export const BLANK_AUDIO_PATTERN =
  /^\s*[\(\[][^()\[\]]{1,120}[\)\]]\s*$|\[[^\]]*(?:blank[_\s-]*audio|silence|music|clicking|typing|keyboard|applause|laughter|giggle|chuckle|cough|sigh|snort|groan|gasp|throat[_\s-]*clearing|whispering|inaudible|noise|background[_\s-]*noise|ambient|sound|tone|beep|static|screaming|cheering)[^\]]*\]|\([^)]*(?:blank[_\s-]*audio|silence|music|clicking|typing|keyboard|applause|laughter|cough|sigh|inaudible|noise|ambient|sound|tone|beep|static|screaming|cheering|gentle|upbeat|muffled)[^)]*\)|\*[^*]*(?:blank[_\s-]*audio|silence|music|clicking|typing|keyboard|applause|laughter)[^*]*\*|[♪♫♬♩]/gi;

export function cleanTranscript(text: string): string {
  if (!text) return "";
  let cleaned = text.replace(BLANK_AUDIO_PATTERN, " ").replace(/\s{2,}/g, " ").trim();
  // If the entire text was parenthesized or bracketed (e.g. "(upbeat music)", "[keyboard clicking]")
  if (/^\s*[\(\[][^()\[\]]+[\)\]]\s*$/.test(cleaned)) {
    return "";
  }
  // Strip strings that consist solely of standalone punctuation
  cleaned = cleaned.replace(/^[.\s,;!?:—–-]+$/, "").trim();
  return cleaned;
}

export function isNonSpeechOrBlank(text: string): boolean {
  const cleaned = cleanTranscript(text);
  if (cleaned.length === 0) return true;
  // If fewer than 2 letters/numbers, not meaningful speech
  const alphanumeric = cleaned.replace(/[^\p{L}\p{N}]/gu, "");
  if (alphanumeric.length < 2) return true;

  // Known ambient noise descriptions without parentheses
  const lower = cleaned.toLowerCase().trim();
  const ambientPhrases = [
    "keyboard clicking", "upbeat music", "gentle music", "background noise",
    "typing sounds", "mouse clicking", "ambient audio", "only ambient audio",
    "music playing", "blank audio", "silence", "keyboard typing",
    "cough", "coughing", "coughs", "throat clearing", "throat clear",
    "sniffle", "sniffling", "breathing", "heavy breathing", "keyboard clicks",
    "mouse click", "mouse clicks", "clicking", "typing"
  ];
  if (ambientPhrases.some((p) => lower === p || lower === `${p}.`)) {
    return true;
  }
  return false;
}

/**
 * Transcript repair — nothing reaches the chat until it has been cleaned and,
 * optionally, shown back to the operator for approval.
 *
 * Dictating code is where general-purpose recognisers fall apart. They hear
 * "app dot t s x" and write "app dot t s x"; they hear "use effect" and write
 * two words; they punctuate a five-clause instruction as one run-on. Two passes
 * fix this:
 *
 *   Pass 1 (deterministic, instant, offline) — spoken-form rewrites for file
 *   extensions, paths, symbols and shell punctuation, plus filler removal and
 *   de-duplication. Every edit is recorded so the operator can see it.
 *
 *   Pass 2 (local model, optional) — punctuation, casing and grammar on the
 *   remainder, under a prompt that forbids adding or reinterpreting content.
 *   It runs on the same local engine as the chat, so it costs nothing.
 *
 * Pass 1 never changes meaning. Pass 2 can, in principle, which is exactly why
 * the review step exists and why both versions are kept.
 */

import type { RepairKind, RepairedTranscript } from "./types";

interface Rule {
  pattern: RegExp;
  replace: string | ((...args: string[]) => string);
  kind: RepairKind;
}

/* ── Pass 1 rules ─────────────────────────────────────────────────────────── */

const FILE_EXTENSIONS = [
  "tsx", "jsx", "ts", "js", "mjs", "cjs", "json", "css", "scss", "html", "md",
  "py", "rs", "go", "java", "rb", "php", "sh", "yml", "yaml", "toml", "sql",
  "svg", "png", "jpg", "txt", "lock", "env",
];

/** "dot t s x" / "dot tsx" / "point tsx" → ".tsx" */
const extensionRules: Rule[] = FILE_EXTENSIONS.map((ext) => ({
  pattern: new RegExp(`\\b(?:dot|point|full stop)\\s+${ext.split("").join("\\s*")}\\b`, "gi"),
  replace: `.${ext}`,
  kind: "path" as RepairKind,
}));

const RULES: Rule[] = [
  ...extensionRules,

  // Paths and separators.
  { pattern: /\b(?:forward\s+)?slash\b/gi, replace: "/", kind: "path" },
  { pattern: /\bback\s*slash\b/gi, replace: "\\", kind: "path" },
  { pattern: /\bdouble\s+colon\b/gi, replace: "::", kind: "code-term" },
  { pattern: /\bunderscore\b/gi, replace: "_", kind: "code-term" },
  { pattern: /\b(?:dash|hyphen|minus sign)\b/gi, replace: "-", kind: "code-term" },
  { pattern: /\bat sign\b/gi, replace: "@", kind: "code-term" },
  { pattern: /\bhash(?:tag)?\b/gi, replace: "#", kind: "code-term" },
  { pattern: /\bdollar sign\b/gi, replace: "$", kind: "code-term" },
  { pattern: /\bpercent sign\b/gi, replace: "%", kind: "code-term" },
  { pattern: /\bampersand\b/gi, replace: "&", kind: "code-term" },
  { pattern: /\basterisk\b/gi, replace: "*", kind: "code-term" },
  { pattern: /\bpipe (?:symbol|character)\b/gi, replace: "|", kind: "code-term" },
  { pattern: /\bequals sign\b/gi, replace: "=", kind: "code-term" },
  { pattern: /\barrow function\b/gi, replace: "arrow function", kind: "code-term" },
  { pattern: /\bfat arrow\b/gi, replace: "=>", kind: "code-term" },

  // Framework and library names recognisers habitually split or mis-case.
  { pattern: /\buse\s+(effect|state|memo|callback|ref|context|reducer)\b/gi, replace: (_m, h: string) => `use${h[0].toUpperCase()}${h.slice(1).toLowerCase()}`, kind: "code-term" },
  { pattern: /\btype\s*script\b/gi, replace: "TypeScript", kind: "code-term" },
  { pattern: /\bjava\s*script\b/gi, replace: "JavaScript", kind: "code-term" },
  { pattern: /\bnode\s*(?:dot)?\s*js\b/gi, replace: "Node.js", kind: "code-term" },
  { pattern: /\bnext\s*(?:dot)?\s*js\b/gi, replace: "Next.js", kind: "code-term" },
  { pattern: /\breact\s*(?:dot)?\s*js\b/gi, replace: "React", kind: "code-term" },
  { pattern: /\btail\s*wind\b/gi, replace: "Tailwind", kind: "code-term" },
  { pattern: /\bgit\s*hub\b/gi, replace: "GitHub", kind: "code-term" },
  { pattern: /\bpost\s*gres(?:ql)?\b/gi, replace: "Postgres", kind: "code-term" },
  { pattern: /\bmongo\s*d\.?\s*b\b/gi, replace: "MongoDB", kind: "code-term" },
  { pattern: /\bv\s*s\s*code\b/gi, replace: "VS Code", kind: "code-term" },
  { pattern: /(?<![.\w])\bc\s*s\s*s\b/gi, replace: "CSS", kind: "code-term" },
  { pattern: /(?<![.\w])\bh\s*t\s*m\s*l\b/gi, replace: "HTML", kind: "code-term" },
  { pattern: /(?<![.\w])\ba\s*p\s*i\b/gi, replace: "API", kind: "code-term" },
  { pattern: /(?<![.\w])\bu\s*i\b/gi, replace: "UI", kind: "code-term" },
  { pattern: /(?<![.\w])\bc\s*l\s*i\b/gi, replace: "CLI", kind: "code-term" },
  { pattern: /(?<![.\w])\bs\s*d\s*k\b/gi, replace: "SDK", kind: "code-term" },
  { pattern: /(?<![.\w])\bj\s*s\s*o\s*n\b/gi, replace: "JSON", kind: "code-term" },

  // Product names, so the assistant is not asked to fix "terminally studio".
  { pattern: /\bteminali\s+(?:code|studio)\b/gi, replace: "Teminali OS", kind: "model" },
  { pattern: /\bfrontier\s+(auto|flash)\b/gi, replace: (_m, v: string) => `Frontier ${v[0].toUpperCase()}${v.slice(1).toLowerCase()}`, kind: "model" },

  // Shell forms.
  { pattern: /(?<![.\w])\bn\s*p\s*m\b/gi, replace: "npm", kind: "command" },
  { pattern: /\bgit\s+(status|commit|push|pull|diff|log|add|checkout|branch|stash|rebase|merge)\b/gi, replace: (_m, c: string) => `git ${c.toLowerCase()}`, kind: "command" },
  { pattern: /\bcontrol\s+c\b/gi, replace: "Ctrl+C", kind: "command" },
  { pattern: /\bcommand\s+([a-z])\b/gi, replace: (_m, k: string) => `Cmd+${k.toUpperCase()}`, kind: "command" },

  // Dictated punctuation.
  { pattern: /\s*\b(?:comma)\b/gi, replace: ",", kind: "punctuation" },
  { pattern: /\s*\b(?:full stop|period)\b/gi, replace: ".", kind: "punctuation" },
  { pattern: /\s*\bquestion mark\b/gi, replace: "?", kind: "punctuation" },
  { pattern: /\s*\bexclamation (?:mark|point)\b/gi, replace: "!", kind: "punctuation" },
  { pattern: /\bnew line\b/gi, replace: "\n", kind: "punctuation" },
  { pattern: /\bnew paragraph\b/gi, replace: "\n\n", kind: "punctuation" },
];

/** Disfluencies, English and Kiswahili. Removed only when standing alone. */
const FILLERS = [
  "uh", "uhh", "uhm", "um", "umm", "er", "erm", "ah", "eh", "hmm", "mm", "mhm",
  "like i mean", "you know", "i mean", "sort of", "kind of", "basically",
  "actually just", "let me see", "let's see",
  "eeh", "aah", "yaani", "kwa hiyo yaani", "sasa basi",
];

const FILLER_PATTERN = new RegExp(
  `(^|[\\s,.])(?:${FILLERS.map((f) => f.replace(/\s+/g, "\\s+")).join("|")})(?=[\\s,.]|$)`,
  "gi",
);

/**
 * Pass 1. Pure, synchronous, and safe: it only rewrites forms that have a
 * single unambiguous written equivalent.
 */
export function repairDeterministic(raw: string): RepairedTranscript {
  const edits: RepairedTranscript["edits"] = [];
  const cleanedRaw = cleanTranscript(raw);
  if (!cleanedRaw) {
    return {
      raw,
      repaired: "",
      language: "",
      edits: raw.trim() ? [{ from: raw.trim(), to: "", kind: "filler" }] : [],
      clean: false,
    };
  }
  let text = cleanedRaw;

  const record = (kind: RepairKind, before: string, after: string) => {
    if (before !== after) edits.push({ from: before.trim(), to: after.trim(), kind });
  };

  // Recognisers stutter on a dropped connection: "open the the file".
  const deduped = text.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  if (deduped !== text) record("duplicate", text, deduped);
  text = deduped;

  const defilled = text.replace(FILLER_PATTERN, "$1").replace(/\s{2,}/g, " ");
  if (defilled.trim() !== text.trim()) record("filler", text, defilled);
  text = defilled;

  for (const rule of RULES) {
    const before = text;
    text = text.replace(rule.pattern, rule.replace as never);
    if (before !== text) {
      const beforeMatch = before.match(rule.pattern)?.[0] ?? "";
      const afterSample = typeof rule.replace === "string" ? rule.replace : "";
      record(rule.kind, beforeMatch, afterSample || beforeMatch);
    }
  }

  // Tidy the spacing the substitutions leave behind.
  text = text
    .replace(/\s+([,.!?;:])/g, "$1")
    // Only sentence punctuation earns a following space. A dot between two
    // word characters is a filename or a version, not the end of a sentence.
    .replace(/([,;:!?])(?=[^\s\d])/g, "$1 ")
    .replace(/\.(?=[A-Z][a-z])/g, ". ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*\.\s*(?=[a-z]{1,5}\b)/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Sentence case, without touching an identifier that is already cased.
  if (text && /^[a-z]/.test(text) && !/^[a-z]+[A-Z]/.test(text)) {
    const cased = text[0].toUpperCase() + text.slice(1);
    record("capitalisation", text, cased);
    text = cased;
  }

  return {
    raw,
    repaired: text,
    language: "",
    edits,
    clean: edits.length === 0 && text.trim() === raw.trim(),
  };
}

/* ── Pass 2 ───────────────────────────────────────────────────────────────── */

/**
 * The polish prompt. The constraints are the important part: the model may
 * repunctuate and recase, and nothing else. Anything looser and dictation
 * quietly becomes paraphrase.
 */
export function polishPrompt(text: string, language: string, targetLanguage: string | null): string {
  const translate =
    targetLanguage && targetLanguage.split("-")[0] !== language.split("-")[0]
      ? `\nThen translate the result into ${targetLanguage}. Keep all code, identifiers, paths and commands exactly as they are — translate only the prose around them.`
      : "";

  return [
    "You are cleaning up a voice transcription so it can be sent to a coding assistant.",
    "",
    "Rules, all of them strict:",
    "- Fix punctuation, capitalisation and obvious transcription errors.",
    "- Correct misheard technical terms to their real spelling (file names, library names, commands).",
    "- Remove filler words and false starts.",
    "- Do NOT answer the request, add information, or change what is being asked.",
    "- Do NOT add pleasantries or expand abbreviations the speaker used.",
    "- If the transcript is already clean, return it unchanged.",
    "- Return only the cleaned sentence, with no quotes, preamble or explanation.",
    translate,
    "",
    `Transcript: ${text}`,
  ].join("\n");
}

/**
 * Guard against a model that ignores the prompt and answers the question
 * instead of cleaning it. A polish that triples the length, or that shares
 * almost no vocabulary with the input, is rejected in favour of pass 1.
 */
export function polishIsTrustworthy(before: string, after: string): boolean {
  const cleaned = after.trim();
  if (!cleaned) return false;
  if (cleaned.length > before.length * 2.2 + 40) return false;
  if (cleaned.length < before.length * 0.35) return false;
  // Refusals and meta-commentary.
  if (/^(sure|certainly|here('s| is)|i (can|will|would)|okay,)/i.test(cleaned)) return false;
  if (/\n\s*[-*]\s/.test(cleaned) && !/\n\s*[-*]\s/.test(before)) return false;

  const tokens = (value: string) =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const a = tokens(before);
  const b = tokens(cleaned);
  if (a.size === 0) return true;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  // At least a third of the original words must survive.
  return shared / a.size >= 0.34;
}

/** Merge a trusted pass-2 result into the pass-1 record. */
export function withPolish(base: RepairedTranscript, polished: string, translatedFrom?: string): RepairedTranscript {
  if (polished.trim() === base.repaired.trim()) return base;
  return {
    ...base,
    repaired: polished.trim(),
    edits: [
      ...base.edits,
      { from: base.repaired, to: polished.trim(), kind: translatedFrom ? "translation" : "punctuation" },
    ],
    clean: false,
    ...(translatedFrom ? { translatedFrom } : {}),
  };
}
