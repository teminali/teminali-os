/**
 * Addressee detection — "was that meant for me, or for the person next to you?"
 *
 * There is no clean solution to this; every assistant that attempts it gets it
 * wrong sometimes. What works is refusing to trust any single signal and
 * blending several weak ones into a score, then showing the operator both the
 * score and the reason so a wrong call is obvious and correctable rather than
 * baffling.
 *
 * Five signals, in rough order of reliability:
 *
 *   1. Wake word        — near-certain when present, says nothing when absent.
 *   2. Follow-up window — we just asked a question, so a reply is expected.
 *   3. Speaker match    — is this the enrolled operator at all? (see
 *                         speakerProfile.ts for how weak this genuinely is)
 *   4. Lexical shape    — imperatives, second-person address, workspace nouns.
 *   5. LLM classifier   — the local model reads the utterance in context.
 *
 * Signals 1–4 are free and synchronous. Signal 5 costs a short local
 * generation, so it only runs when 1–4 leave the decision genuinely uncertain.
 */

import type { AddressingVerdict } from "./types";

/** Verbs that usually open a command aimed at a tool, in English and Kiswahili. */
const IMPERATIVE_OPENERS = [
  "open", "close", "run", "build", "fix", "add", "remove", "delete", "create",
  "show", "find", "search", "explain", "write", "make", "change", "update",
  "refactor", "test", "commit", "push", "install", "start", "stop", "restart",
  "check", "read", "list", "generate", "convert", "rename", "move", "copy",
  "undo", "redo", "revert", "deploy", "analyse", "analyze", "summarise",
  "summarize", "translate", "compare", "review",
  "fungua", "funga", "endesha", "tengeneza", "rekebisha", "ongeza", "ondoa",
  "onyesha", "tafuta", "eleza", "andika", "badilisha", "angalia", "soma",
];

/** Nouns that only come up when talking about the workspace. */
const DOMAIN_NOUNS = [
  "file", "folder", "function", "component", "class", "variable", "repo",
  "repository", "branch", "commit", "terminal", "server", "build", "test",
  "error", "bug", "import", "export", "type", "props", "state", "hook",
  "endpoint", "route", "database", "query", "config", "package", "dependency",
  "panel", "tab", "editor", "browser", "canvas", "chat", "prompt", "model",
];

/** Phrases that strongly suggest the operator is talking to a human. */
const THIRD_PARTY_MARKERS = [
  "he said", "she said", "they said", "tell him", "tell her", "tell them",
  "ask him", "ask her", "ask them", "my wife", "my husband", "my friend",
  "hold on", "one second", "one sec", "give me a minute", "i'll call you",
  "call you back", "see you later", "talk to you later", "bye",
  "alisema", "waambie", "mwambie", "subiri", "ngoja", "nitakupigia",
];

export interface AddressingContext {
  /** Was the last assistant turn a question? Raises the prior sharply. */
  assistantAskedQuestion: boolean;
  /** ms since the assistant finished speaking. */
  msSinceAssistantTurn: number;
  /** Speaker match score from speakerProfile, or null if not judged. */
  speakerMatch: number | null;
  /** Whether a profile is enrolled at all. */
  hasProfile: boolean;
  /** Whether the operator asked us to require a wake word. */
  requireWakeWord: boolean;
  requireSpeakerMatch: boolean;
  wakeWords: string[];
  /** Is the app window focused? Weak, but a real signal. */
  windowFocused: boolean;
}

/** How long after our turn a reply still counts as expected. */
const FOLLOW_UP_WINDOW_MS = 9000;

/** Strip a leading wake word so it never reaches the chat as content. */
export function stripWakeWord(text: string, wakeWords: string[]): { text: string; matched: boolean } {
  const trimmed = text.trim();
  for (const word of wakeWords) {
    // "teminali, open the file" / "hey teminali open the file" / "ok teminali…"
    const pattern = new RegExp(`^(hey\\s+|ok(ay)?\\s+|yo\\s+|habari\\s+)?${escape(word)}[\\s,.!:—-]+`, "i");
    if (pattern.test(trimmed)) return { text: trimmed.replace(pattern, "").trim(), matched: true };
    // Trailing form: "open the file, teminali"
    const tail = new RegExp(`[\\s,]+${escape(word)}[\\s.!?]*$`, "i");
    if (tail.test(trimmed)) return { text: trimmed.replace(tail, "").trim(), matched: true };
  }
  return { text: trimmed, matched: false };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The synchronous blend. Returns a verdict plus whether an LLM tiebreak would
 * be worth the latency.
 */
export function scoreAddressing(
  text: string,
  context: AddressingContext,
): { verdict: AddressingVerdict; needsClassifier: boolean } {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  const { matched: wakeWord } = stripWakeWord(text, context.wakeWords);
  const followUpWindow =
    context.assistantAskedQuestion && context.msSinceAssistantTurn < FOLLOW_UP_WINDOW_MS;

  const imperative = words.length > 0 && IMPERATIVE_OPENERS.includes(words[0]);
  const secondPerson = /\b(you|your|you're|yours|wewe|yako)\b/.test(lower);
  const domainHits = DOMAIN_NOUNS.filter((noun) => lower.includes(noun)).length;
  const thirdParty = THIRD_PARTY_MARKERS.some((marker) => lower.includes(marker));

  /* ── Hard gates the operator asked for ────────────────────────────────── */

  if (context.requireWakeWord && !wakeWord && !followUpWindow) {
    return {
      verdict: {
        directed: false,
        confidence: 0.94,
        reason: "No wake word, and wake-word-only mode is on.",
        signals: { wakeWord: false, speakerMatch: context.speakerMatch, followUpWindow, classifier: null, imperative },
      },
      needsClassifier: false,
    };
  }

  if (context.requireSpeakerMatch && context.hasProfile && context.speakerMatch !== null && context.speakerMatch < 0.62) {
    return {
      verdict: {
        directed: false,
        confidence: 0.8,
        reason: `Voice did not match the enrolled profile (${context.speakerMatch.toFixed(2)}).`,
        signals: { wakeWord, speakerMatch: context.speakerMatch, followUpWindow, classifier: null, imperative },
      },
      needsClassifier: false,
    };
  }

  /* ── The blend ────────────────────────────────────────────────────────── */

  // Base rate: most speech picked up by an always-open mic in a shared room is
  // not addressed to the assistant, so we start below the line.
  let score = 0.34;

  if (wakeWord) score += 0.5;
  if (followUpWindow) score += 0.28;
  if (imperative) score += 0.16;
  if (secondPerson) score += 0.08;
  score += Math.min(0.14, domainHits * 0.05);
  if (context.windowFocused) score += 0.05;

  if (thirdParty) score -= 0.42;
  // Very short fragments with no other signal are usually room noise or the
  // tail of someone else's sentence.
  if (words.length <= 2 && !wakeWord && !followUpWindow) score -= 0.2;

  if (context.speakerMatch !== null) {
    // Centre on 0.62: above it adds confidence, below it subtracts. The weight
    // stays modest on purpose — see speakerProfile.ts on how weak this is.
    score += (context.speakerMatch - 0.62) * 0.5;
  }

  score = Math.max(0, Math.min(1, score));

  const reason = wakeWord
    ? "Addressed by name."
    : followUpWindow
      ? "Answering the question just asked."
      : thirdParty
        ? "Sounds like it was meant for someone else."
        : imperative
          ? "Reads as an instruction to the workspace."
          : score >= 0.62
            ? "Matches how you normally address the assistant."
            : "No clear sign it was meant for the assistant.";

  return {
    verdict: {
      directed: score >= 0.62,
      confidence: Math.abs(score - 0.62) * 2.6,
      reason,
      signals: { wakeWord, speakerMatch: context.speakerMatch, followUpWindow, classifier: null, imperative },
    },
    // Only pay for the model when the cheap signals genuinely disagree.
    needsClassifier: score > 0.42 && score < 0.78 && !wakeWord && !thirdParty,
  };
}

/**
 * Prompt for the local tiebreak. Kept deliberately tiny — it must return one
 * token so the round trip stays under a couple of hundred milliseconds.
 */
export function classifierPrompt(text: string, lastAssistantTurn: string): string {
  return [
    "You judge whether a spoken sentence was addressed to a coding assistant or to another person in the room.",
    lastAssistantTurn ? `The assistant last said: "${truncate(lastAssistantTurn, 200)}"` : "The assistant has not spoken recently.",
    `The sentence: "${truncate(text, 400)}"`,
    "",
    "Answer with exactly one word: ASSISTANT if it was addressed to the coding assistant, PERSON if it was addressed to another human, or UNCLEAR.",
  ].join("\n");
}

/** Read the classifier's reply into a signed adjustment, or null if unusable. */
export function parseClassifier(reply: string): number | null {
  const value = reply.trim().toUpperCase();
  if (value.startsWith("ASSISTANT")) return 0.26;
  if (value.startsWith("PERSON")) return -0.34;
  if (value.startsWith("UNCLEAR")) return 0;
  return null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Fold a classifier adjustment back into an existing verdict. */
export function applyClassifier(verdict: AddressingVerdict, adjustment: number): AddressingVerdict {
  // Reconstruct the pre-threshold score, adjust, and re-decide.
  const base = verdict.directed ? 0.62 + verdict.confidence / 2.6 : 0.62 - verdict.confidence / 2.6;
  const score = Math.max(0, Math.min(1, base + adjustment));
  return {
    directed: score >= 0.62,
    confidence: Math.abs(score - 0.62) * 2.6,
    reason:
      adjustment > 0
        ? "The local model read it as an instruction to the assistant."
        : adjustment < 0
          ? "The local model read it as speech aimed at someone else."
          : verdict.reason,
    signals: { ...verdict.signals, classifier: adjustment },
  };
}
