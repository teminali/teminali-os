export interface ParsedWorkspaceEdit {
  path: string;
  content: string;
  complete: boolean;
}

const EDIT_INTENT = /\b(add|build|change|create|edit|fix|implement|modify|refactor|remove|replace|restyle|update|wire)\b/i;
// Conventional single-file homes for a static web scaffold. Deliberately narrow:
// these three are real conventions, so inferring them is not a guess.
const SCAFFOLD_FILENAMES: Record<string, string> = {
  html: "index.html",
  css: "styles.css",
  js: "script.js",
  javascript: "script.js",
};

const CODE_LANGUAGES = new Set(["css", "csv", "go", "html", "java", "javascript", "js", "json", "jsx", "markdown", "md", "mjs", "py", "python", "rb", "rs", "sql", "svg", "toml", "ts", "tsx", "typescript", "xml", "yaml", "yml"]);

function safeRelativePath(value?: string): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^["'`]|["'`]$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");
  if (!normalized || normalized.length > 2_048 || normalized.startsWith("/") || normalized.includes("\0")) return null;
  if (normalized.split("/").some((part) => part === ".." || part === "")) return null;
  return normalized;
}

export function parseWorkspaceEdits(text: string, options: { activePath?: string; userPrompt?: string } = {}): ParsedWorkspaceEdit[] {
  const candidates: Array<ParsedWorkspaceEdit & { explicit: boolean; language: string }> = [];
  const fence = /```([^\n]*)\n([\s\S]*?)(```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const metadata = match[1].trim();
    const language = metadata.split(/\s+/)[0]?.toLowerCase() || "";
    const metadataPath = metadata.match(/\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const positionalPath = metadata.split(/\s+/).slice(1).find((part) => /(?:\/|\.)/.test(part));
    const precedingText = text.slice(Math.max(0, match.index - 240), match.index);
    const precedingCandidates = [...precedingText.matchAll(/(?:^|\n)\s*(?:#{1,6}\s+)?(?:\*\*|`)?([\w@+.,() -]*(?:\/[^\s*`]+)+|[\w@+.,() -]+\.[a-z0-9]+)(?:\*\*|`)?\s*$/gim)];
    const precedingPath = precedingCandidates.at(-1)?.[1]?.trim();
    const headerPath = safeRelativePath(metadataPath?.[1] || metadataPath?.[2] || metadataPath?.[3] || positionalPath || precedingPath);
    let content = match[2];
    const firstLine = content.match(/^\s*(?:(?:\/\/|#)\s*(?:file|path)\s*:\s*([^\s]+)|<!--\s*(?:file|path)\s*:\s*([^>]+?)\s*-->)\s*\n/i);
    const commentPath = safeRelativePath(firstLine?.[1] || firstLine?.[2]);
    if (commentPath && firstLine) content = content.slice(firstLine[0].length);
    const path = headerPath || commentPath;
    candidates.push({ path: path || "", content, complete: match[3] === "```", explicit: Boolean(path), language });
  }

  const explicit = candidates.filter((candidate) => candidate.explicit);
  if (explicit.length > 0) return explicit.map(({ path, content, complete }) => ({ path, content, complete }));

  const activePath = safeRelativePath(options.activePath);
  const editable = candidates.filter((candidate) => CODE_LANGUAGES.has(candidate.language));
  if (activePath && editable.length === 1 && EDIT_INTENT.test(options.userPrompt || "")) {
    const [{ content, complete }] = editable;
    return [{ path: activePath, content, complete }];
  }

  // A scaffold request ("build a landing page") is normally answered with one
  // html/css/js block per file and no path header at all. Without this, every
  // such answer parsed to zero edits and nothing reached disk — the model looked
  // like it had written files when it had only printed them.
  if (EDIT_INTENT.test(options.userPrompt || "") && editable.length > 0) {
    const inferred = editable.map((candidate) => ({
      path: SCAFFOLD_FILENAMES[candidate.language] || "",
      content: candidate.content,
      complete: candidate.complete,
    }));
    // Only commit when every block has a conventional home and no two blocks
    // claim the same one; a repeated language is genuinely ambiguous.
    const paths = inferred.map((edit) => edit.path);
    if (paths.every(Boolean) && new Set(paths).size === paths.length) return inferred;
  }
  return [];
}
