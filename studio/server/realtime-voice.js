/**
 * Supervisor for the realtime voice assistant.
 *
 * The pipeline lives in `studio/realtime-voice/` — a Python process that owns
 * recognition, the conversation loop and synthesis together, and talks to the
 * renderer over one WebSocket. Holding all three in a single process is what
 * buys the sub-second turn: a transcript never crosses a process boundary to
 * reach the model, and a token never crosses one to reach the voice.
 *
 * That design has a cost, and this module is the payment. The process is
 * heavy — a 2 GB virtualenv and model weights that load for tens of seconds —
 * so it cannot be started per request, and it is not Node, so it cannot be
 * imported. It has to be a supervised child, and until now it was not
 * supervised at all: the operator ran `python server.py` in a terminal and
 * voice died silently when that terminal closed.
 *
 * Three rules shape what follows.
 *
 *   Adopt before spawning. A developer with the server already running on the
 *   port is the normal case in this repo, and spawning a second one would fail
 *   on bind and look like a broken install. If something healthy answers, the
 *   supervisor uses it and never claims the right to kill it.
 *
 *   Absent is not broken. No checkout, no interpreter, no weights — each is a
 *   normal answer that leaves the studio on the VibeVoice sidecar and then the
 *   browser engine. Voice degrades; it does not disappear. Nothing here throws
 *   into gateway startup.
 *
 *   Give up loudly, not silently. A crash loop on a broken virtualenv burns
 *   CPU and tells the operator nothing, so restarts are capped and the last
 *   lines the process printed are kept for the status route to show. The
 *   failure a user can read is worth more than the retry they cannot see.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Restart attempts before the supervisor stops trying and reports why. */
const MAX_RESTARTS = 3;
/** Backoff between restarts. Long enough that a bind race resolves itself. */
const RESTART_BACKOFF_MS = [2_000, 8_000, 30_000];
/** Health probes are cheap by construction; a slow answer means unhealthy. */
const PROBE_TIMEOUT_MS = 2_000;
/** How often to re-probe while waiting for weights to finish loading. */
const READY_POLL_MS = 1_000;
/** Output lines kept for diagnostics. Enough to hold a Python traceback. */
const LOG_LINES = 40;

/**
 * Where the interpreter with the pipeline's wheels lives.
 *
 * The virtualenv inside the checkout is the answer in every case we ship, but
 * an operator who installed the requirements elsewhere sets the config key and
 * is believed without inspection — verifying an interpreter means running it,
 * and gateway startup is not the place to run someone's Python.
 *
 * @param {object} config Gateway configuration.
 * @param {(path: string) => boolean} exists Filesystem probe, injected for tests.
 * @returns {string} An interpreter path, or "" when none was found.
 */
export function resolveRealtimeVoicePython(config, exists = existsSync) {
  if (config.realtimeVoicePython) return config.realtimeVoicePython;
  const root = config.realtimeVoiceRoot;
  if (!root) return "";
  const candidates = [
    join(root, ".venv", "bin", "python"),
    join(root, ".venv", "Scripts", "python.exe"),
  ];
  return candidates.find((candidate) => exists(candidate)) || "";
}

/**
 * Decide what to do about the voice pipeline, without doing any of it.
 *
 * Pure, so every branch that matters — disabled, no checkout, no interpreter,
 * something already listening — is testable without a Python, a port or a
 * clock. The impure half below does nothing this function has not decided.
 *
 * @param {object} options
 * @param {object} options.config Gateway configuration.
 * @param {boolean} options.healthy Whether a server already answers on the port.
 * @param {boolean} [options.portBusy] Whether anything at all holds the port.
 * @param {(path: string) => boolean} [options.exists] Filesystem probe.
 * @returns {{action: "disabled"|"adopt"|"await"|"spawn"|"unavailable", reason: string, detail: string, command?: string, args?: string[], cwd?: string, env?: Record<string,string>}}
 */
export function planRealtimeVoiceLaunch({ config, healthy, portBusy = false, exists = existsSync }) {
  const url = config.realtimeVoiceUrl ? new URL(String(config.realtimeVoiceUrl)) : null;

  // Adoption is checked before autostart on purpose: a server the operator
  // started by hand is usable whether or not this studio would have started
  // one, and refusing to speak to it because autostart is off would be a
  // setting punishing the person who read it.
  if (healthy) {
    return { action: "adopt", reason: "already-listening", detail: `Using the voice pipeline already answering on ${url ? url.host : "the configured port"}.` };
  }

  // Busy but not healthy is the case that cost us a crash loop: a pipeline
  // still loading its weights, or an older build without /health, holds the
  // port without answering. Spawning there fails on bind and reads as a broken
  // install. Wait for it instead — it is either about to be ready, or it is
  // something else entirely, and the timeout says so in words.
  if (portBusy) {
    return { action: "await", reason: "port-busy", detail: `Something already holds ${url ? url.host : "the configured port"}; waiting for it to answer rather than starting a second pipeline.` };
  }

  if (!config.realtimeVoiceAutostart) {
    return { action: "disabled", reason: "autostart-off", detail: "TEMINALI_REALTIME_VOICE_AUTOSTART=0; the studio will not start the voice pipeline." };
  }

  const root = config.realtimeVoiceRoot;
  if (!root || !exists(root)) {
    return { action: "unavailable", reason: "no-checkout", detail: `No voice pipeline at ${root || "(unset)"}. Voice falls back to the local engines.` };
  }

  const entry = join(root, "code", "server.py");
  if (!exists(entry)) {
    return { action: "unavailable", reason: "no-entry-point", detail: `${entry} is missing. Voice falls back to the local engines.` };
  }

  const python = resolveRealtimeVoicePython(config, exists);
  if (!python) {
    return { action: "unavailable", reason: "no-interpreter", detail: `No Python with the voice pipeline's requirements under ${join(root, ".venv")}. Run its install, or set TEMINALI_REALTIME_VOICE_PYTHON.` };
  }

  return {
    action: "spawn",
    reason: "not-running",
    detail: `Starting the voice pipeline with ${python}.`,
    command: python,
    args: ["server.py"],
    cwd: join(root, "code"),
    env: {
      // The child is told its own address rather than inferring one, so the
      // port only ever has a single source of truth: this configuration.
      HOST: url ? url.hostname : "127.0.0.1",
      PORT: url && url.port ? url.port : "8000",
      // Unbuffered, or a traceback sits in a pipe buffer while the operator
      // stares at a status route saying only that the process exited.
      PYTHONUNBUFFERED: "1",
    },
  };
}

/**
 * The WebSocket address the renderer should dial, derived from the HTTP one so
 * that changing the port changes both.
 *
 * @param {URL|string|null} httpUrl The pipeline's HTTP base.
 * @returns {string} A ws:// or wss:// URL, or "" when there is no base.
 */
export function realtimeVoiceSocketUrl(httpUrl) {
  if (!httpUrl) return "";
  const url = new URL(String(httpUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

/**
 * Build the supervisor. Nothing starts until `start()` is called.
 *
 * @param {object} options
 * @param {object} options.config Gateway configuration.
 * @param {(message: string) => void} [options.log] Where to report transitions.
 * @param {typeof spawn} [options.spawnProcess] Injected for tests.
 * @param {(url: URL) => Promise<boolean>} [options.probe] Injected for tests.
 * @param {(url: URL) => Promise<boolean>} [options.portBusyProbe] Injected for tests.
 */
export function createRealtimeVoiceSupervisor({ config, log = () => {}, spawnProcess = spawn, probe, portBusyProbe } = {}) {
  const url = config.realtimeVoiceUrl ? new URL(String(config.realtimeVoiceUrl)) : null;

  let child = null;          // Only ever the process we spawned ourselves.
  let adopted = false;       // True when someone else's server is in use.
  let state = "stopped";     // stopped | starting | ready | unavailable | failed
  let detail = "";
  let reason = "";
  let restarts = 0;
  let lastExit = null;
  let stopping = false;
  let readyTimer = null;
  let restartTimer = null;
  const recentOutput = [];

  function remember(line) {
    for (const part of String(line).split("\n")) {
      const text = part.trimEnd();
      if (!text) continue;
      recentOutput.push(text);
      if (recentOutput.length > LOG_LINES) recentOutput.shift();
    }
  }

  /** Is a voice pipeline answering? Cheap enough to poll every second. */
  async function isHealthy() {
    if (!url) return false;
    if (probe) return probe(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(new URL("/health", url), { signal: controller.signal });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      // `ok: false` is a pipeline whose weights have not finished loading. It
      // is listening, but dialling it now would fail the first turn, so it is
      // not yet healthy for our purposes.
      return Boolean(body && body.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Does anything hold the port? A TCP connect and nothing more — the answer
   * is only used to choose between waiting and spawning, and a probe that
   * spoke the protocol would be a probe that could hang.
   */
  async function isPortBusy() {
    if (!url) return false;
    if (portBusyProbe) return portBusyProbe(url);
    return new Promise((resolve) => {
      const socket = connect({ host: url.hostname, port: Number(url.port || 80) });
      const settle = (busy) => { socket.destroy(); resolve(busy); };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    });
  }

  function clearTimers() {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  /**
   * Poll until the pipeline answers, or until the startup budget runs out.
   * Loading weights on a cold cache is genuinely slow, and a supervisor that
   * killed the process at 30 seconds would guarantee it never started at all.
   */
  function awaitReady(deadline) {
    readyTimer = setTimeout(async () => {
      readyTimer = null;
      if (stopping || state !== "starting") return;
      if (await isHealthy()) {
        state = "ready";
        detail = adopted ? detail : "The voice pipeline is ready.";
        log("Realtime voice pipeline is ready.");
        return;
      }
      if (Date.now() >= deadline) {
        state = "failed";
        reason = "startup-timeout";
        const seconds = Math.round(config.realtimeVoiceStartupTimeoutMs / 1000);
        // An adopted port that never answers is a different diagnosis from a
        // child of ours that never answers, and the operator has to act on it
        // differently: stop the other program, versus fix this install.
        detail = adopted
          ? `Something has held ${url ? url.host : "the voice port"} for ${seconds}s without answering as the voice pipeline. Stop it, or point TEMINALI_REALTIME_VOICE_URL elsewhere.`
          : `The voice pipeline did not answer within ${seconds}s.`;
        log(detail);
        return;
      }
      awaitReady(deadline);
    }, READY_POLL_MS);
    if (typeof readyTimer.unref === "function") readyTimer.unref();
  }

  function scheduleRestart() {
    if (stopping || restarts >= MAX_RESTARTS) {
      if (restarts >= MAX_RESTARTS) {
        state = "failed";
        reason = "restart-limit";
        detail = `The voice pipeline exited ${restarts} times; not restarting it again. Its last output is in this status.`;
        log(detail);
      }
      return;
    }
    const wait = RESTART_BACKOFF_MS[Math.min(restarts, RESTART_BACKOFF_MS.length - 1)];
    restarts += 1;
    log(`Restarting the realtime voice pipeline in ${wait}ms (attempt ${restarts} of ${MAX_RESTARTS}).`);
    restartTimer = setTimeout(() => { restartTimer = null; void start(); }, wait);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  function launch(plan) {
    const proc = spawnProcess(plan.command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    adopted = false;
    state = "starting";
    reason = plan.reason;
    detail = plan.detail;

    proc.stdout?.on("data", (chunk) => remember(chunk.toString()));
    proc.stderr?.on("data", (chunk) => remember(chunk.toString()));

    proc.on("error", (error) => {
      // A spawn that never became a process: a bad interpreter path, usually.
      child = null;
      state = "failed";
      reason = "spawn-failed";
      detail = `Could not start the voice pipeline: ${error instanceof Error ? error.message : "unknown error"}`;
      remember(detail);
      log(detail);
    });

    proc.on("exit", (code, signal) => {
      if (child === proc) child = null;
      lastExit = { code, signal, at: new Date().toISOString() };
      clearTimers();
      if (stopping) {
        state = "stopped";
        return;
      }
      state = "failed";
      reason = "exited";
      detail = `The voice pipeline exited (${signal ? `signal ${signal}` : `code ${code}`}).`;
      log(detail);
      scheduleRestart();
    });

    awaitReady(Date.now() + config.realtimeVoiceStartupTimeoutMs);
  }

  async function start() {
    if (stopping) return status();
    if (child || state === "ready") return status();

    const healthy = await isHealthy();
    const plan = planRealtimeVoiceLaunch({ config, healthy, portBusy: healthy ? true : await isPortBusy() });
    reason = plan.reason;
    detail = plan.detail;

    if (plan.action === "await") {
      // Not ours to kill and not yet answering. Poll on the same budget a
      // spawn would have had; whatever it is, it gets the same patience.
      adopted = true;
      state = "starting";
      log(plan.detail);
      awaitReady(Date.now() + config.realtimeVoiceStartupTimeoutMs);
      return status();
    }

    if (plan.action === "adopt") {
      adopted = true;
      state = "ready";
      restarts = 0;
      log(plan.detail);
      return status();
    }
    if (plan.action === "disabled" || plan.action === "unavailable") {
      state = plan.action === "disabled" ? "stopped" : "unavailable";
      log(plan.detail);
      return status();
    }

    log(plan.detail);
    launch(plan);
    return status();
  }

  /**
   * Stop only what we started. An adopted server belongs to whoever started
   * it, and killing another program's process on the way out of ours is the
   * kind of tidiness nobody asked for.
   */
  async function stop({ graceMs = 5_000 } = {}) {
    stopping = true;
    clearTimers();
    const proc = child;
    if (!proc) {
      state = adopted ? "stopped" : state;
      return;
    }
    await new Promise((resolve) => {
      const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, graceMs);
      if (typeof kill.unref === "function") kill.unref();
      proc.once("exit", () => { clearTimeout(kill); resolve(); });
      try { proc.kill("SIGTERM"); } catch { clearTimeout(kill); resolve(); }
    });
    child = null;
    state = "stopped";
  }

  function status() {
    return {
      enabled: Boolean(config.realtimeVoiceAutostart),
      state,
      reason,
      detail,
      adopted,
      supervised: Boolean(child),
      ready: state === "ready",
      url: url ? url.toString() : "",
      socketUrl: realtimeVoiceSocketUrl(url),
      restarts,
      lastExit,
      recentOutput: recentOutput.slice(-LOG_LINES),
    };
  }

  return { start, stop, status, isHealthy };
}
