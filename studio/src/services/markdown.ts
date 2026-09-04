/**
 * Inline markdown tokenizer and HTML→markdown conversion for the chat surface.
 *
 * Kept free of React so both are unit-testable, and free of innerHTML so no
 * model or clipboard content can inject markup.
 */

export type InlineToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "boldItalic"; value: string }
  | { type: "strike"; value: string }
  | { type: "link"; value: string; href: string };

// Inline code is matched first so ``**not bold**`` stays literal.
const INLINE_PATTERN = new RegExp(
  [
    "(`[^`\\n]+`)",                        // code
    "(\\*\\*\\*[^*\\n]+\\*\\*\\*)",        // bold + italic
    "(\\*\\*[^*\\n]+\\*\\*)",              // bold
    "(~~[^~\\n]+~~)",                      // strikethrough
    "(\\*[^*\\n]+\\*)",                    // italic
    // Intraword underscores are not emphasis (CommonMark): a filename like
    // mature_romance_comic_skill_v3.zip must survive as text, not turn into
    // three italic runs with the underscores eaten.
    "((?<![A-Za-z0-9_])_[^_\\n]+_(?![A-Za-z0-9_]))",
    "(\\[[^\\]\\n]*\\]\\([^)\\s]+\\))",    // link
    "(https?://[^\\s<>()]+)",              // bare url
  ].join("|"),
  "g",
);

/** Only schemes that cannot execute script are allowed to become links. */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
  return null;
}

export function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.type === "text") previous.value += value;
    else tokens.push({ type: "text", value });
  };

  while ((match = INLINE_PATTERN.exec(input)) !== null) {
    pushText(input.slice(lastIndex, match.index));
    const raw = match[0];

    if (raw.startsWith("`")) {
      tokens.push({ type: "code", value: raw.slice(1, -1) });
    } else if (raw.startsWith("***")) {
      tokens.push({ type: "boldItalic", value: raw.slice(3, -3) });
    } else if (raw.startsWith("**")) {
      tokens.push({ type: "bold", value: raw.slice(2, -2) });
    } else if (raw.startsWith("~~")) {
      tokens.push({ type: "strike", value: raw.slice(2, -2) });
    } else if (raw.startsWith("[")) {
      const split = raw.indexOf("](");
      const href = safeHref(raw.slice(split + 2, -1));
      const label = raw.slice(1, split);
      if (href) tokens.push({ type: "link", value: label || href, href });
      else pushText(raw);
    } else if (/^https?:\/\//i.test(raw)) {
      const href = safeHref(raw);
      if (href) tokens.push({ type: "link", value: raw, href });
      else pushText(raw);
    } else if (raw.startsWith("*") || raw.startsWith("_")) {
      tokens.push({ type: "italic", value: raw.slice(1, -1) });
    } else {
      pushText(raw);
    }

    lastIndex = match.index + raw.length;
  }

  pushText(input.slice(lastIndex));
  return tokens;
}

/* ────────────────────────────────────────────────────────────────
   Clipboard HTML → Markdown
   Pasting from a doc, issue tracker, or web page should keep its
   structure instead of collapsing into one flat line.
   ──────────────────────────────────────────────────────────────── */

const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "BLOCKQUOTE", "PRE", "UL", "OL", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6"]);

function convertNode(node: Node, depth: number, ordinal: { index: number }): string {
  if (node.nodeType === 3) return node.textContent?.replace(/\s+/g, " ") ?? "";
  if (node.nodeType !== 1) return "";

  const element = node as HTMLElement;
  const tag = element.tagName;
  const children = () => Array.from(element.childNodes).map((child) => convertNode(child, depth, { index: 0 })).join("");

  switch (tag) {
    case "BR": return "\n";
    case "HR": return "\n---\n";
    case "STRONG": case "B": {
      const inner = children().trim();
      return inner ? `**${inner}**` : "";
    }
    case "EM": case "I": {
      const inner = children().trim();
      return inner ? `*${inner}*` : "";
    }
    case "DEL": case "S": case "STRIKE": {
      const inner = children().trim();
      return inner ? `~~${inner}~~` : "";
    }
    case "CODE": {
      if (element.closest("pre")) return element.textContent ?? "";
      const inner = element.textContent?.trim() ?? "";
      return inner ? `\`${inner}\`` : "";
    }
    case "PRE": {
      const language = element.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1] ?? "";
      return `\n\`\`\`${language}\n${(element.textContent ?? "").replace(/\n+$/, "")}\n\`\`\`\n`;
    }
    case "A": {
      const href = safeHref(element.getAttribute("href") ?? "");
      const label = children().trim();
      if (!label) return "";
      return href ? `[${label}](${href})` : label;
    }
    case "IMG": {
      const alt = element.getAttribute("alt") ?? "image";
      const source = safeHref(element.getAttribute("src") ?? "");
      return source ? `![${alt}](${source})` : "";
    }
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
      return `\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n`;
    case "BLOCKQUOTE":
      return `\n${children().trim().split("\n").map((line) => `> ${line}`).join("\n")}\n`;
    case "UL": case "OL": {
      const ordered = tag === "OL";
      const counter = { index: 0 };
      const items = Array.from(element.children)
        .filter((child) => child.tagName === "LI")
        .map((child) => {
          counter.index += 1;
          const marker = ordered ? `${counter.index}. ` : "- ";
          const body = convertNode(child, depth + 1, counter).trim();
          return `${"  ".repeat(depth)}${marker}${body}`;
        });
      return `\n${items.join("\n")}\n`;
    }
    case "LI":
      return Array.from(element.childNodes)
        .map((child) => (child.nodeName === "UL" || child.nodeName === "OL"
          ? convertNode(child, depth + 1, ordinal)
          : convertNode(child, depth, ordinal)))
        .join("");
    case "TR":
      return `| ${Array.from(element.children).map((cell) => (cell.textContent ?? "").trim()).join(" | ")} |\n`;
    case "TABLE": {
      const rows = Array.from(element.querySelectorAll("tr"));
      if (rows.length === 0) return "";
      const columns = rows[0].children.length;
      const body = rows.map((row) => convertNode(row, depth, ordinal)).join("");
      const lines = body.trimEnd().split("\n");
      const separator = `|${" --- |".repeat(columns)}`;
      return `\n${lines[0]}\n${separator}\n${lines.slice(1).join("\n")}\n`;
    }
    default: {
      const inner = children();
      return BLOCK_TAGS.has(tag) ? `\n${inner}\n` : inner;
    }
  }
}

/**
 * Converts an HTML clipboard payload into markdown.
 * Returns null when the document yields nothing useful, so the caller can fall
 * back to the plain-text flavour of the same paste.
 */
export function htmlToMarkdown(html: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  let body: HTMLElement | null = null;
  try {
    body = new DOMParser().parseFromString(html, "text/html").body;
  } catch {
    return null;
  }
  if (!body) return null;

  const markdown = Array.from(body.childNodes)
    .map((node) => convertNode(node, 0, { index: 0 }))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return markdown || null;
}

/** True when the text already carries markdown structure worth preserving. */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|)/.test(text)
    || /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(text);
}

/**
 * Pulls just the code out of a model answer so it can be written into a file.
 *
 * A model habitually wraps an edit in prose ("Here's the refactored version:")
 * and a fenced block. Inserting the raw reply puts that prose and the fence
 * markers straight into the user's source file.
 */
export function extractCodeFromResponse(text: string): string {
  if (!text) return "";

  // Prefer fenced blocks; take the longest, which is the real body rather than
  // an inline mention of a symbol.
  const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((match) => match[1]);
  if (fences.length > 0) {
    const best = fences.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), "");
    return best.replace(/\s+$/, "");
  }

  // No fence: drop conversational lead-ins and trailing commentary, keeping the
  // contiguous block that actually looks like code.
  const lines = text.split("\n");
  const isProse = (line: string) =>
    /^\s*(here('s| is)|sure|certainly|of course|this |the above|note:|explanation:|i(')?ve|let me)\b/i.test(line)
    || /[.!?]\s*$/.test(line.trim()) && !/[;{}()\[\]=]/.test(line);

  let start = 0;
  while (start < lines.length && (!lines[start].trim() || isProse(lines[start]))) start += 1;
  let end = lines.length;
  while (end > start && (!lines[end - 1].trim() || isProse(lines[end - 1]))) end -= 1;

  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}
