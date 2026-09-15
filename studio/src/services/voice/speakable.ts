/** Opens a bullet or numbered item. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * The label a list item leads with, or null when it does not have one. A bold
 * lead-in is the clearest form; a short plain prefix before a colon counts too,
 * as long as it reads like a label rather than a sentence that happens to
 * contain a colon.
 */
function itemTitle(line: string): string | null {
  const body = line.replace(LIST_MARKER, "").trim();
  const bold = body.match(/^\*\*([^*]{1,60}?)\*\*\s*[:—–-]?(?:\s|$)/);
  if (bold) return bold[1].trim().replace(/[:\s]+$/, "");
  const plain = body.match(/^([^:.!?*`]{1,60}):\s+\S/);
  if (plain) return plain[1].trim();
  return null;
}

/** "a, b and c" — the way a person reads a list out. */
function spokenList(titles: string[]): string {
  if (titles.length === 1) return `${titles[0]}.`;
  const head = titles.slice(0, -1);
  const last = titles[titles.length - 1];
  return titles.length === 2 ? `${head[0]} and ${last}.` : `${head.join(", ")} and ${last}.`;
}

/**
 * Replace each run of list items whose every item is labelled with the labels
 * alone. A run with even one unlabelled item is left as it is: the labels
 * would not then be a faithful index of it, and half a list read aloud is
 * worse than all of it.
 */
function collapseTitledLists(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  /** Items in the run being gathered, each its own lines plus its label. */
  let items: { lines: string[]; title: string | null }[] = [];

  const flush = () => {
    if (items.length === 0) return;
    const titles = items.map((item) => item.title);
    if (items.length >= 2 && titles.every((title): title is string => title !== null)) {
      out.push(spokenList(titles));
    } else {
      for (const item of items) out.push(...item.lines);
    }
    items = [];
  };

  for (const line of lines) {
    if (LIST_MARKER.test(line)) {
      items.push({ lines: [line], title: itemTitle(line) });
      continue;
    }
    // An indented line continues the item above it rather than ending the run.
    if (items.length > 0 && /^\s+\S/.test(line)) {
      items[items.length - 1].lines.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * Turning a written reply into something worth hearing.
 *
 * Reading markdown aloud verbatim is unbearable — a fenced code block becomes a
 * minute of punctuation names. So code is announced rather than recited, and
 * the decoration that only exists for the eye is dropped.
 *
 * A list whose every item is a labelled heading is read as its headings alone.
 * "Video Editing: you can use tools like describe_timeline, patch_clip and
 * set_effect_param…" four times over is a paragraph of identifiers nobody can
 * follow by ear, and the eye has the full text in the chat already. Spoken as
 * the labels it is a list you can actually hold in your head.
 *
 * Deliberately dependency-free: it is pure text in, pure text out.
 */
export function speakableText(markdown: string): string {
  const cleaned = collapseTitledLists(
    // The info string is not just a word. This app's own fences are
    // ```frontier-run and ```html path="outputs/x.html", and a tag pattern of
    // `\w+` matched neither — so the block fell through unrecognised and the
    // reply read the shell command, or the whole file, out loud a character at
    // a time. Take the language word, then allow the rest of the line.
    markdown.replace(/```([\w-]*)[^\n]*\n[\s\S]*?```/g, (_match, lang: string) =>
      lang ? ` — ${lang} code block — ` : " — code block — "),
  )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, ". ")
    // A collapsed list ends in a full stop and the paragraph break adds
    // another; a list introduced by "including:" gets one straight after the
    // colon. Neither is a pause anyone wants read out.
    .replace(/([:;,.!?])\s*\.(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  let stripped = cleaned
    // Strip parenthetical and bracketed narrative stage directions like (Hums a gentle melody), (sings), (laughs), [music playing]
    .replace(/\((?:hums?|sings?|sighs?|laughs?|chuckles?|gasps?|whispers?|coughs?|music\s+playing)[^)]*\)/gi, "")
    .replace(/\[(?:hums?|sings?|sighs?|laughs?|chuckles?|music\s+playing)[^\]]*\]/gi, "")
    .replace(/\*(?:hums?|sings?|sighs?|laughs?|chuckles?)\*/gi, "")
    // Normalize accidental "name dot extension" in speech
    .replace(/\b([a-zA-Z0-9_\-]+)\s+dot\s+(html|css|js|ts|tsx|jsx|json|md|py|sh|png|jpg|mp4|mov|webm|svg)\b/gi, "$1.$2")
    .replace(/\s{2,}/g, " ")
    .trim();

  // If the output was purely a stage direction for humming or singing, vocalize the authentic Italian song
  if (!stripped && /\b(?:hum|sing|melody|song)\b/i.test(cleaned)) {
    stripped = "Nel blu dipinto di blu, felice di stare lassù... Volare, oh-oh! Cantare, oh-oh-oh-oh!";
  }

  return smoothConversationalPunctuation(stripped || cleaned);
}

/** Chunks at or below this many words are read at the base rate. */
export const PACE_SHORT_WORDS = 12;
/** Chunks at or above this many words are read at the full long-form boost. */
export const PACE_LONG_WORDS = 40;
/** How much faster a long chunk is read than a short one, as a multiplier. */
export const PACE_LONG_BOOST = 1.15;

/**
 * The rate to read one chunk at. A short line — an acknowledgement, a status
 * answer — keeps the operator's chosen pace. A long stretch of prose is read
 * faster, ramping to `PACE_LONG_BOOST` times the base by `PACE_LONG_WORDS`
 * words: a listener who already has the gist wants the rest sooner, and a
 * long passage at a slow pace is where a spoken reply starts to drag.
 */
export function paceFor(base: number, text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const span = PACE_LONG_WORDS - PACE_SHORT_WORDS;
  const t = Math.min(1, Math.max(0, (words - PACE_SHORT_WORDS) / span));
  const boosted = base * (1 + (PACE_LONG_BOOST - 1) * t);
  return Math.round(Math.min(2, Math.max(0.5, boosted)) * 100) / 100;
}

/**
 * Smooths conversational punctuation so TTS engines (like Breeze) do not
 * inject artificial 350ms dead-air pauses on commas before conjunctions,
 * after common conversational fillers, or on duplicated punctuation.
 */
export function smoothConversationalPunctuation(text: string): string {
  return text
    // Remove stutter comma before common conversational conjunctions
    .replace(/,\s+(and|but|so|because|then|or|which)\b/gi, " $1")
    // Remove comma after common conversational introductory fillers and adverbs
    .replace(/\b(well|okay|sure|now|first|next|finally),\s+/gi, "$1 ")
    // Collapse multiple consecutive commas/semicolons/colons
    .replace(/[,;]{2,}/g, ",")
    // Collapse multiple periods or ellipsis to a single period
    .replace(/\.{2,}/g, ".")
    // Collapse multiple exclamation marks or question marks
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    // Clean up comma/colon directly following period/question/exclamation
    .replace(/([.!?])\s*[,;:]+/g, "$1");
}

/**
 * For ongoing conversations, converts robotic "today" greetings to natural "now" assistance.
 * "How can I assist you today?" -> "How can I assist you now?"
 */
export function sanitizeOngoingAssist(text: string): string {
  return text
    .replace(/\b([Hh]ow\s+(?:can|may)\s+I\s+assist\s+you\s+)today\b/g, "$1now")
    .replace(/\b([Hh]ow\s+(?:can|may)\s+I\s+help\s+you\s+)today\b/g, "$1now")
    .replace(/\b([Ww]hat\s+can\s+I\s+help\s+you\s+with\s+)today\b/g, "$1now")
    .replace(/\b([Ww]hat\s+can\s+I\s+do\s+for\s+you\s+)today\b/g, "$1now");
}
