// Agent command protocol and runner.
// Parsing, safety classification, and execution live together so the rules a
// command is judged by cannot drift from the code that runs it.
import type { ToolCall } from "../types";

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

// Read-only inspection and verification. Safe to run without asking because
// they cannot mutate the workspace, the network, or the machine.
const AUTO_COMMANDS = new Set([
  "cat", "cd", "date", "du", "echo", "env", "file", "find", "grep", "head", "ls",
  "node", "npm", "npx", "pwd", "rg", "sed", "sort", "stat", "tail", "tree",
  "tsc", "uniq", "wc", "which", "yarn", "pnpm", "git", "vitest", "jest", "eslint", "prettier",
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

/**
 * Extracts the commands a model explicitly asked to run.
 * Returns them in order, each already classified.
 */
export function parseAgentCommands(text: string): AgentCommandRequest[] {
  const requests: AgentCommandRequest[] = [];
  let match: RegExpExecArray | null;
  RUN_FENCE.lastIndex = 0;

  while ((match = RUN_FENCE.exec(text)) !== null) {
    for (const line of match[1].split("\n")) {
      const command = line.trim();
      if (!command || command.startsWith("#")) continue;
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
  maxCommands?: number;
  maxOutputChars?: number;
}

const DEFAULT_MAX_COMMANDS = 4;
const DEFAULT_MAX_OUTPUT_CHARS = 4_000;

/**
 * Executes the commands a model explicitly requested and returns what actually
 * happened. A blocked command never runs; a state-changing command runs only
 * when `approve` says so. Nothing here reports success for a command that did
 * not execute.
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

    if (request.risk === "confirm") {
      const approved = options.approve ? await options.approve(request) : false;
      if (!approved) {
        const note = `Skipped pending approval: ${request.reason}.`;
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
          if (output.length < maxOutputChars) output += chunk.data;
        },
      });
      const trimmed = output.length > maxOutputChars ? `${output.slice(0, maxOutputChars)}\n…` : output;
      emit(exit.code === 0 ? "completed" : "error", `exit ${exit.code} · ${exit.durationMs} ms`);
      executions.push({
        command: request.command,
        risk: request.risk,
        executed: true,
        code: exit.code,
        output: trimmed,
        truncated: exit.truncated || output.length > maxOutputChars,
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
   Approval gate
   Kept free of React so the "always settles" invariant is testable.
   ──────────────────────────────────────────────────────────────── */

export interface ApprovalGate {
  /** Asks for a decision. The returned promise always settles. */
  request: (command: AgentCommandRequest) => Promise<boolean>;
  /** Resolves the outstanding request, if any. */
  settle: (approved: boolean) => void;
  /** Denies the outstanding request — for cancellation and teardown. */
  cancel: () => void;
  pending: () => AgentCommandRequest | null;
}

export function createApprovalGate(onPendingChange?: (pending: AgentCommandRequest | null) => void): ApprovalGate {
  let resolver: ((approved: boolean) => void) | null = null;
  let current: AgentCommandRequest | null = null;

  const set = (next: AgentCommandRequest | null) => {
    current = next;
    onPendingChange?.(next);
  };

  const settle = (approved: boolean) => {
    const resolve = resolver;
    resolver = null;
    set(null);
    resolve?.(approved);
  };

  return {
    request(command) {
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
  };
}
