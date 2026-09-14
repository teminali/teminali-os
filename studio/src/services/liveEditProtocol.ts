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

const NON_EDIT_LANGUAGES = new Set([
  "bash", "sh", "shell", "zsh", "console", "terminal",
  "frontier-run", "frontier-command", "video-tool", "player-tool",
  "ask", "screen",
]);

const SHELL_COMMAND_PREFIX = /^(?:cat|head|tail|grep|sed|awk|wc|rm|python\d*|node|bash|sh|zsh|git|ls|mkdir|touch|chmod|cp|mv|echo)\s+/i;
const SHELL_FLAG_OR_PIPE = /(?:\s-(?:[a-zA-Z0-9]+|-[\w-]+)\b|[;&|<>])/;
const MULTI_FILE_MENTION = /\.[a-z0-9]+\s+.*\.[a-z0-9]+/i;

/**
 * A workspace-relative path, or null when the value is not one.
 *
 * Shared with `agentCommands.pathsReadByCommand` so that a path read on the
 * shell and a path written in an edit block normalise to the same string —
 * without that, `./scripts/deploy.sh` read and `scripts/deploy.sh` written
 * would be two different files to the applier's seen-path guard.
 */
export function normalizeWorkspacePath(value?: string): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^["'`]|["'`]$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");
  if (!normalized || normalized.length > 2_048 || normalized.startsWith("/") || normalized.includes("\0")) return null;
  if (/[<>:*?"|`]/.test(normalized)) return null;
  if (normalized === "." || normalized === "..") return null;
  if (normalized.split("/").some((part) => part === ".." || part === "")) return null;
  if (SHELL_COMMAND_PREFIX.test(normalized) || SHELL_FLAG_OR_PIPE.test(normalized) || MULTI_FILE_MENTION.test(normalized)) return null;
  return normalized;
}

function isLanguageCompatibleWithPath(lang: string, filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  const langMap: Record<string, string[]> = {
    js: ["js", "mjs", "cjs", "jsx"],
    javascript: ["js", "mjs", "cjs", "jsx"],
    ts: ["ts", "tsx"],
    typescript: ["ts", "tsx"],
    html: ["html", "htm"],
    css: ["css", "scss", "less"],
    json: ["json"],
    py: ["py"],
    python: ["py"],
    sql: ["sql"],
    sh: ["sh", "bash"],
    bash: ["sh", "bash"],
    svg: ["svg"],
    md: ["md", "markdown"],
    markdown: ["md", "markdown"],
  };
  return langMap[lang]?.includes(ext) ?? true;
}

export function parseWorkspaceEdits(text: string, options: { activePath?: string; userPrompt?: string } = {}): ParsedWorkspaceEdit[] {
  const candidates: Array<ParsedWorkspaceEdit & { explicit: boolean; language: string }> = [];
  const fence = /```([^\n]*)\n([\s\S]*?)(```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const metadata = match[1].trim();
    // Handle colon notation e.g. ```javascript:app.js or ```js:src/main.js
    const colonMatch = metadata.match(/^([\w-]+):([^\s"']+)/);
    const language = (colonMatch ? colonMatch[1] : metadata.split(/\s+/)[0])?.toLowerCase() || "";
    if (NON_EDIT_LANGUAGES.has(language)) continue;

    const metadataPath = metadata.match(/\b(?:path|file|filename|title)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const bracketMatch = metadata.match(/(?:^|\s+)[(\[]([^\s)\]]+)[)\]]/);
    const positionalPath = colonMatch
      ? colonMatch[2]
      : bracketMatch
        ? bracketMatch[1]
        : metadata.split(/\s+/).slice(1).find((part) => /(?:\/|\.)/.test(part));

    const precedingText = text.slice(Math.max(0, match.index - 240), match.index);
    const precedingCandidates = [...precedingText.matchAll(/(?:^|\n)\s*(?:#{1,6}\s+)?(?:\*\*|`)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)(?:\*\*|`)?:?\s*$/gim)];
    let precedingPath = precedingCandidates.at(-1)?.[1]?.trim();
    if (!precedingPath) {
      // Check for inline backticked or colon-labelled path in recent lines, e.g. "Here is `app.js`:" or "File: app.js"
      const inlineCandidates = [...precedingText.matchAll(/(?:`|(?:\b(?:file|create|update|in|for|edit|path)\b\s*:?\s*(?:\*\*|`)?))([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)(?:`|\*\*|\b)/gi)];
      precedingPath = inlineCandidates.at(-1)?.[1]?.trim();
    }

    const headerPath = normalizeWorkspacePath(metadataPath?.[1] || metadataPath?.[2] || metadataPath?.[3] || positionalPath || precedingPath);
    let content = match[2];
    const firstLine = content.match(/^\s*(?:(?:\/\/|#|\/\*|<!--)\s*(?:(?:file|path|filename)\s*:\s*)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*(?:\*\/|-->)?)\s*\n/i);
    const commentPath = normalizeWorkspacePath(firstLine?.[1]);
    if (commentPath && firstLine) content = content.slice(firstLine[0].length);
    const path = headerPath || commentPath;
    candidates.push({ path: path || "", content, complete: match[3] === "```", explicit: Boolean(path), language });
  }

  const explicit = candidates.filter((candidate) => candidate.explicit && (!candidate.language || isLanguageCompatibleWithPath(candidate.language, candidate.path)));
  if (explicit.length > 0) return explicit.map(({ path, content, complete }) => ({ path, content, complete }));

  const activePath = normalizeWorkspacePath(options.activePath);
  const editable = candidates.filter((candidate) => CODE_LANGUAGES.has(candidate.language));
  if (activePath && editable.length === 1 && EDIT_INTENT.test(options.userPrompt || "") && isLanguageCompatibleWithPath(editable[0].language, activePath)) {
    const [{ content, complete }] = editable;
    return [{ path: activePath, content, complete }];
  }

  const promptFiles = [...((options.userPrompt || "").matchAll(/\b([a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|html|css|json|py|sh|sql|svg|md))\b/gi))].map((m) => m[1]);

  // A scaffold or prompt-driven request: map editable blocks to prompt-mentioned files or conventional names
  if (EDIT_INTENT.test(options.userPrompt || "") && editable.length > 0) {
    const assigned = new Set<string>();
    const inferred = editable.map((candidate) => {
      const target = promptFiles.find((pf) => !assigned.has(pf) && isLanguageCompatibleWithPath(candidate.language, pf));
      if (target) {
        assigned.add(target);
        return { path: target, content: candidate.content, complete: candidate.complete };
      }
      return {
        path: SCAFFOLD_FILENAMES[candidate.language] || "",
        content: candidate.content,
        complete: candidate.complete,
      };
    });
    // Only commit when every block has a conventional home and no two blocks claim the same one
    const paths = inferred.map((edit) => edit.path);
    if (paths.every(Boolean) && new Set(paths).size === paths.length) return inferred;
  }
  return [];
}

/**
 * Whether committing `next` over `base` would be a truncation rather than an edit.
 *
 * A path block is applied by overwriting the whole file, and on the local lane
 * the model routinely emits one holding the single line it means to change: the
 * eval case `edit-long-file` measured a two-line block aimed at an 812-line file
 * in three runs of three, and still one in three after the prompt was taught to
 * edit in place. A prompt cannot carry a guarantee this expensive to lose, so
 * the applier refuses the write instead.
 *
 * The two numbers are a judgement and are therefore written down. Twenty-five
 * lines is the floor because below it "rewrite this whole file" is a normal
 * request and the model can hold the file in its window. Half is the cut
 * because a genuine rewrite that keeps under half of a file this size is rarer
 * on this lane than a truncation, and the cost is asymmetric: a refused rewrite
 * is one more turn, an accepted truncation is unrecoverable work.
 */
export function isTruncatingRewrite(base: string, next: string): boolean {
  const baseLines = base.split("\n").length;
  const nextLines = next.split("\n").length;
  return baseLines >= 25 && nextLines * 2 < baseLines;
}

export interface ParsedHeredoc {
  path: string;
  delimiter: string;
  content: string;
  complete: boolean;
}

export function parseHeredocs(text: string): ParsedHeredoc[] {
  const heredocs: ParsedHeredoc[] = [];
  const lines = text.split(/\r?\n/);
  let current: { path: string; delimiter: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (!current) {
      const m1 = line.match(/^\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*>\s*['"]?([^\s\r\n'"]+)['"]?/);
      const m2 = line.match(/^\s*cat\s+>\s*['"]?([^\s\r\n'"]+)['"]?\s*<<-?\s*['"]?(\w+)['"]?/);
      const m3 = line.match(/^\s*tee\s+(?:-a\s+)?['"]?([^\s\r\n'"]+)['"]?\s*<<-?\s*['"]?(\w+)['"]?/);

      const header = m1
        ? { delimiter: m1[1], path: m1[2] }
        : m2
          ? { delimiter: m2[2], path: m2[1] }
          : m3
            ? { delimiter: m3[2], path: m3[1] }
            : null;

      if (header) {
        const norm = normalizeWorkspacePath(header.path);
        if (norm) {
          current = { path: norm, delimiter: header.delimiter, lines: [] };
        }
      }
    } else {
      if (line.trim().replace(/;$/, "") === current.delimiter) {
        heredocs.push({
          path: current.path,
          delimiter: current.delimiter,
          content: current.lines.join("\n"),
          complete: true,
        });
        current = null;
      } else {
        current.lines.push(line);
      }
    }
  }

  if (current) {
    heredocs.push({
      path: current.path,
      delimiter: current.delimiter,
      content: current.lines.join("\n"),
      complete: false,
    });
  }

  return heredocs;
}

/**
 * Extracts all file paths targeted for creation or modification by shell commands or markdown edits.
 */
export function extractWrittenPathsFromTurn(text: string, options: { userPrompt?: string } = {}): string[] {
  const found = new Set<string>();

  // 1. Heredocs: cat << 'EOF' > path, cat > path << 'EOF', tee path << 'EOF'
  const heredocs = parseHeredocs(text);
  for (const h of heredocs) {
    found.add(h.path);
  }

  // 2. Lines outside heredocs: shell redirection and file commands
  const lines = text.split(/\r?\n/);
  let insideHeredoc = false;
  let activeDelimiter = "";

  for (const line of lines) {
    if (!insideHeredoc) {
      const m1 = line.match(/^\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*>\s*['"]?([^\s\r\n'"]+)['"]?/);
      const m2 = line.match(/^\s*cat\s+>\s*['"]?([^\s\r\n'"]+)['"]?\s*<<-?\s*['"]?(\w+)['"]?/);
      const m3 = line.match(/^\s*tee\s+(?:-a\s+)?['"]?([^\s\r\n'"]+)['"]?\s*<<-?\s*['"]?(\w+)['"]?/);
      const header = m1 || m2 || m3;
      if (header) {
        insideHeredoc = true;
        activeDelimiter = (m1 ? m1[1] : m2 ? m2[2] : m3 ? m3[2] : "") || "";
        continue;
      }

      // Shell redirection to files: command > path or command >> path (not <<, not /dev/, not &)
      const redirectMatch = line.match(/(?:^|[^<])>>?[^\S\r\n]+['"]?([^\s\r\n'";&|]+)['"]?/);
      if (redirectMatch) {
        const raw = redirectMatch[1];
        if (!raw.startsWith("&") && !raw.startsWith("/dev/")) {
          const norm = normalizeWorkspacePath(raw);
          if (norm) found.add(norm);
        }
      }

      // touch / cp / mv targets
      const touchMatch = line.match(/\b(?:touch|cp\s+\S+|mv\s+\S+)[^\S\r\n]+['"]?([^\s\r\n'";&|]+)['"]?/);
      if (touchMatch) {
        const norm = normalizeWorkspacePath(touchMatch[1]);
        if (norm) found.add(norm);
      }
    } else {
      if (line.trim().replace(/;$/, "") === activeDelimiter) {
        insideHeredoc = false;
        activeDelimiter = "";
      }
    }
  }

  // 3. Markdown code edits
  const edits = parseWorkspaceEdits(text, { userPrompt: options.userPrompt });
  for (const edit of edits) {
    const norm = normalizeWorkspacePath(edit.path);
    if (norm) found.add(norm);
  }

  return Array.from(found);
}

/**
 * Extracts the currently streaming draft file and its content from active tokens.
 * Works for both shell heredocs (cat << 'EOF' > path) and markdown code fences.
 */
export function extractStreamingDraft(text: string, userPrompt?: string): { path: string; content: string } | null {
  // 1. Heredoc draft: find all heredocs and take the last active one
  const heredocs = parseHeredocs(text);
  const lastHeredoc = heredocs.at(-1);
  if (lastHeredoc) {
    return { path: lastHeredoc.path, content: lastHeredoc.content };
  }

  // 2. Markdown fence draft
  const edits = parseWorkspaceEdits(text, { userPrompt });
  const lastEdit = edits.at(-1);
  if (lastEdit && lastEdit.path && lastEdit.content) {
    const norm = normalizeWorkspacePath(lastEdit.path);
    if (norm) return { path: norm, content: lastEdit.content };
  }

  return null;
}
