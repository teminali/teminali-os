import { createHash, randomUUID } from "node:crypto";
import { AgentRuntimeError, throwIfAborted } from "./errors.js";
import { StateStore } from "./state-store.js";
import { WorkspaceTools, patchSignature } from "./workspace-tools.js";

const STATES = new Set(["inspect", "plan", "edit", "verify", "repair", "review", "report", "complete"]);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateOptions(options) {
  if (!options?.workspace || !options?.objective || !Array.isArray(options.acceptanceCriteria) || options.acceptanceCriteria.length === 0) {
    throw new AgentRuntimeError("INVALID_RUN_CONFIG", "workspace, objective, and non-empty acceptanceCriteria are required.");
  }
  if (!Array.isArray(options.verifyCommands) || options.verifyCommands.length === 0) {
    throw new AgentRuntimeError("INVALID_RUN_CONFIG", "At least one verification command is required.");
  }
  if (!options.planner || ["plan", "repair", "review"].some((method) => typeof options.planner[method] !== "function")) {
    throw new AgentRuntimeError("INVALID_RUN_CONFIG", "The planner must implement plan, repair, and review.");
  }
}

function usageSummary(calls) {
  const promptKnown = calls.every((call) => Number.isInteger(call.promptTokens));
  const completionKnown = calls.every((call) => Number.isInteger(call.completionTokens));
  const durationKnown = calls.every((call) => Number.isInteger(call.totalDurationNs));
  return {
    calls: calls.length,
    promptTokens: promptKnown ? calls.reduce((sum, call) => sum + call.promptTokens, 0) : null,
    completionTokens: completionKnown ? calls.reduce((sum, call) => sum + call.completionTokens, 0) : null,
    totalDurationNs: durationKnown ? calls.reduce((sum, call) => sum + call.totalDurationNs, 0) : null,
    complete: promptKnown && completionKnown && durationKnown,
    records: calls,
  };
}

export class SingleAgentRuntime {
  constructor(options) {
    validateOptions(options);
    this.options = options;
    this.runId = options.runId || randomUUID();
    this.planner = options.planner;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
    this.tools = options.tools || new WorkspaceTools({
      workspace: options.workspace,
      editablePaths: options.editablePaths,
      allowedCommands: options.allowedCommands,
      maxFileBytes: options.maxFileBytes,
      maxFiles: options.maxFiles,
      maxOutputBytes: options.maxOutputBytes,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    this.store = options.store || new StateStore(options.workspace, options.stateDirectory);
  }

  async run(signal) {
    await this.tools.initialize();
    let state = await this.store.load(this.runId);
    if (!state) state = this.#newState();
    else this.#validateResume(state);
    if (state.status === "completed") return state.report;
    state.status = "running";
    state.lastError = null;
    await this.store.save(state);

    try {
      while (state.state !== "complete") {
        throwIfAborted(signal);
        if (state.state === "inspect") await this.#inspect(state);
        else if (state.state === "plan") await this.#plan(state, signal);
        else if (state.state === "edit") await this.#edit(state);
        else if (state.state === "verify") await this.#verify(state, signal);
        else if (state.state === "repair") await this.#repair(state, signal);
        else if (state.state === "review") await this.#review(state, signal);
        else if (state.state === "report") await this.#report(state);
        else throw new AgentRuntimeError("INVALID_STATE", `Unsupported agent state: ${state.state}`);
      }
      return state.report;
    } catch (error) {
      state.status = error?.code === "CANCELLED" ? "cancelled" : "failed";
      state.lastError = { code: error?.code || "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : "Unknown runtime error", at: new Date().toISOString() };
      await this.store.save(state);
      throw error;
    }
  }

  #newState() {
    return {
      version: 1,
      runId: this.runId,
      objective: this.options.objective,
      acceptanceCriteria: this.options.acceptanceCriteria,
      editablePaths: [...this.options.editablePaths],
      verifyCommands: this.options.verifyCommands,
      state: "inspect",
      status: "running",
      createdAt: new Date().toISOString(),
      startedEpochMs: Date.now(),
      updatedAt: new Date().toISOString(),
      repairAttempts: 0,
      baselineHashes: null,
      plans: { edit: null, repairs: [] },
      activeEdits: [],
      editCursor: 0,
      failedVerificationSignatures: [],
      evidence: { transitions: [], toolCalls: [], verifications: [], modelCalls: [] },
      review: null,
      report: null,
      lastError: null,
    };
  }

  #validateResume(state) {
    if (state.version !== 1 || state.runId !== this.runId || !STATES.has(state.state)) throw new AgentRuntimeError("INCOMPATIBLE_STATE", "Persisted state is incompatible with this runtime.");
    if (state.objective !== this.options.objective || JSON.stringify(state.acceptanceCriteria) !== JSON.stringify(this.options.acceptanceCriteria) || JSON.stringify(state.editablePaths) !== JSON.stringify(this.options.editablePaths) || JSON.stringify(state.verifyCommands) !== JSON.stringify(this.options.verifyCommands)) {
      throw new AgentRuntimeError("RESUME_CONFIG_MISMATCH", "The resumed run configuration differs from its persisted state.");
    }
  }

  async #transition(state, next) {
    state.evidence.transitions.push({ from: state.state, to: next, at: new Date().toISOString() });
    state.state = next;
    state.updatedAt = new Date().toISOString();
    await this.store.save(state);
  }

  async #inspect(state) {
    const files = await this.tools.inspect();
    state.baselineHashes ||= Object.fromEntries(files.map((file) => [file.path, file.sha256]));
    state.evidence.toolCalls.push({ tool: "inspect", files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
    await this.#transition(state, "plan");
  }

  async #plan(state, signal) {
    const snapshot = await this.tools.inspect();
    const result = await this.planner.plan(this.#modelContext(state, { snapshot }), signal);
    this.#recordModelCall(state, "plan", result.usage);
    state.plans.edit = result.value;
    state.activeEdits = result.value.edits;
    state.editCursor = 0;
    await this.#transition(state, "edit");
  }

  async #edit(state) {
    while (state.editCursor < state.activeEdits.length) {
      const result = await this.tools.applyPatch(state.activeEdits[state.editCursor]);
      state.evidence.toolCalls.push(result);
      state.editCursor += 1;
      await this.store.save(state);
    }
    await this.#transition(state, "verify");
  }

  async #verify(state, signal) {
    const results = [];
    for (const command of state.verifyCommands) {
      const result = await this.tools.run(command, signal);
      results.push(result);
      state.evidence.toolCalls.push(result);
      await this.store.save(state);
    }
    const passed = results.every((result) => result.passed);
    const verification = { attempt: state.evidence.verifications.length + 1, passed, commands: results, at: new Date().toISOString() };
    state.evidence.verifications.push(verification);
    if (passed) {
      await this.#transition(state, "review");
      return;
    }
    const signature = digest(results.map(({ argv, exitCode, signal: childSignal, stdout, stderr, timedOut, outputTruncated }) => ({ argv, exitCode, signal: childSignal, stdout, stderr, timedOut, outputTruncated })));
    if (state.failedVerificationSignatures.includes(signature)) {
      throw new AgentRuntimeError("LOOP_DETECTED", "Verification produced the same failure twice; the agent stopped instead of looping.");
    }
    state.failedVerificationSignatures.push(signature);
    await this.#transition(state, "repair");
  }

  async #repair(state, signal) {
    if (state.repairAttempts >= this.maxRepairAttempts) throw new AgentRuntimeError("RETRY_BUDGET_EXHAUSTED", `Repair budget of ${this.maxRepairAttempts} attempt(s) was exhausted.`);
    const snapshot = await this.tools.inspect();
    const lastVerification = state.evidence.verifications.at(-1);
    const result = await this.planner.repair(this.#modelContext(state, { snapshot, failedVerification: lastVerification, review: state.review }), signal);
    const signature = patchSignature(result.value.edits);
    const priorSignatures = state.plans.repairs.map((repair) => repair.signature);
    if (priorSignatures.includes(signature)) throw new AgentRuntimeError("LOOP_DETECTED", "The planner proposed the same repair patch twice.");
    this.#recordModelCall(state, "repair", result.usage);
    state.repairAttempts += 1;
    state.plans.repairs.push({ ...result.value, signature });
    state.activeEdits = result.value.edits;
    state.editCursor = 0;
    state.review = null;
    await this.#transition(state, "edit");
  }

  async #review(state, signal) {
    const currentHashes = await this.tools.hashes();
    const changedFiles = this.#changedFiles(state.baselineHashes, currentHashes);
    const unrelated = changedFiles.filter((file) => !state.editablePaths.includes(file.path));
    if (unrelated.length > 0) {
      throw new AgentRuntimeError("UNRELATED_FILE_CHANGED", "Files outside the declared edit scope changed during the run.", { paths: unrelated.map((file) => file.path) });
    }
    const result = await this.planner.review(this.#modelContext(state, { changedFiles, verification: state.evidence.verifications.at(-1) }), signal);
    this.#recordModelCall(state, "review", result.usage);
    state.review = result.value;
    if (!result.value.approved) {
      await this.#transition(state, "repair");
      return;
    }
    await this.#transition(state, "report");
  }

  async #report(state) {
    const latestVerification = state.evidence.verifications.at(-1);
    if (!latestVerification?.passed || !state.review?.approved) throw new AgentRuntimeError("UNVERIFIED_REPORT", "A successful report requires passing verification and an approved review.");
    const currentHashes = await this.tools.hashes();
    state.report = {
      runId: state.runId,
      status: "completed",
      objective: state.objective,
      acceptanceCriteria: state.acceptanceCriteria,
      changedFiles: this.#changedFiles(state.baselineHashes, currentHashes),
      toolCalls: state.evidence.toolCalls,
      verification: state.evidence.verifications,
      transitions: [...state.evidence.transitions, { from: "report", to: "complete", at: new Date().toISOString() }],
      review: state.review,
      elapsedMs: Date.now() - state.startedEpochMs,
      modelUsage: usageSummary(state.evidence.modelCalls),
      repairAttempts: state.repairAttempts,
    };
    state.status = "completed";
    await this.#transition(state, "complete");
    await this.store.save(state);
  }

  #changedFiles(before, after) {
    const paths = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...paths].filter((path) => before?.[path] !== after?.[path]).sort().map((path) => ({ path, beforeSha256: before?.[path] || null, afterSha256: after?.[path] || null }));
  }

  #modelContext(state, extra) {
    return {
      objective: state.objective,
      acceptanceCriteria: state.acceptanceCriteria,
      editablePaths: state.editablePaths,
      repairAttempts: state.repairAttempts,
      ...extra,
    };
  }

  #recordModelCall(state, stage, usage) {
    state.evidence.modelCalls.push({ stage, ...(usage || { source: "unknown", model: null, promptTokens: null, completionTokens: null, totalDurationNs: null }) });
  }
}
