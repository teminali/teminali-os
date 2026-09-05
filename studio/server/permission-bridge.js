/**
 * Answering a headless agent's permission prompts.
 *
 * `claude -p` has no terminal. Anything its permission mode does not settle
 * outright is therefore refused by default, which is the failure the operator
 * sees as "I can't launch VLC — the command needs your approval and this
 * session can't prompt for it": the turn ends having done nothing, and the
 * only way forward was to widen the mode for every future call as well.
 *
 * The CLI's way out is `--permission-prompt-tool`: name an MCP tool and it is
 * called instead of the terminal prompt. This is the other end of that tool.
 *
 * ## Why a token per run rather than the session bearer
 *
 * `agentEnvironment()` deletes `FRONTIER_SESSION_TOKEN` before spawning an
 * agent, so a CLI that shells out cannot turn around and drive the gateway.
 * Handing the shim that same token would undo it. Instead each run mints its
 * own, it reaches exactly one route, it authorises nothing but answering that
 * run's own prompts, and it dies with the run.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** A prompt nobody answers must not hold the agent open indefinitely. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** runId -> { token, emit, pending, remembered, closed } */
const runs = new Map();

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * What makes two requests "the same permission" for the purpose of
 * "always allow". The tool name alone is too coarse — allowing one `Bash`
 * would allow every command for the rest of the run — so a Bash call is keyed
 * by its first word, which is the thing an operator actually means to trust.
 */
export function approvalKey(toolName, input) {
  const name = String(toolName ?? "");
  if (name !== "Bash") return name;
  const command = String(input?.command ?? "").trim();
  const head = command.split(/\s+/)[0] ?? "";
  return head ? `Bash(${head})` : "Bash";
}

/** Begin a run. `emit` puts an event on that run's NDJSON stream. */
export function openRun(runId, emit) {
  const token = randomBytes(32).toString("base64url");
  runs.set(runId, { token, emit, pending: new Map(), remembered: new Set(), closed: false });
  return token;
}

/**
 * End a run. Every prompt still outstanding is denied: the process that asked
 * is gone, and a promise left hanging would keep a timer alive for five
 * minutes for an answer that can no longer be delivered anywhere.
 */
export function closeRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  run.closed = true;
  for (const entry of run.pending.values()) {
    clearTimeout(entry.timer);
    entry.settle({ behavior: "deny", message: "The agent turn ended before this was answered." });
  }
  run.pending.clear();
  runs.delete(runId);
}

export function runCount() {
  return runs.size;
}

/**
 * Ask the operator. Resolves with a verdict in the shape the CLI expects:
 * `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`.
 *
 * Never rejects. Every failure — an unknown run, a bad token, a prompt nobody
 * answered — is a denial with a reason, because a rejection here would surface
 * to the agent as a broken tool rather than as an answer it can act on.
 */
export function requestApproval({ runId, token, toolName, input = {} }) {
  const run = runs.get(runId);
  if (!run || run.closed) {
    return Promise.resolve({ behavior: "deny", message: "That agent turn is no longer running." });
  }
  if (!constantTimeEqual(token, run.token)) {
    return Promise.resolve({ behavior: "deny", message: "The permission bridge rejected the caller." });
  }

  const key = approvalKey(toolName, input);
  if (run.remembered.has(key)) {
    return Promise.resolve({ behavior: "allow", updatedInput: input });
  }

  const id = randomBytes(9).toString("base64url");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      resolve(verdict);
    };
    const timer = setTimeout(() => {
      run.pending.delete(id);
      run.emit?.({ type: "permission-resolved", id, behavior: "deny" });
      settle({ behavior: "deny", message: "Nobody answered the approval request in time." });
    }, APPROVAL_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    // The input is kept so an allow that edits nothing can still answer with
    // it: the CLI runs `updatedInput`, and an allow that omits it runs nothing.
    run.pending.set(id, { settle, timer, key, input });
    run.emit?.({ type: "permission", id, toolName, input, key, expiresInMs: APPROVAL_TIMEOUT_MS });
  });
}

/**
 * The operator's answer, arriving on its own request because the run's stream
 * only goes one way. `remember` promotes an allow to every later call with the
 * same `approvalKey` for the rest of this run.
 */
export function resolveApproval({ runId, id, behavior, message, updatedInput, remember = false }) {
  const run = runs.get(runId);
  if (!run) return { ok: false, reason: "No such agent run." };
  const entry = run.pending.get(id);
  if (!entry) return { ok: false, reason: "That request was already answered." };

  run.pending.delete(id);
  clearTimeout(entry.timer);

  if (behavior === "allow") {
    if (remember) run.remembered.add(entry.key);
    entry.settle({ behavior: "allow", updatedInput: updatedInput ?? entry.input ?? {} });
  } else {
    entry.settle({ behavior: "deny", message: message || "The operator declined this." });
  }
  run.emit?.({ type: "permission-resolved", id, behavior: behavior === "allow" ? "allow" : "deny" });
  return { ok: true };
}

/**
 * Does this token belong to this live run?
 *
 * The screen bridge asks, because it needs the same answer for a different
 * question. A run's token was minted to answer that run's approval prompts;
 * this widens it to also drive the screen on that run's behalf, and the
 * widening is deliberate rather than incidental: both are "this agent turn,
 * and only while it is running". The alternative was a second token with a
 * second lifecycle to keep in step with this one, which is a leak waiting to
 * be written.
 *
 * The authority this grants is still narrow. It reaches two routes, it opens
 * no others, and `closeRun` takes it away the moment the turn ends.
 */
export function runAuthorises(runId, token) {
  const run = runs.get(runId);
  if (!run || run.closed) return false;
  return constantTimeEqual(token, run.token);
}
