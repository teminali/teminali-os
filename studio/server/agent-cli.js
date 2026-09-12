/**
 * Claude Code and Codex, run as themselves.
 *
 * These are not another provider behind the chat box. They are the two coding
 * agents the operator already has installed, invoked as real processes in the
 * real workspace, with their own auth, their own tools and their own session
 * files. What this module does is translate their two very different event
 * streams into one shape the studio can render, so a turn from either looks
 * like a turn.
 *
 * Both are driven in headless mode, which is the only mode that emits a
 * machine-readable stream:
 *
 *   claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
 *   codex exec --json --sandbox <mode> -C <cwd> <prompt>
 *
 * Neither is given a shell string. Arguments go across as an array, because a
 * prompt is arbitrary operator text and a `;` in one must reach the agent as a
 * semicolon rather than as a command separator.
 *
 * Two things were learned by running them rather than by reading about them,
 * and both are load-bearing:
 *
 *   1. `claude --bare` forces `ANTHROPIC_API_KEY` auth and fails outright for a
 *      subscription login ("Not logged in · Please run /login"). It looks like
 *      a harmless speed-up. It is not; never add it.
 *   2. Both CLIs wait on stdin when it is a pipe. Claude warns and stalls three
 *      seconds, Codex blocks. stdin is therefore closed, not inherited.
 */

import { withBinPaths } from "./bin-paths.js";
import { spawnCommand } from "./command-resolver.js";
import { videoMcpArgs } from "./video-mcp.js";
import { permissionMcpArgs } from "./permission-mcp.js";
import { screenMcpArgs } from "./screen-mcp.js";
import { workspaceMcpArgs } from "./workspace-mcp.js";
import { cameraMcpArgs } from "./camera-mcp.js";
import { browserMcpArgs } from "./browser-mcp.js";
import { briefingArgs } from "./agent-briefing.js";
import { closeRun, openRun } from "./permission-bridge.js";
import { createEditWatcher } from "./agent-edits.js";
import { removeAgentImages, writeAgentImages } from "./agent-attachments.js";
import { resolve, sep } from "node:path";

export const AGENT_LIMITS = Object.freeze({
  maxPromptLength: 100_000,
  /** A single turn's stdout. Generous: a long agent turn is legitimately big. */
  maxOutputBytes: 32 * 1024 * 1024,
  timeoutMs: 30 * 60_000,
  killGraceMs: 3_000,
  /**
   * How long after the agent process EXITS the turn waits for its pipes to
   * close before ending anyway. See the `exit` handler in `runAgentTurn`.
   */
  exitGraceMs: 1_500,
});

export const AGENTS = Object.freeze({
  claude: {
    bin: "claude",
    label: "Claude Code",
    /**
     * Permission ladder, safest first. `bypassPermissions` is reachable but is
     * never the default — an agent that can run anything in your repo without
     * asking is a choice the operator makes explicitly, not one we make for
     * them.
     */
    permissions: ["manual", "acceptEdits", "bypassPermissions"],
    defaultPermission: "acceptEdits",
    /**
     * How hard the model works before it answers, weakest first.
     *
     * These are `claude --effort <level>`'s own words, copied from the
     * installed CLI's help rather than chosen: a level we invent is a level
     * the CLI rejects, and it rejects it by failing the whole turn. The
     * default is null — "leave the operator's own CLI setting alone" —
     * because an effort we pick silently overrides a config they wrote.
     */
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: null,
    /**
     * Claude Code has no separate thinking knob. `--effort` is it: the levels
     * above are the thinking budget. Empty rather than absent, so the picker
     * can render "what this agent offers" without asking which agent it is.
     */
    thinking: [],
    defaultThinking: null,
  },
  codex: {
    bin: "codex",
    label: "Codex",
    permissions: ["read-only", "workspace-write", "danger-full-access"],
    defaultPermission: "workspace-write",
    /** `-c model_reasoning_effort=`. Codex starts a rung below Claude Code. */
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    defaultEffort: null,
    /**
     * `-c model_reasoning_summary=` — how much of the reasoning comes back on
     * the stream, which is what the transcript renders. Ordered quietest
     * first; `auto` is last because it is the widest, not the safest.
     */
    thinking: ["none", "concise", "detailed", "auto"],
    defaultThinking: null,
  },
});

export function isAgentEngine(engine) {
  return Object.prototype.hasOwnProperty.call(AGENTS, engine);
}

/** The workspace is the boundary; an agent may not be pointed outside it. */
export function resolveAgentCwd(root, requestedCwd = "") {
  if (typeof requestedCwd !== "string" || requestedCwd.includes("\0")) throw new Error("INVALID_AGENT_CWD");
  const workspaceRoot = resolve(root);
  const candidate = resolve(workspaceRoot, requestedCwd);
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${sep}`)) throw new Error("AGENT_CWD_ESCAPE");
  return candidate;
}

/**
 * The child's environment.
 *
 * Unlike a workspace shell command, an agent CLI legitimately needs the
 * provider credentials — they are how it authenticates. What it must not
 * inherit is the gateway's own session token, which would let a tool call turn
 * around and drive the gateway as us.
 */
export function agentEnvironment(source = process.env) {
  const environment = withBinPaths(source);
  delete environment.FRONTIER_SESSION_TOKEN;
  return environment;
}

function argsFor(engine, { prompt, cwd, sessionId, fork = false, model, permission, effort = null, thinking = null, approval = null, screen = null, workspace = null, camera = null, browser = null, imagePaths = [] }) {
  /*
    The video panel, when one is open.

    These CLIs run in their own process and cannot see the renderer's stores, so
    the timeline reaches them over MCP or not at all. Resolved per call rather
    than once at import: the app the operator is talking to may have been opened
    after the gateway started, and a spec captured at import would carry a token
    from an instance that has since quit. Empty when there is no bridge, which
    is what makes this addition invisible to everyone who never opens the panel.
  */
  const mcp = videoMcpArgs(engine);

  /*
    Where the agent is, and what it can reach from there.

    Without this the agent is spawned knowing nothing about the application it
    is inside: it described itself as running in a terminal while sitting in a
    desktop panel, and told the operator it could not drive their screen on a
    turn where it could. `screen` is passed rather than re-derived so the
    briefing and the tools can never disagree — an agent told it has hands
    always has them.
  */
  const briefing = briefingArgs(engine, {
    screen: (screen?.args?.length ?? 0) > 0,
    video: mcp.length > 0,
    workspace: (workspace?.args?.length ?? 0) > 0,
    camera: (camera?.args?.length ?? 0) > 0,
    browser: (browser?.args?.length ?? 0) > 0,
  });

  if (engine === "claude") {
    /*
      Claude Code has no image flag. It reads images with its own Read tool, so
      an attachment reaches it only by being named — which is why the paths go
      in the prompt rather than in argv, and why they are named before the
      operator's own words: an instruction that arrives after the question is
      one the model has already started answering without.
    */
    const prose = imagePaths.length
      ? `The operator attached ${imagePaths.length} image${imagePaths.length === 1 ? "" : "s"} to this message. `
        + `Read ${imagePaths.length === 1 ? "it" : "each of them"} with your Read tool before answering:\n`
        + `${imagePaths.join("\n")}\n\n${prompt}`
      : prompt;

    /*
      Without a prompt tool, headless `claude -p` refuses anything its
      permission mode does not settle outright — there is no terminal to ask
      on. `approval` names an MCP tool that asks the operator in the agent tab
      instead, which is what turns "the command needs your approval and this
      session can't prompt for it" into a dialog with a button.
    */
    const args = [
      ...mcp,
      ...(approval?.args ?? []),
      ...(screen?.args ?? []),
      ...(workspace?.args ?? []),
      ...(camera?.args ?? []),
      ...(browser?.args ?? []),
      ...briefing,
      "-p", prose,
      "--output-format", "stream-json",
      "--verbose",
      // Without this, text arrives one whole assistant message at a time and
      // the pane sits blank through the entire turn.
      "--include-partial-messages",
      "--permission-mode", permission,
      // The assistant answers to one name whatever engine is underneath. Claude
      // Code takes an appended system prompt, so the identity rides in the same
      // place its own instructions do, invisible in the operator's transcript.
      "--append-system-prompt", AGENT_IDENTITY,
    ];
    if (model) args.push("--model", model);
    // Omitted rather than defaulted when nothing is chosen, so the operator's
    // own `~/.claude` setting survives a turn started from this app.
    if (effort) args.push("--effort", effort);
    // Resuming is what makes a tab a conversation rather than a series of
    // unrelated one-shots.
    if (sessionId) {
      args.push("--resume", sessionId);
      /*
        Branching instead of continuing.

        `--fork-session` answers from the resumed history and writes the answer
        to a new session id, leaving the thread it read untouched — which is
        what lets two chats in this app share a past and not a future. It is
        documented as "when resuming", so it goes after `--resume` and is never
        pushed without it: on its own it modifies a flag that is not there.
      */
      if (fork) args.push("--fork-session");
    }
    return args;
  }

  /*
    Codex has no flag for either knob; both are config overrides, and `-c`
    parses its value as TOML before falling back to a literal — so the level is
    quoted, which is the form the CLI's own help documents (`-c model="o3"`).
    An unquoted bare word happens to work today by way of that fallback; a
    quoted string is a TOML string on purpose.
  */
  const overrides = [];
  if (effort) overrides.push("-c", `model_reasoning_effort="${effort}"`);
  if (thinking) overrides.push("-c", `model_reasoning_summary="${thinking}"`);

  // `-c` before the subcommand and the positional prompt, both of which must
  // stay last: `codex exec resume <id> <prompt>` is order-sensitive.
  const args = [...mcp, ...overrides, "exec", "--json", "--skip-git-repo-check", "--sandbox", permission, "-C", cwd];
  /*
    `codex exec -i, --image <FILE>...` takes the files as a first-class flag, so
    Codex needs no help from the prose. The `--image=<path>` form is used rather
    than `-i <path>`: the flag is variadic, and a variadic flag given its value
    positionally goes on eating arguments — including the prompt, which has to
    stay last. `=` binds exactly one value and stops.
  */
  for (const path of imagePaths) args.push(`--image=${path}`);
  if (model) args.push("--model", model);
  if (sessionId) {
    /*
      `codex exec resume <id>` is a subcommand, so the prompt follows it.

      `fork` is the other one: `codex exec fork <SESSION_ID> [PROMPT]`, same
      shape, same position, and it branches rather than extends — Codex's own
      words are "fork a previous session by id into a new session". Swapping the
      verb is the whole difference, which is why they share this line.
    */
    args.push(fork ? "fork" : "resume", sessionId, prompt);
    return args;
  }
  args.push(prompt);
  return args;
}

/**
 * Who the assistant is, whatever engine is answering. The operator asked for
 * this by name: the assistant is Temy even when the turn is being served by
 * Claude Code or Codex. Kept to one short paragraph — it is prepended to
 * somebody else's system prompt, not to ours.
 */
export const AGENT_IDENTITY =
  "Your name is Temy, the assistant inside Teminali Code. If you are asked who or what you are, you are Temy — never the name of the model or engine answering underneath. Greet a greeting: \"hello\" is not a task, so answer it as a person would rather than acknowledging work you have not started.";

/* ── Event normalisation ─────────────────────────────────────────────────────
   One shape out, whichever agent went in:

     { type: "session", sessionId, model, cwd, tools }
     { type: "token",     text }        assistant prose, as it arrives
     { type: "reasoning", text }        thinking, as it arrives
     { type: "tool",      id, name, input, status, output, isError }
     { type: "result",    ok, durationMs, costUsd, sessionId, usage, text }
     { type: "edit",      path, before, after, existedBefore, size, modified }
     { type: "error",     code, message }
   ------------------------------------------------------------------------- */

/**
 * Claude's token accounting, done from the source that is actually complete.
 *
 * `result.usage` describes only the *main* model of a turn. A single turn
 * routinely uses more than one — a cheap model for a side task, the selected one
 * for the reply — and `result.modelUsage` is the per-model breakdown whose
 * costs sum to `total_cost_usd`. Reading `usage` alone undercounts a real turn
 * badly: on a measured example it reported 4 input tokens for a turn whose
 * models actually consumed 910, and omitted 40,808 cache-creation tokens
 * entirely.
 *
 * Cache reads and cache writes are prompt tokens. They are billed at different
 * rates, which is the cost figure's problem, not the token count's — leaving
 * them out makes the count describe a smaller turn than the one that happened.
 */
function claudeUsage(event) {
  const entries = event.modelUsage && typeof event.modelUsage === "object" ? Object.entries(event.modelUsage) : [];

  if (entries.length > 0) {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const models = [];
    for (const [id, usage] of entries) {
      totals.inputTokens += usage.inputTokens ?? 0;
      totals.outputTokens += usage.outputTokens ?? 0;
      totals.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
      totals.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
      models.push({
        id,
        costUsd: typeof usage.costUSD === "number" ? usage.costUSD : null,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        // Carried per model too, so the per-model view in the usage panel sums
        // back to the turn's total instead of quietly losing the cache.
        cacheReadTokens: usage.cacheReadInputTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
      });
    }
    return { ...totals, models };
  }

  const usage = event.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    models: [],
  };
}

/**
 * Codex reports one flat usage block and no cost at all — it bills against the
 * operator's ChatGPT subscription rather than per-turn. `costUsd` is therefore
 * null and must stay null: rendering an unknown cost as $0.00 tells the
 * operator the turn was free, which is a different claim entirely.
 */
function codexUsage(event) {
  const usage = event.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cached_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_write_input_tokens ?? 0,
    models: [],
  };
}

/**
 * Claude emits every text block twice — once as `stream_event` deltas and again
 * as the settled `assistant` message. Tokens are taken from the deltas only and
 * the settled message is read for tool calls alone, which is the whole reason
 * the transcript does not come out duplicated.
 */
function normaliseClaude(event, state) {
  const out = [];

  if (event.type === "system" && event.subtype === "init") {
    state.sessionId = event.session_id ?? state.sessionId;
    out.push({
      type: "session",
      sessionId: event.session_id ?? null,
      model: event.model ?? null,
      cwd: event.cwd ?? null,
      tools: Array.isArray(event.tools) ? event.tools : [],
    });
    return out;
  }

  if (event.type === "stream_event") {
    const inner = event.event ?? {};
    if (inner.type === "content_block_delta") {
      const delta = inner.delta ?? {};
      if (delta.type === "text_delta" && delta.text) out.push({ type: "token", text: delta.text });
      else if (delta.type === "thinking_delta" && delta.thinking) out.push({ type: "reasoning", text: delta.thinking });
    }
    return out;
  }

  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") {
        out.push({
          type: "tool",
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          status: "running",
        });
      }
    }
    return out;
  }

  if (event.type === "user") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_result") {
        out.push({
          type: "tool",
          id: block.tool_use_id,
          status: block.is_error ? "error" : "completed",
          isError: Boolean(block.is_error),
          output: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null),
        });
      }
    }
    return out;
  }

  /*
    Plan headroom, free of charge.

    The CLI reports the account's rate-limit windows on the same stream it
    reports tokens on, so the studio learns how much of the plan is left
    without asking for it — see server/plan.js for what is done with them and
    for why Codex has no equivalent. Only a subscription login emits this: an
    API-key turn has no plan behind it, so silence here is a fact about the
    login rather than a parse failure.
  */
  if (event.type === "rate_limit_event") {
    const info = event.rate_limit_info ?? {};
    const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : {};
    const windows = Object.entries(unified)
      // A window with no utilisation is a window the account does not have.
      // Rendering it as 0% would claim the plan is untouched on that axis.
      .filter(([, window]) => window && typeof window.utilization === "number")
      .map(([id, window]) => ({
        id,
        utilization: window.utilization,
        resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
      }));
    if (windows.length > 0) {
      out.push({
        type: "limits",
        status: typeof info.status === "string" ? info.status : null,
        isUsingOverage: Boolean(info.isUsingOverage),
        windows,
      });
    }
    return out;
  }

  if (event.type === "result") {
    state.sessionId = event.session_id ?? state.sessionId;
    out.push({
      type: "result",
      ok: !event.is_error,
      durationMs: event.duration_ms ?? null,
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
      sessionId: event.session_id ?? null,
      usage: claudeUsage(event),
      text: typeof event.result === "string" ? event.result : null,
      // Surfaced rather than swallowed: "it did nothing" and "it was not
      // allowed to do the thing" are different answers and the operator is
      // entitled to know which one happened.
      permissionDenials: Array.isArray(event.permission_denials) ? event.permission_denials : [],
    });
  }

  return out;
}

/**
 * Codex reports progress as items with a lifecycle — started, updated,
 * completed — rather than as token deltas. `agent_message` text therefore lands
 * in one piece at `item.completed`, and the pane fills in a step rather than a
 * stream. That is the CLI's contract, not a shortcut here.
 */
/**
 * What a Codex item says went wrong, or null if it says nothing.
 *
 * The CLI reports a failure as a field on the item itself rather than as a
 * separate event, and it is not consistent about the shape — a string on some
 * item types, an object carrying a message on others. Its presence is the
 * signal either way; only the text differs.
 */
function codexItemError(item) {
  const error = item.error ?? null;
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message ?? JSON.stringify(error);
}

/** The keys that describe the envelope rather than what the item was asked to do. */
const CODEX_ENVELOPE_KEYS = new Set([
  "id", "item_type", "type", "status", "error", "result", "output", "aggregated_output", "unified_diff",
]);

/**
 * The fields of an unfamiliar Codex item that say what it was called with.
 *
 * There is no known input shape for an item type this build has not seen, so
 * the envelope keys come off and whatever is left is shown. Blanking it — which
 * this used to do — renders a failed lookup as a step with no query on it,
 * indistinguishable from one that was never asked anything.
 */
function codexItemInput(item) {
  const input = {};
  for (const [key, value] of Object.entries(item)) {
    if (!CODEX_ENVELOPE_KEYS.has(key)) input[key] = value;
  }
  return input;
}

function normaliseCodex(event, state) {
  const out = [];
  const item = event.item ?? {};
  const kind = item.item_type ?? item.type ?? null;

  switch (event.type) {
    case "thread.started":
      state.sessionId = event.thread_id ?? state.sessionId;
      out.push({ type: "session", sessionId: event.thread_id ?? null, model: null, cwd: null, tools: [] });
      break;

    case "item.started":
    case "item.updated":
    case "item.completed": {
      const done = event.type === "item.completed";
      /*
        A Codex item reports its own failure on itself. Reading that here rather
        than in each branch is what stops a step that failed from rendering as a
        green completed one: every branch below now derives its status from it.
      */
      const error = done ? codexItemError(item) : null;

      if (kind === "agent_message") {
        if (done && item.text) out.push({ type: "token", text: item.text });
      } else if (kind === "reasoning") {
        const text = item.text ?? item.summary ?? "";
        if (done && text) out.push({ type: "reasoning", text });
      } else if (kind === "command_execution") {
        // A command that never ran reports no exit code at all, so the absence
        // of one stays a success — but an error on the item is still a failure.
        const commandFailed = error != null || (item.exit_code != null && item.exit_code !== 0);
        out.push({
          type: "tool",
          id: item.id ?? `cmd-${out.length}`,
          name: "Bash",
          input: { command: item.command ?? "" },
          status: done ? (commandFailed ? "error" : "completed") : "running",
          isError: done && commandFailed,
          output: done ? (error ?? item.aggregated_output ?? "") : undefined,
        });
      } else if (kind === "file_change") {
        out.push({
          type: "tool",
          id: item.id ?? `edit-${out.length}`,
          name: "Edit",
          input: { changes: item.changes ?? item.path ?? null },
          status: done ? (error ? "error" : "completed") : "running",
          isError: error != null,
          output: done ? (error ?? item.unified_diff ?? "") : undefined,
        });
      } else if (kind === "mcp_tool_call") {
        out.push({
          type: "tool",
          id: item.id ?? `mcp-${out.length}`,
          name: `${item.server ?? "mcp"}.${item.tool ?? item.tool_name ?? "call"}`,
          input: item.arguments ?? {},
          status: done ? (error ? "error" : "completed") : "running",
          isError: error != null,
          output: done ? (error ?? JSON.stringify(item.result ?? null)) : undefined,
        });
      } else if (kind === "web_search") {
        out.push({
          type: "tool",
          id: item.id ?? `search-${out.length}`,
          name: "WebSearch",
          input: { query: item.query ?? "" },
          status: done ? (error ? "error" : "completed") : "running",
          isError: error != null,
          output: error ?? undefined,
        });
      } else if (kind === "error") {
        out.push({ type: "error", code: "AGENT_ITEM_ERROR", message: item.message ?? "The agent reported an error." });
      } else if (done && kind) {
        // An item type this build has not seen. Showing it as a tool step is
        // wrong far less often than dropping it, and dropping it silently would
        // make the transcript quietly incomplete.
        //
        // What it must not do is claim the step succeeded. This branch used to
        // hardcode "completed" with a blank input, so an unfamiliar tool that
        // FAILED rendered green, with no error and nothing to show what it was
        // asked — which is exactly how a delegated lookup came back empty and
        // looked fine.
        out.push({
          type: "tool",
          id: item.id ?? `item-${out.length}`,
          name: kind,
          input: codexItemInput(item),
          status: error ? "error" : "completed",
          isError: error != null,
          output: error ?? JSON.stringify(item),
        });
      }
      break;
    }

    case "turn.completed":
      out.push({
        type: "result",
        ok: true,
        durationMs: null,
        costUsd: null,
        sessionId: state.sessionId,
        usage: codexUsage(event),
        text: null,
        permissionDenials: [],
      });
      break;

    case "turn.failed":
      out.push({
        type: "result",
        ok: false,
        durationMs: null,
        costUsd: null,
        sessionId: state.sessionId,
        usage: null,
        text: event.error?.message ?? null,
        permissionDenials: [],
      });
      break;

    case "error":
      out.push({ type: "error", code: "AGENT_ERROR", message: event.message ?? "The agent reported an error." });
      break;

    default:
      break;
  }

  return out;
}

/**
 * Runs one turn and streams normalised events to `onEvent`.
 *
 * Resolves with the turn's summary. Never throws for an agent that merely
 * failed — a refused turn, a usage limit, a non-zero exit are all ordinary
 * answers the interface has to be able to render. It throws only when the turn
 * could not be started at all.
 */
export function runAgentTurn(options) {
  const {
    engine,
    prompt,
    root,
    cwd = "",
    images = [],
    sessionId = null,
    /*
      Branch the resumed thread instead of extending it.

      Meaningless without a `sessionId` and ignored there rather than refused:
      "fork nothing" is a fresh thread, which is what a turn with no id already
      is. See `argsFor` for each CLI's spelling of it.
    */
    fork = false,
    model = null,
    permission,
    effort = null,
    thinking = null,
    runId = null,
    screenControl = false,
    onEvent,
    signal,
    bin,
    timeoutMs = AGENT_LIMITS.timeoutMs,
    maxOutputBytes = AGENT_LIMITS.maxOutputBytes,
    env = agentEnvironment(),
  } = options;

  const agent = AGENTS[engine];
  if (!agent) throw new Error("UNKNOWN_AGENT");
  // `bin` lets an operator point at a CLI installed under a different name or
  // path, and lets the contract test drive a fake agent that emits canned
  // events — the parse and normalise path is then exercised for real.
  const binary = bin || agent.bin;

  const mode = agent.permissions.includes(permission) ? permission : agent.defaultPermission;
  /*
    An unrecognised level is dropped, not passed through and not an error.

    Both of these reach argv, and both CLIs fail the entire turn on a level
    they do not know — Claude Code on `--effort`, Codex on a `-c` value that
    will not deserialise. Falling back to the agent's own default (null: say
    nothing, let their config stand) turns a stale value from a persisted
    store, or a newer level from a CLI since downgraded, into a normal turn
    instead of a dead one.
  */
  const effortLevel = agent.efforts.includes(effort) ? effort : agent.defaultEffort;
  const thinkingLevel = agent.thinking.includes(thinking) ? thinking : agent.defaultThinking;
  const workingDirectory = resolveAgentCwd(root, cwd);

  /*
    Registered with the bridge before the CLI starts, because the first tool
    call can arrive before the first token does. Only Claude Code takes a
    prompt tool; Codex has its own sandbox flag and no equivalent, so it gets
    no bridge rather than a broken one.
  */
  const runToken = engine === "claude" && runId ? openRun(runId, onEvent) : null;
  const approval = runToken ? permissionMcpArgs(runId, runToken) : null;

  /*
    The screen, on the same run's token.

    It rides the approval bridge deliberately: the token that answers this
    run's prompts is the token that drives the screen on its behalf, so the two
    share one lifetime and `closeRun` takes both away at once. No approval
    bridge therefore means no hands — which is the intended reading of "a gate
    that cannot ask must not grant", not an accident of the wiring.
  */
  const screen = runToken
    ? screenMcpArgs(engine, runId, runToken, { available: screenControl })
    : null;

  /*
    The workspace UI, on the same run's token again.

    No `available` flag: unlike the screen there is no operating-system grant
    to wait on. The tree it moves is in the window that started this turn, and
    if that stream has closed the reveal is reported as not delivered rather
    than pretended.
  */
  const workspace = runToken ? workspaceMcpArgs(engine, runId, runToken) : null;

  /*
    The camera, on the same run's token again.

    No `available` flag and no capability check. Whether this machine has a
    webcam, and whether the operator will let it be opened, are both answered
    where they can actually be answered — in the window, when the tool is
    called — and an approval prompt stands between the two regardless. A probe
    here could only guess, and guessing wrong takes the tool away.
  */
  const camera = runToken ? cameraMcpArgs(engine, runId, runToken) : null;

  /*
    The browser panel, on the same run's token again.

    No `available` flag, for the camera's reason: whether a page is open is
    answered in the window when the tool is called, and a probe here could only
    guess. Separate from `workspace` because these seven tools ask questions
    and wait for answers, where `browse` only shows.
  */
  const browser = runToken ? browserMcpArgs(engine, runId, runToken) : null;

  /*
    The attachments, on disk where a CLI can read them.

    Written here rather than in the route because this is where the cwd has
    already been resolved and boundary-checked, and because `finish()` below is
    the one funnel every ending goes through — a normal exit, a timeout, an
    abort — so the cleanup can be hooked once instead of on four paths.
    Synchronous: the limits cap this at 5 MB, and a turn that has not started
    has nothing to interleave with. See server/agent-attachments.js.
  */
  const attachments = writeAgentImages({ cwd: workingDirectory, runId, images });

  const args = argsFor(engine, {
    prompt, cwd: workingDirectory, sessionId, fork, model, permission: mode,
    effort: effortLevel, thinking: thinkingLevel,
    approval, screen, workspace, camera, browser,
    imagePaths: attachments.paths,
  });

  const runEnv = { ...env };
  if (options.frontierMax) {
    const base = options.gatewayUrl || "http://127.0.0.1:4310";
    runEnv.ANTHROPIC_BASE_URL = `${base}/api/gemini`;
    const key = options.geminiApiKey || runEnv.GEMINI_API_KEY || "AIza-frontier-max";
    runEnv.ANTHROPIC_API_KEY = key;
    runEnv.ANTHROPIC_AUTH_TOKEN = key;
    runEnv.ANTHROPIC_MODEL = model || "gemini-3.8-flash";
  }

  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const state = { sessionId };
    /*
      Where a turn's seconds actually went.

      The audit log recorded one number per turn — the whole thing — which is
      enough to know that the median turn ran 29.6 seconds on 2026-09-12 and
      nothing at all about which part of it does. These four split that number: how long the
      CLI took to say anything (`startupMs`, its own cold start, measured from
      spawn to its first line of stdout), how long until the first word of the
      answer (`firstTokenMs`), and how much of the rest was spent inside tools
      rather than in the model (`toolMs` over `toolCalls`).

      Measured in the funnel every event already passes through, so no caller
      has to opt in and no code path can forget.
    */
    const timing = { startupMs: null, firstTokenMs: null, toolMs: 0, toolCalls: 0 };
    const toolStartedAt = new Map();
    let stdoutBytes = 0;
    let stderr = "";
    let buffer = "";
    let truncated = false;
    let settled = false;
    let summary = null;

    let child;
    try {
      child = spawnCommand(binary, args, {
        cwd: workingDirectory,
        env: runEnv,
        // stdin is closed rather than inherited: both CLIs block on a pipe they
        // are never going to be written to.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // A turn that never started never reaches `finish()`, so the one path
      // that bypasses the funnel cleans up on its own way out.
      removeAgentImages(attachments.dir);
      throw error;
    }

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever ends the turn ends its prompts: an approval whose agent has
      // exited can never be delivered anywhere.
      if (runId) closeRun(runId);
      // A tool the turn never finished has no "after" and never will.
      editWatcher?.close();
      // The attachments existed for this turn only. Nothing the operator did
      // not put there survives it.
      removeAgentImages(attachments.dir);
      resolvePromise({
        sessionId: state.sessionId,
        durationMs: Date.now() - startedAt,
        timing,
        truncated,
        reason: reason ?? null,
        stderr: stderr.slice(-4_000),
        summary,
      });
    };

    const kill = (reason) => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, AGENT_LIMITS.killGraceMs).unref?.();
      finish(reason);
    };

    const timer = setTimeout(() => kill("AGENT_TIMEOUT"), timeoutMs);
    const onAbort = () => kill("AGENT_ABORTED");
    signal?.addEventListener("abort", onAbort, { once: true });

    const emit = (event) => {
      if (event.type === "result") summary = event;
      if (timing.firstTokenMs === null && (event.type === "token" || event.type === "reasoning")) {
        timing.firstTokenMs = Date.now() - startedAt;
      }
      if (event.type === "tool" && event.id) {
        // A tool is reported twice, running then settled. Anything that only
        // ever arrives settled — an edit replayed from the watcher, say — has
        // no start to subtract and is counted as a call with no duration
        // rather than as one that took the whole turn.
        if (event.status === "running") toolStartedAt.set(event.id, Date.now());
        else if (toolStartedAt.has(event.id)) {
          timing.toolMs += Date.now() - toolStartedAt.get(event.id);
          timing.toolCalls += 1;
          toolStartedAt.delete(event.id);
        }
      }
      try {
        onEvent(event);
      } catch {
        /* A consumer that has gone away must not kill the child mid-turn. */
      }
    };

    /*
      What the agent writes, on its way to the review dock.

      Both CLIs edit the working tree in their own process, so the studio only
      learns of a write from the tool line reporting it. The watcher reads the
      file here, in the tick that line is parsed — the earliest moment anyone
      has — and puts an `edit` event carrying both sides on this same stream.
      See server/agent-edits.js for why that snapshot is checked rather than
      trusted, and why a `Write` whose snapshot lost the race is dropped.

      No root, no watching: a turn with nowhere to resolve a path against
      cannot say which file was touched, and must not guess.
    */
    const editWatcher = root ? createEditWatcher({ root, emit }) : null;

    const consumeLine = (line) => {
      const text = line.trim();
      if (!text) return;
      if (timing.startupMs === null) timing.startupMs = Date.now() - startedAt;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not every line is an event — a CLI may print a plain notice. Pass it
        // through as a notice rather than discarding it.
        emit({ type: "notice", text });
        return;
      }
      const events = engine === "claude" ? normaliseClaude(parsed, state) : normaliseCodex(parsed, state);
      for (const event of events) {
        emit(event);
        if (event.type === "tool") editWatcher?.onTool(event);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        truncated = true;
        kill("AGENT_OUTPUT_LIMIT");
        return;
      }
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        consumeLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on("error", (error) => {
      const missing = error?.code === "ENOENT";
      emit({
        type: "error",
        code: missing ? "AGENT_NOT_INSTALLED" : "AGENT_SPAWN_FAILED",
        message: missing
          ? `${agent.label} is not installed, or \`${agent.bin}\` is not on the gateway's PATH.`
          : `${agent.label} could not be started: ${error?.message ?? "unknown error"}`,
      });
      signal?.removeEventListener("abort", onAbort);
      finish(missing ? "AGENT_NOT_INSTALLED" : "AGENT_SPAWN_FAILED");
    });

    /*
      `close` fires when the process has exited AND every pipe has drained
      and shut — and a pipe outlives the process when a grandchild inherited
      it. An MCP server the agent spawned and did not take down holds the
      agent's stderr open for as long as it lives; the agent is gone, the
      transcript has its answer, and the panel says "Working" until that
      orphan dies. Operators reported exactly that on 0.0.2: a spinner that
      never resolved with no `claude` process left to point at.

      So `exit` starts a short clock. Whatever the pipes still hold arrives
      inside it or is not coming; then the streams are destroyed, which is
      what makes `close` fire, and the handler below ends the turn the way
      it always has.
    */
    let exitGrace = null;
    child.on("exit", () => {
      if (settled) return;
      exitGrace = setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, AGENT_LIMITS.exitGraceMs);
    });

    child.on("close", (code) => {
      if (exitGrace) clearTimeout(exitGrace);
      if (buffer.trim()) consumeLine(buffer);
      signal?.removeEventListener("abort", onAbort);
      // A non-zero exit with no result event of its own still has to reach the
      // transcript, or the turn just stops with no explanation.
      if (!summary && !settled) {
        emit({
          type: "result",
          ok: code === 0,
          durationMs: Date.now() - startedAt,
          costUsd: null,
          sessionId: state.sessionId,
          usage: null,
          text: code === 0 ? null : stderr.trim().slice(-2_000) || `${agent.label} exited with status ${code}.`,
          permissionDenials: [],
        });
      }
      finish(code === 0 ? null : "AGENT_NONZERO_EXIT");
    });
  });
}

/** Whether each agent is actually installed, for the pane to render honestly. */
export async function agentAvailability(env = agentEnvironment()) {
  const entries = await Promise.all(
    Object.entries(AGENTS).map(async ([engine, agent]) => {
      const version = await new Promise((resolvePromise) => {
        const child = spawnCommand(agent.bin, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise(null);
        }, 5_000);
        child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
        child.on("error", () => { clearTimeout(timer); resolvePromise(null); });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolvePromise(code === 0 ? out.trim().split("\n")[0] || null : null);
        });
      });
      return [engine, {
        label: agent.label,
        bin: agent.bin,
        installed: version !== null,
        version,
        permissions: agent.permissions,
        defaultPermission: agent.defaultPermission,
        efforts: agent.efforts,
        defaultEffort: agent.defaultEffort,
        thinking: agent.thinking,
        defaultThinking: agent.defaultThinking,
      }];
    }),
  );
  return Object.fromEntries(entries);
}
