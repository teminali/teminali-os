/**
 * Splitting an assistant reply into prose and code.
 *
 * The chat renders fenced code as cards rather than inline blocks, so the
 * message has to be cut apart before rendering. Kept pure and separate from the
 * component so the parsing can be tested without a DOM.
 */

export interface Segment {
  kind: "prose" | "code";
  text: string;
  language?: string;
  /** Set when the fence info string names a file rather than a language. */
  filename?: string;
}

/** Info strings that name a file: they contain a dot or a path separator. */
function looksLikePath(info: string): boolean {
  return /[./]/.test(info) && !/^[a-z]+$/i.test(info);
}

export function segment(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(markdown)) !== null) {
    if (match.index > cursor) {
      const prose = markdown.slice(cursor, match.index);
      if (prose.trim()) segments.push({ kind: "prose", text: prose });
    }

    // "```tsx", "```tsx src/App.tsx" and "```src/App.tsx" all occur in practice.
    const info = match[1].trim();
    const parts = info.split(/\s+/).filter(Boolean);
    const filename = parts.find(looksLikePath);
    const language = parts.find((part) => !looksLikePath(part));

    segments.push({
      kind: "code",
      text: match[2].replace(/\n$/, ""),
      language: language ?? (filename ? (filename.split(".").pop() ?? "text") : "text"),
      ...(filename ? { filename } : {}),
    });
    cursor = fence.lastIndex;
  }

  if (cursor < markdown.length) {
    const tail = markdown.slice(cursor);
    if (tail.trim()) segments.push({ kind: "prose", text: tail });
  }
  return segments;
}
