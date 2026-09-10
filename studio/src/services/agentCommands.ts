// Agent command protocol and runner.
// Parsing, safety classification, and execution live together so the rules a
// command is judged by cannot drift from the code that runs it.
import type { ToolCall } from "../types";
import { normalizeWorkspacePath } from "./liveEditProtocol.ts";
import { htmlToText, looksLikeHtml } from "./readablePage.ts";
import type { RunMode } from "./preferences.ts";

export type CommandRisk = "auto" | "confirm" | "blocked";

export interface AgentCommandRequest {
  command: string;
  risk: CommandRisk;
  reason: string;
}

/**
 * Only an explicit opt-in fence is executable. A model routinely prints
 * ```bash blocks as documentation ("run npm install to get started"), and
 * treating those as instructions would execute prose.
 */
const RUN_FENCE = /```(?:frontier-run|frontier-command)[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * Where the first *closed* executable fence ends, or null if none has closed.
 *
 * The reason this exists: a model that emits a ```frontier-run fence and then
 * keeps generating is writing the command's output from imagination. It cannot
 * know it — the command has not run, and in the worst case is still sitting at
 * an approval prompt. Left alone the model narrates a success, the operator
 * reads it, and only afterwards is asked whether to run the thing that
 * supposedly already worked.
 *
 * So generation stops here. The index returned is just past the closing fence;
 * everything after it is discarded unread, the command runs, and its real
 * output comes back as the next observation.
 *
 * `RUN_FENCE` above tolerates an unterminated fence because parsing a finished
 * turn should salvage what it can. This one must not: mid-stream, an unclosed
 * fence only means the model is still typing it.
 */
/**
 * The body of a documentation shell fence, when the turn has one.
 *
 * ```bash is never executed — that rule stands, because a model prints shell
 * blocks as prose constantly and running them would execute documentation. But
 * a model that *meant* to act and reached for ```bash out of habit has stalled:
 * it emits the command, tells the operator to run it themselves, and nothing
 * happens. Detecting that shape is what lets the engine say "you wanted
 * frontier-run" instead of leaving the turn dead.
 *
 * Only closed fences count, and only ones whose first line reads like a command
 * rather than a script — a shebang or a loop is a file being written, not an
 * intention to run something now.
 */
export function documentationShellFence(text: string): string | null {
  const fence = /```(?:bash|sh|shell|zsh|console|terminal)[^\n]*\n([\s\S]*?)```/.exec(text);
  if (!fence) return null;
  const body = fence[1].trim();
  if (!body) return null;
  if (body.startsWith("#!")) return null;
  if (/^\s*(?:if|for|while|function|case)\b/.test(body)) return null;
  return body;
}

export function closedFenceEnd(text: string, tags: readonly string[]): number | null {
  if (tags.length === 0) return null;
  const pattern = new RegExp("```(?:" + tags.join("|") + ")[^\\n]*\\n[\\s\\S]*?```");
  const match = pattern.exec(text);
  return match ? match.index + match[0].length : null;
}

// Read-only inspection and verification. Safe to run without asking because
// they cannot mutate the workspace, the network, or the machine.
const AUTO_COMMANDS = new Set([
  "cat", "cd", "date", "du", "echo", "env", "file", "find", "grep", "head", "ls",
  "node", "npm", "npx", "pwd", "rg", "sed", "sort", "stat", "tail", "tree",
  "tsc", "uniq", "wc", "which", "yarn", "pnpm", "git", "vitest", "jest", "eslint", "prettier",
  // Network and API inspection: querying web services, APIs, and network endpoints
  "curl", "wget", "ping", "dig", "host", "nslookup",
  // Forensics: establishing that two similar-looking things are or are not the
  // same, so the engine can verify identity before advising anything final.
  "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum", "cmp", "diff",
  // System state: what is holding a port, what is running, what is installed,
  // how much room is left. Read-only counterparts to the questions users ask.
  "df", "ps", "lsof", "uname", "sw_vers", "hostname", "whoami", "id", "uptime", "arch",
  // Path and text shaping, so a probe can be narrowed without a second turn.
  "basename", "dirname", "realpath", "readlink", "column", "comm", "cut", "nl",
  "paste", "printf", "seq", "tr", "jq",
]);

// npm/git/yarn are only auto-safe for their read-only subcommands.
const SUBCOMMAND_ALLOW: Record<string, Set<string>> = {
  npm: new Set(["test", "run", "ls", "list", "view", "outdated", "ping", "why", "audit", "-v", "--version"]),
  pnpm: new Set(["test", "run", "ls", "list", "outdated", "why", "-v", "--version"]),
  yarn: new Set(["test", "run", "list", "why", "-v", "--version"]),
  npx: new Set(["tsc", "vitest", "jest", "eslint", "prettier"]),
  git: new Set(["status", "diff", "log", "show", "branch", "remote", "blame", "ls-files", "rev-parse", "describe"]),
  // -e/-p evaluate arbitrary JavaScript, which is not inspection whatever the
  // binary is called. They are refused by MUTATING_FLAGS below as well.
  node: new Set(["-v", "--version", "--test", "--check"]),
  sysctl: new Set(["-n", "-a", "-A"]),
};

/**
 * Flags that turn a read-only binary into a writing one.
 *
 * Membership in AUTO_COMMANDS describes a binary's usual job, not a guarantee
 * about every invocation: `find` inspects, but `find -exec rm` deletes, and the
 * classifier cannot tell them apart on the binary name alone. Each entry below
 * demotes the command to `confirm` so a human sees it first.
 */
const MUTATING_FLAGS: Array<{ binary: string; pattern: RegExp; reason: string }> = [
  { binary: "find", pattern: /\s-(?:exec|execdir|ok|okdir)\b/, reason: "find runs another command per match" },
  { binary: "find", pattern: /\s-(?:delete|fls|fprint|fprintf)\b/, reason: "find deletes or writes to a file" },
  { binary: "sed", pattern: /\s-i\b|\s--in-place/, reason: "sed edits the file in place" },
  { binary: "sort", pattern: /\s-o\b|\s--output/, reason: "sort overwrites its output file" },
  { binary: "node", pattern: /\s-(?:e|p)\b|\s--eval|\s--print/, reason: "node evaluates arbitrary code" },
  { binary: "git", pattern: /\s--output\b|\s-o\b/, reason: "git writes to a file" },
  { binary: "jq", pattern: /\s--rawfile\b.*>|\s-f\b/, reason: "jq reads a program from a file" },
];

// Irreversible, privilege-escalating, or exfiltrating. Never offered for approval.
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b|\bsu\b\s|\bdoas\b/, reason: "privilege escalation" },
  { pattern: /\brm\b[^|;&]*\s(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?(\/|~)(\s|$)/, reason: "recursive delete outside the workspace" },
  { pattern: /\b(mkfs|fdisk|diskutil|dd)\b/, reason: "disk-level operation" },
  { pattern: /\b(shutdown|reboot|halt|killall)\b/, reason: "machine control" },
  { pattern: /\bchmod\b\s+(-R\s+)?777\s+\//, reason: "permission change on the filesystem root" },
  { pattern: /(curl|wget)[^|;&]*\|\s*(sh|bash|zsh)/, reason: "piping a remote script into a shell" },
  { pattern: /:\(\)\s*\{.*\}\s*;?\s*:/, reason: "fork bomb" },
  { pattern: /\bgit\b[^|;&]*\bpush\b[^|;&]*(--force|-f)\b/, reason: "force push" },
  { pattern: /\bhistory\b|\bcrontab\b/, reason: "shell history or scheduler access" },
  { pattern: />\s*\/dev\/(sd|disk|nvme)/, reason: "raw device write" },
];

/**
 * Commands that destroy something rather than change it.
 *
 * The distinction this draws is recoverability, not danger. An agent that
 * writes a bad file in `auto` leaves the old contents in the change dock and in
 * git; an agent that deletes the file leaves nothing, and `git checkout` cannot
 * restore what was never committed. So these keep asking even when the operator
 * has said everything else may run — that exception is the whole reason an auto
 * mode can be offered at all.
 *
 * Deliberately matched on the line rather than per segment: `x && rm y` deletes
 * whichever half of it the classifier looks at. Anything here that is also in
 * BLOCKED_PATTERNS never reaches this function — blocked is refused first.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /(^|[|;&]\s*)(rm|rmdir|unlink|shred|srm)\b/,
  /(^|[|;&]\s*)trash\b/,
  /\bgit\b[^|;&]*\b(clean|reset\s+--hard)\b/,
  /\bfind\b[^|;&]*\s-delete\b/,
  /\bfind\b[^|;&]*\s-(?:exec|execdir|ok|okdir)\s+(?:.*\/)?(?:rm|rmdir|unlink|shred)\b/,
  /\btruncate\b[^|;&]*\s-s\s*0\b/,
  /\bmkfs|\bdd\b[^|;&]*\bof=/,
  /\b(npm|pnpm|yarn)\b[^|;&]*\b(uninstall|remove|rm)\b/,
  /\bdocker\b[^|;&]*\b(rm|rmi|prune)\b/,
];

/**
 * Would running this line delete something?
 *
 * Answers on the raw line, so a redirection that empties a file (`> keep.txt`)
 * counts too — an emptied file is a deleted file with the name left behind.
 */
export function isDestructiveCommand(command: string): boolean {
  const normalized = String(command ?? "").trim();
  if (!normalized) return false;
  if (/(?<![-=>|])>(?!=|>)\s*\S/.test(normalized) && !/>>/.test(normalized)) return true;
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Splits a command line into the segments a shell would run separately. */
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function classifySegment(segment: string): { risk: CommandRisk; reason: string } {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const binary = tokens[0]?.replace(/^.*\//, "");
  if (!binary) return { risk: "confirm", reason: "empty segment" };
  if (!AUTO_COMMANDS.has(binary)) {
    return { risk: "confirm", reason: "changes state or is not a known read-only command" };
  }

  // `find -exec` is exactly as dangerous as the command it runs: `-exec rm`
  // deletes, `-exec stat` inspects. Judging the flag alone would either allow
  // the delete or block the single most useful way to inspect a large tree, so
  // the payload is classified on its own terms.
  let execPayloadCleared = false;
  if (binary === "find") {
    const payload = segment.match(/\s-(?:exec|execdir|ok|okdir)\s+([\s\S]*?)(?:\s[;+]|\s\\;|$)/);
    if (payload) {
      const inner = payload[1].trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
      const innerMutates = MUTATING_FLAGS.some(
        (rule) => rule.binary === inner && rule.pattern.test(` ${payload[1]}`),
      );
      if (!inner || !AUTO_COMMANDS.has(inner) || innerMutates) {
        return { risk: "confirm", reason: `find -exec runs ${inner || "another command"} on every match` };
      }
      execPayloadCleared = true;
    }
  }

  // A read-only binary carrying a writing flag is not a read-only invocation.
  for (const rule of MUTATING_FLAGS) {
    if (rule.binary !== binary) continue;
    if (execPayloadCleared && /exec|ok/.test(rule.pattern.source)) continue;
    if (rule.pattern.test(segment)) return { risk: "confirm", reason: rule.reason };
  }

  const allowed = SUBCOMMAND_ALLOW[binary];
  if (!allowed) return { risk: "auto", reason: "read-only inspection or verification" };

  const subcommand = tokens[1];
  if (!subcommand) {
    return binary === "git" || binary === "npm"
      ? { risk: "confirm", reason: `${binary} needs an explicit read-only subcommand` }
      : { risk: "auto", reason: "read-only inspection or verification" };
  }
  return allowed.has(subcommand)
    ? { risk: "auto", reason: "read-only inspection or verification" }
    : { risk: "confirm", reason: `${binary} ${subcommand} is not a known read-only subcommand` };
}

export function classifyCommand(command: string): { risk: CommandRisk; reason: string } {
  const normalized = command.trim();
  if (!normalized) return { risk: "blocked", reason: "empty command" };

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) return { risk: "blocked", reason };
  }
  // Output redirection can overwrite a file, so it always needs a human.
  // Excludes the arrow-like sequences that appear in ordinary arguments (->, =>, >=).
  if (/(?<![-=>])>>?(?!=)/.test(normalized)) {
    return { risk: "confirm", reason: "writes to a file via redirection" };
  }

  // The riskiest segment decides the whole line: a pipeline is only as safe as
  // the command that mutates the most.
  for (const part of segments(normalized)) {
    const verdict = classifySegment(part);
    if (verdict.risk === "confirm") return verdict;
  }
  return { risk: "auto", reason: "read-only inspection or verification" };
}

/*
  A fence is one command per line — except when it is not.

  A heredoc, a trailing backslash and an unclosed quote each continue a command
  onto the next line, and splitting them does not merely lose the command: it
  runs the pieces. Measured on this repo 2026-09-07, a four-line
  `python3 - <<'EDIT'` edit parsed as **five** commands — a bare `python3`
  reading a stdin that never closes, three python statements handed to the
  shell, and the terminator — each raising its own approval prompt, with
  nothing edited at the end of it. That is why [TO CHANGE A FILE YOU HAVE NOT
  SEEN IN FULL] had to teach a one-line `python3 -c` form: the prompt was
  working around this function.

  Quote and heredoc state is tracked by scanning, not by regex, because `<<`
  inside a quoted string opens nothing and a `#` comment ends the scan. `<<<`
  is a herestring and stays on its line.

  Heredoc *bodies* are still classified as commands by `classifyCommand`,
  which splits on newlines: content that would be blocked as a command is
  blocked when it is written as data too. That is deliberate — a body is an
  obvious place to hide one — and it is the conservative side of the trade.
*/
interface LineScan {
  /** The quote left open at the end of the line, if any. */
  openQuote: "'" | '"' | null;
  /** A trailing unescaped backslash: the command continues on the next line. */
  continues: boolean;
  /** Heredocs opened on this line, in the order their bodies arrive. */
  heredocs: { delim: string; dashed: boolean }[];
}

function scanLine(line: string, carried: "'" | '"' | null): LineScan {
  let quote = carried;
  let continues = false;
  const heredocs: { delim: string; dashed: boolean }[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < line.length) { i += 2; continue; }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      if (i === line.length - 1) { continues = true; break; }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i += 1; continue; }
    // A `#` at a word boundary comments out the rest of the line.
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;

    if (ch === "<") {
      // The whole run decides: `<` redirects, `<<` opens a heredoc, `<<<` is a
      // herestring. Advancing one at a time would read the tail of a `<<<` as
      // a heredoc opener.
      let run = 0;
      while (line[i + run] === "<") run += 1;
      if (run !== 2) { i += run; continue; }
      let j = i + 2;
      let dashed = false;
      if (line[j] === "-") { dashed = true; j += 1; }
      while (line[j] === " " || line[j] === "\t") j += 1;
      let delim: string | null = null;
      if (line[j] === "'" || line[j] === '"') {
        const closing = line.indexOf(line[j], j + 1);
        if (closing > 0) { delim = line.slice(j + 1, closing); j = closing + 1; }
      } else {
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(j));
        if (word) { delim = word[0]; j += word[0].length; }
      }
      if (delim) { heredocs.push({ delim, dashed }); i = j; continue; }
    }
    i += 1;
  }

  return { openQuote: quote, continues, heredocs };
}

/**
 * Groups a fence body into the commands a shell would actually run, keeping
 * every multi-line construct whole. An unterminated one at the end of the
 * fence stays joined rather than being torn apart: one approval for one
 * broken command is safer, and truer to what was asked, than N fragments that
 * each run.
 */
export function fenceCommands(body: string): string[] {
  const lines = body.split("\n");
  const commands: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const parts = [lines[i]];
    let scan = scanLine(lines[i], null);
    let pending = [...scan.heredocs];
    let quote = scan.openQuote;
    let continues = scan.continues;
    i += 1;

    while (i < lines.length && (pending.length > 0 || quote || continues)) {
      const line = lines[i];
      parts.push(line);
      i += 1;

      if (pending.length > 0) {
        const doc = pending[0];
        if ((doc.dashed ? line.replace(/^\t+/, "") : line) === doc.delim) pending.shift();
        continue;
      }

      scan = scanLine(line, quote);
      quote = scan.openQuote;
      continues = scan.continues;
      if (scan.heredocs.length) pending = [...scan.heredocs];
    }

    const command = parts.join("\n").trim();
    // A comment-only line is not a command; a heredoc body starting with `#`
    // is already inside `parts` and never reaches this test.
    if (command && !command.startsWith("#")) commands.push(command);
  }

  return commands;
}

/**
 * Extracts the commands a model explicitly asked to run.
 * Returns them in order, each already classified.
 */
export function parseAgentCommands(text: string): AgentCommandRequest[] {
  const requests: AgentCommandRequest[] = [];
  let match: RegExpExecArray | null;
  RUN_FENCE.lastIndex = 0;

  while ((match = RUN_FENCE.exec(text)) !== null) {
    for (const command of fenceCommands(match[1])) {
      const { risk, reason } = classifyCommand(command);
      requests.push({ command, risk, reason });
    }
  }
  return requests;
}

/** Renders an executed command's result for the model's next turn. */
export function formatCommandEvidence(
  command: string,
  outcome: { code: number | null; output: string; truncated?: boolean },
): string {
  const status = outcome.code === 0 ? "succeeded" : `failed with exit code ${outcome.code}`;
  const body = outcome.output.trim() || "(no output)";
  return [
    `$ ${command}`,
    `# ${status}`,
    body,
    outcome.truncated ? "# output truncated" : "",
  ].filter(Boolean).join("\n");
}


export interface CommandExecution {
  command: string;
  risk: AgentCommandRequest["risk"];
  executed: boolean;
  code: number | null;
  output: string;
  truncated: boolean;
  note?: string;
}

/** Executes one command and reports what actually happened. */
export type CommandExecutor = (
  command: string,
  options: { signal?: AbortSignal; onOutput?: (chunk: { type: "stdout" | "stderr"; data: string }) => void },
) => Promise<{ code: number | null; durationMs: number; truncated: boolean }>;

export interface RunAgentCommandsOptions {
  /** Injected so the runner has no transport dependency and stays testable. */
  execute: CommandExecutor;
  signal?: AbortSignal;
  onToolCall?: (toolCall: ToolCall) => void;
  /** Resolves true when a human approves a state-changing command. */
  approve?: (request: AgentCommandRequest) => Promise<boolean>;
  /**
   * How much may run unattended. Omitted means `review`, which is what the
   * runner did before the mode existed: auto-risk commands run, confirm-risk
   * commands ask.
   */
  runMode?: RunMode;
  /** Keeps a delete-shaped command asking even under `auto`. Default true. */
  protectDeletions?: boolean;
  maxCommands?: number;
  maxOutputChars?: number;
}

const DEFAULT_MAX_COMMANDS = 4;
// A fallback for a caller that names no window. The engine passes the lane's
// real allowance from contextBudget.ts — a share of the model's window, not a
// constant — and this figure is what a 10k window would be given.
const DEFAULT_MAX_OUTPUT_CHARS = 4_000;
/*
  How much of an HTML document is worth reading before it is reduced to text.
  A fetched page is mostly markup — measured, nodejs.org/en/about/previous-releases
  decodes to 295,973 chars and reduces to 5,683 once stripped — so the answer is
  always past `DEFAULT_MAX_OUTPUT_CHARS` in the raw bytes, and within reach of
  the lane's real allowance after. This ceiling exists only so `htmlToText` has a body to work with; it is
  still a bound, because an unbounded read is how a fetch becomes a memory bug.
*/
const HTML_CEILING_CHARS = 512_000;

/**
 * Executes the commands a model explicitly requested and returns what actually
 * happened. A blocked command never runs; what else needs a human first is
 * `runMode`'s decision. Nothing here reports success for a command that did not
 * execute.
 */
export async function runAgentCommands(
  text: string,
  options: RunAgentCommandsOptions,
): Promise<CommandExecution[]> {
  const maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const requests = parseAgentCommands(text).slice(0, maxCommands);
  const executions: CommandExecution[] = [];

  for (const request of requests) {
    if (options.signal?.aborted) break;

    const toolId = `tool-run-${Math.random().toString(36).slice(2, 10)}`;
    const emit = (status: ToolCall["status"], result?: string) =>
      options.onToolCall?.({
        id: toolId,
        name: "frontier.run_command",
        arguments: { command: request.command, risk: request.risk },
        status,
        ...(result ? { result } : {}),
      });

    if (request.risk === "blocked") {
      const note = `Refused: ${request.reason}.`;
      emit("error", note);
      executions.push({ command: request.command, risk: request.risk, executed: false, code: null, output: "", truncated: false, note });
      continue;
    }

    /*
      Three modes, one question: does a human see this before it runs?

      `ask` promotes an auto-risk command to a prompt — the operator has said
      they want to see everything, and a read-only command is still a command
      run on their machine. `auto` demotes a confirm-risk command to a run,
      except a destructive one, which `protectDeletions` keeps asking about.
      `review` is neither and is what the runner always did.

      A blocked command is refused above and reaches none of this.
    */
    const runMode = options.runMode ?? "review";
    const protectDeletions = options.protectDeletions ?? true;
    const destructive = isDestructiveCommand(request.command);
    const needsHuman =
      runMode === "ask" ||
      (request.risk === "confirm" && (runMode !== "auto" || (protectDeletions && destructive)));

    if (needsHuman) {
      const approved = options.approve ? await options.approve(request) : false;
      if (!approved) {
        // The model reads this note and learns why nothing ran, so it names the
        // reason the command was put to a human — which under `ask` is the mode
        // itself, not the classifier's verdict about the command.
        const why =
          request.risk === "auto" ? "every command is set to ask first" : request.reason;
        const note = `Skipped pending approval: ${why}.`;
        emit("error", note);
        executions.push({ command: request.command, risk: request.risk, executed: false, code: null, output: "", truncated: false, note });
        continue;
      }
    }

    emit("running");
    let output = "";
    try {
      const exit = await options.execute(request.command, {
        signal: options.signal,
        onOutput: (chunk) => {
          /*
            The ceiling has to be content-aware, because the decision to stop
            reading is made long before there is anything to strip. An HTML
            document is read up to `HTML_CEILING_CHARS`; everything else still
            stops at `maxOutputChars`, which is what keeps `cat /dev/urandom`
            from becoming a memory bug.
          */
          const ceiling = looksLikeHtml(output) ? Math.max(maxOutputChars, HTML_CEILING_CHARS) : maxOutputChars;
          if (output.length < ceiling) output += chunk.data;
        },
      });
      /*
        Markup is stripped before the cut, never after. Cutting first hands the
        model the `<head>` — doctype, bundler hashes, `<link rel=...>` — which is
        exactly the 4,000 chars that made a successful fetch useless.
      */
      const readable = looksLikeHtml(output) ? htmlToText(output) : output;
      const trimmed = readable.length > maxOutputChars ? `${readable.slice(0, maxOutputChars)}\n…` : readable;
      /*
        `result` means the same thing in every lane: what came back.

        The two agent CLIs put a tool's real output in this field — Codex's
        `aggregated_output`, Claude Code's `tool_result` content — and both the
        step strip's `out` fold and `describeToolCall` read it expecting that.
        This lane used to send only `exit 0 · 412 ms` and keep the output for
        the model's next turn, which cost the operator the substance twice
        over: the fold showed a status line, and the narrator's failure regex —
        the one that exists because an exit code is not the whole truth — had
        no text to read. A run that exits 0 while printing `2 failed` was
        spoken as "Tests passed." The exit line is kept and leads, because it
        is worth knowing and no lane carries it otherwise.
      */
      const exitLine = `exit ${exit.code} · ${exit.durationMs} ms`;
      emit(exit.code === 0 ? "completed" : "error", trimmed ? `${exitLine}\n${trimmed}` : exitLine);
      executions.push({
        command: request.command,
        risk: request.risk,
        executed: true,
        code: exit.code,
        output: trimmed,
        truncated: exit.truncated || readable.length > maxOutputChars,
      });
    } catch (error) {
      const note = error instanceof Error ? error.message : "The command could not be executed.";
      emit("error", note);
      executions.push({ command: request.command, risk: request.risk, executed: false, code: null, output: "", truncated: false, note });
    }
  }

  return executions;
}

/** Builds the observation the model reads on its next turn. */
export function buildCommandEvidence(executions: CommandExecution[]): string {
  if (executions.length === 0) return "";
  const blocks = executions.map((execution) =>
    execution.executed
      ? formatCommandEvidence(execution.command, {
          code: execution.code,
          output: execution.output,
          truncated: execution.truncated,
        })
      : `$ ${execution.command}\n# not run — ${execution.note}`,
  );
  return [
    "Command results from the Teminali workspace. These are real outputs; treat them as the only evidence of what ran.",
    ...blocks,
  ].join("\n\n");
}

export function hasExecutableCommands(text: string): boolean {
  return parseAgentCommands(text).some((request) => request.risk !== "blocked");
}

/* ────────────────────────────────────────────────────────────────
   What the conversation has actually read
   Consumed by the Live Edit applier, which refuses to overwrite a
   file whose contents never entered the conversation.
   ──────────────────────────────────────────────────────────────── */

/**
 * Binaries that put a file's *contents* on the conversation.
 *
 * Deliberately openers, not searchers. `grep -n flag deploy.sh` prints the one
 * line that matched, and a model that has seen one line of a file has no
 * business overwriting all of it — that is the exact shape of the
 * `read-before-edit` eval case. `wc`, `ls` and `stat` describe a file without
 * showing it and are absent for the same reason.
 */
const READ_BINARIES = new Set(["awk", "bat", "cat", "head", "less", "more", "nl", "sed", "tail"]);

/** Tokens that take a filename but write to it rather than read it. */
const REDIRECTS = new Set([">", ">>", "1>", "2>", "&>"]);

function tokenize(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * The paths a command read out loud.
 *
 * A fact, not a guess: the binary is one that prints a file and the path is an
 * argument to it. Everything ambiguous is left out, because the cost is
 * asymmetric — a path wrongly left out costs one more turn, a path wrongly
 * included costs the operator's file.
 */
export function pathsReadByCommand(command: string): string[] {
  const found: string[] = [];
  for (const segment of segments(String(command ?? ""))) {
    const tokens = tokenize(segment);
    const binary = tokens[0]?.replace(/^.*\//, "");
    if (!binary || !READ_BINARIES.has(binary)) continue;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      // `cat a > b` reads a and *writes* b; skip the operator and its target.
      if (REDIRECTS.has(token)) {
        index += 1;
        continue;
      }
      if (!token || token === "-" || token.startsWith("-") || /^\d/.test(token)) continue;
      const path = normalizeWorkspacePath(token);
      if (path) found.push(path);
    }
  }
  return [...new Set(found)];
}

/**
 * The paths this turn's tool calls read.
 *
 * Only a completed run counts. A command that errored may have read nothing —
 * `cat` on a path that does not exist exits 1 — and an unread file is the case
 * this whole set exists to catch.
 */
export function pathsSeenInToolCalls(calls: readonly ToolCall[] | undefined): string[] {
  if (!calls?.length) return [];
  return calls
    .filter((call) => call.name === "frontier.run_command" && call.status === "completed")
    .flatMap((call) => pathsReadByCommand(String(call.arguments?.command ?? "")));
}

/* ────────────────────────────────────────────────────────────────
   Approval gate
   Kept free of React so the "always settles" invariant is testable.
   ──────────────────────────────────────────────────────────────── */

/**
 * What "always allow" covers. The whole command is too narrow to be worth
 * remembering — the next one differs by an argument — and the tool is far too
 * broad, so the unit is the executable: approve `open` once and `open -a VLC`
 * and `open -a Safari` both follow, while `rm` still asks.
 */
export function commandHead(command: string): string {
  return String(command ?? "").trim().split(/\s+/)[0] ?? "";
}

/** What a prompt is actually asking about: a shell command, or a tool call. */
export interface ApprovalAction {
  kind: "shell" | "tool";
  /** For a tool: which server it belongs to, or null for a built-in tool. */
  server: string | null;
  /** The thing itself, shown to the operator: a command line, or a tool name. */
  label: string;
  /** What "always" covers, in as few characters as will still mean something. */
  scope: string;
}

/**
 * Read a pending approval's subject.
 *
 * The prompt used to show every request as a shell command: a `$` sigil in
 * front of it and, on the "always" button, `commandHead` — the first word. For
 * a command that is the executable and reads well. For a tool call the first
 * word is the *whole* name, so the button became
 * `Always mcp__teminali-workspace__recent_projects`, which pushed the deny
 * button off the end of the row and left the operator with a prompt they could
 * not refuse without reaching for the keyboard.
 *
 * MCP tool names are `mcp__<server>__<tool>`, and both halves are worth
 * showing: which server is asking is most of what makes a tool call
 * judgeable. A built-in tool (`Bash`, `Edit`) has no `mcp__` prefix and no
 * server, and a shell command is anything with whitespace in it.
 */
export function describeApprovalAction(command: string): ApprovalAction {
  const text = String(command ?? "").trim();
  const mcp = /^mcp__([^\s]+?)__([^\s]+)$/.exec(text);
  if (mcp) return { kind: "tool", server: mcp[1], label: mcp[2], scope: mcp[2] };
  // A bare word with no shell metacharacter is a built-in tool name, not a
  // command: `Bash` on its own is the tool, `bash -lc "..."` is the command.
  if (text && !/\s/.test(text) && /^[A-Za-z][A-Za-z0-9_]*$/.test(text)) {
    return { kind: "tool", server: null, label: text, scope: text };
  }
  return { kind: "shell", server: null, label: text, scope: commandHead(text) };
}

export interface ApprovalGate {
  /** Asks for a decision. The returned promise always settles. */
  request: (command: AgentCommandRequest) => Promise<boolean>;
  /**
   * Resolves the outstanding request. `remember` promotes an approval to every
   * later command with the same `commandHead` for the life of this gate.
   */
  settle: (approved: boolean, remember?: boolean) => void;
  /** Denies the outstanding request — for cancellation and teardown. */
  cancel: () => void;
  pending: () => AgentCommandRequest | null;
  /**
   * Adopt the operator's saved allowlist wholesale.
   *
   * The stored list is the truth, not a seed: an entry removed in settings has
   * to stop allowing things in the run that is already open, or the row the
   * operator just deleted goes on working until they quit the app.
   */
  replaceAllowlist: (entries: readonly string[]) => void;
}

export interface ApprovalGateOptions {
  /**
   * Executables answered "always" in an earlier session, from the operator's
   * saved allowlist. The gate treats these exactly as it treats one remembered
   * a minute ago — the point of saving them was that the answer outlives the
   * window.
   */
  allowlist?: readonly string[];
  /**
   * A new "always" was just granted. The caller persists it; the gate does not
   * know where preferences live and should not. Fires only for an entry the
   * gate did not already hold, so a re-grant does not churn storage.
   */
  onRemember?: (scope: string) => void;
}

export function createApprovalGate(
  onPendingChange?: (pending: AgentCommandRequest | null) => void,
  options: ApprovalGateOptions = {},
): ApprovalGate {
  let resolver: ((approved: boolean) => void) | null = null;
  let current: AgentCommandRequest | null = null;
  /** Executables the operator has said yes to — this session, or an earlier one. */
  const remembered = new Set<string>(options.allowlist ?? []);

  const set = (next: AgentCommandRequest | null) => {
    current = next;
    onPendingChange?.(next);
  };

  const settle = (approved: boolean, remember = false) => {
    const resolve = resolver;
    const asked = current;
    resolver = null;
    set(null);
    if (approved && remember && asked) {
      const scope = commandHead(asked.command);
      if (scope && !remembered.has(scope)) {
        remembered.add(scope);
        options.onRemember?.(scope);
      }
    }
    resolve?.(approved);
  };

  return {
    request(command) {
      // Asked and answered: a remembered executable does not stop the run to
      // ask the same question again.
      if (remembered.has(commandHead(command.command))) return Promise.resolve(true);
      // A second request while one is outstanding denies the first rather
      // than dropping its resolver, which would stall the agent turn.
      if (resolver) settle(false);
      return new Promise<boolean>((resolve) => {
        resolver = resolve;
        set(command);
      });
    },
    settle,
    cancel() {
      if (resolver) settle(false);
    },
    pending: () => current,
    replaceAllowlist(entries) {
      remembered.clear();
      for (const entry of entries) remembered.add(entry);
    },
  };
}
