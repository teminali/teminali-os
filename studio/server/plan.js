/**
 * Plan headroom, and who the operator is signed in as.
 *
 * This answers a different question from server/usage-ledger.js. The ledger
 * answers "what have I spent" — the tokens and dollars this machine has
 * recorded. This answers "how much of my plan is left, and when does it come
 * back", which is a number only the provider knows and only the provider can
 * report.
 *
 * Both halves are taken from the CLI rather than from the provider's API
 * directly, because the CLI already holds the operator's credentials and this
 * process has no business reaching into their keychain entry to borrow them:
 *
 *   - The **windows** ride the turn. `claude -p --output-format stream-json`
 *     emits a `rate_limit_event` carrying `unifiedWindows` — the same five-hour
 *     and seven-day utilisation Claude Code shows itself. It costs nothing
 *     extra: server/agent-cli.js is already parsing that stream, and normalises
 *     the event into a `limits` event on the way past.
 *   - The **account** comes from `claude auth status --json`, a documented
 *     subcommand. It is a process spawn rather than a file read, so it is
 *     cached.
 *
 * One consequence has to be stated in the UI rather than hidden: **the windows
 * only move when a turn runs.** Between turns this is the last thing observed,
 * not the live figure. Every reading is therefore stamped with when it was
 * taken, and the panel prints that stamp.
 *
 * Codex has no equivalent. `codex exec --json` emits no rate-limit event — its
 * limits travel over the `codex app-server` protocol, which the studio does not
 * speak — so its account is reported and its headroom is not. Reporting a blank
 * meter for Codex would read as "no usage" rather than as "not knowable here".
 *
 * Only a subscription login has a plan at all. An API-key turn emits no
 * `rate_limit_event`, so an empty store is an ordinary state and not a fault.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { AGENTS, agentEnvironment } from "./agent-cli.js";

/** A spawn that cannot hang the panel behind a CLI waiting on something. */
const PROBE_TIMEOUT_MS = 5_000;

/** `claude auth status` is a process, not a read. Re-probed at most this often. */
const ACCOUNT_CACHE_MS = 60_000;

let accountCache = null;

/**
 * Remember the windows a turn just reported.
 *
 * Written whole rather than merged per window: the CLI reports the complete set
 * it knows about each time, so a window that has stopped being reported has
 * stopped applying, and carrying it forward would leave a stale bar on screen
 * that nothing will ever clear.
 */
export async function recordPlanLimits(storePath, engine, event) {
  const windows = Array.isArray(event?.windows) ? event.windows : [];
  if (windows.length === 0) return;

  const store = await readStore(storePath);
  store[engine] = {
    observedAt: new Date().toISOString(),
    status: typeof event.status === "string" ? event.status : null,
    isUsingOverage: Boolean(event.isUsingOverage),
    windows: windows.map((window) => ({
      id: String(window.id),
      utilization: Number(window.utilization),
      resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
    })),
  };

  try {
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch {
    /* Losing a meter reading must never fail the turn that produced it. */
  }
}

/** The last windows each engine reported. `{}` before the first turn. */
export async function readPlanLimits(storePath) {
  return readStore(storePath);
}

async function readStore(storePath) {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Who each CLI says it is signed in as.
 *
 * `claude auth status --json` is exact and machine-readable. `codex login
 * status` prints a sentence and offers no JSON, so it is reported as the
 * sentence it printed rather than parsed into fields that would be invented.
 */
export async function agentAccounts(env = agentEnvironment()) {
  if (accountCache && Date.now() - accountCache.at < ACCOUNT_CACHE_MS) return accountCache.value;

  const [claude, codex] = await Promise.all([claudeAccount(env), codexAccount(env)]);
  const value = { claude, codex };
  accountCache = { at: Date.now(), value };
  return value;
}

/** Cleared when a login happens, so the panel does not show a stale identity. */
export function forgetAccountCache() {
  accountCache = null;
}

async function claudeAccount(env) {
  const probe = await runProbe(AGENTS.claude.bin, ["auth", "status", "--json"], env);
  if (!probe.ok) return offline(probe);

  try {
    const parsed = JSON.parse(probe.stdout);
    return {
      loggedIn: Boolean(parsed.loggedIn),
      // "claude.ai" is a subscription login and the only one with a plan behind
      // it; "api-key" and the Bedrock/Vertex logins bill per token and report
      // no windows. The panel needs the distinction to explain an empty meter.
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      organization: typeof parsed.orgName === "string" ? parsed.orgName : null,
      plan: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
      detail: null,
    };
  } catch {
    return { loggedIn: false, authMethod: null, email: null, organization: null, plan: null, detail: "Auth status could not be read." };
  }
}

async function codexAccount(env) {
  const probe = await runProbe(AGENTS.codex.bin, ["login", "status"], env);
  if (!probe.ok) return offline(probe);

  // Observed, not assumed: `codex login status` prints its one line to stderr
  // and leaves stdout empty. Reading stdout alone reports a signed-in operator
  // as a blank.
  const printed = probe.stdout.trim() || probe.stderr.trim();
  const line = printed.split("\n")[0]?.trim() || null;
  return {
    // The CLI exits non-zero when signed out, so reaching here at all is the
    // answer; the sentence is passed through as the detail rather than being
    // pattern-matched into fields it does not contain.
    loggedIn: true,
    authMethod: null,
    email: null,
    organization: null,
    plan: null,
    detail: line,
  };
}

function offline(probe) {
  return {
    loggedIn: false,
    authMethod: null,
    email: null,
    organization: null,
    plan: null,
    // "not installed" and "installed but signed out" are different problems
    // with different fixes, and the operator is entitled to know which they have.
    detail: probe.missing ? "Not installed." : probe.stderr || "Not signed in.",
  };
}

function runProbe(bin, args, env) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolvePromise({ ok: false, missing: true, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, missing: false, stdout: "", stderr: "Timed out." });
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      settle({ ok: false, missing: error?.code === "ENOENT", stdout: "", stderr: "" });
    });
    child.on("close", (code) => {
      settle({ ok: code === 0, missing: false, stdout, stderr: stderr.trim().slice(-200) });
    });
  });
}
