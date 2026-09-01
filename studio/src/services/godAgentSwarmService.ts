import { GatewayClient } from "./gatewayClient.ts";

/** Evidence produced by an independently executed Ollama role. */
export type SwarmVerdict = "APPROVE" | "REVISE" | "REJECT" | "ERROR";

export interface SwarmWorkerEvidence {
  startedAt: number;
  completedAt: number;
  endpoint: string;
  model: string;
  verdict: SwarmVerdict;
  summary: string;
  artifact: string;
  invariants: string[];
  risks: string[];
  rawResponse: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalDurationNs: number | null;
  structuredAttempts: number;
  error?: string;
}

export interface SwarmWorkerState {
  id: string;
  name: string;
  role: "architect" | "coder" | "verifier" | "optimizer";
  avatar: string;
  status: "idle" | "thinking" | "generating" | "passed" | "failed";
  currentTask: string;
  progressPercent: number;
  outputPreview: string;
  tokensCount: number;
  durationSec: number;
  evidence?: SwarmWorkerEvidence;
}

export interface GodAgentSynthesis {
  timestamp: number;
  masterVerdict: "APPROVED" | "REMEDIATING" | "REJECTED";
  consensusScore: number;
  activeWorkersCount: number;
  synthesizedDiff: string;
  invariantsPreserved: string[];
  executionSummary: string;
  workerEvidence?: SwarmWorkerEvidence[];
  disagreements?: string[];
  totalTokensCount?: number;
  durationSec?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  data?: OllamaChatResponse;
}

export interface SwarmRoleExecutionRequest {
  role: SwarmWorkerState["role"];
  workerId: string;
  systemPrompt: string;
  prompt: string;
  model: string;
  endpoint: string;
}

export interface SwarmRoleExecutionResponse {
  rawResponse: string;
  endpoint: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalDurationNs: number | null;
}

export type SwarmRoleExecutor = (request: SwarmRoleExecutionRequest) => Promise<SwarmRoleExecutionResponse>;

export interface SwarmExecutionDependencies {
  /** Test/host injection boundary. Production callers omit this field. */
  roleExecutor?: SwarmRoleExecutor;
}

interface ParsedWorkerOutput {
  verdict: Exclude<SwarmVerdict, "ERROR">;
  summary: string;
  artifact: string;
  invariants: string[];
  risks: string[];
}

interface WorkerDefinition {
  id: string;
  name: string;
  role: SwarmWorkerState["role"];
  avatar: string;
  responsibility: string;
}

const MODEL = "frontier-qwen2.5-coder-14b-8k";
const GATEWAY_ENDPOINT = "/api/ollama/chat";
const REQUEST_TIMEOUT_MS = 120_000;

const INITIAL_WORKERS: WorkerDefinition[] = [
  {
    id: "worker_arch",
    name: "Architect Agent",
    role: "architect",
    avatar: "🏛️",
    responsibility:
      "Analyze boundaries, dependencies, acceptance criteria, invariants, and implementation risks. Do not write an implementation patch.",
  },
  {
    id: "worker_coder",
    name: "Implementation Agent",
    role: "coder",
    avatar: "⚡",
    responsibility:
      "Produce a complete implementation proposal or unified diff with no placeholders. Identify every assumed file and contract.",
  },
];

const VERIFIER: WorkerDefinition = {
  id: "worker_qa",
  name: "Behavior & QA Verifier",
  role: "verifier",
  avatar: "🛡️",
  responsibility:
    "Independently audit supplied artifacts against the original task. Treat missing runtime evidence as unknown and veto behaviorally incorrect proposals.",
};

function cloneWorkers(workers: SwarmWorkerState[]): SwarmWorkerState[] {
  return workers.map((worker) => ({
    ...worker,
    evidence: worker.evidence
      ? { ...worker.evidence, invariants: [...worker.evidence.invariants], risks: [...worker.evidence.risks] }
      : undefined,
  }));
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumMetrics(executions: SwarmRoleExecutionResponse[], field: "promptTokens" | "completionTokens" | "totalDurationNs"): number | null {
  const values = executions.map((execution) => finiteMetric(execution[field]));
  return values.every((value): value is number => value !== null)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseWorkerOutput(raw: string): ParsedWorkerOutput {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (wholeError) {
    const outerFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i)?.[1];
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    const candidate = outerFence ?? (firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : null);
    if (!candidate) throw wholeError;
    parsed = JSON.parse(candidate.trim());
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Worker response was not a JSON object");

  const record = parsed as Record<string, unknown>;
  const verdict = typeof record.verdict === "string" ? record.verdict.toUpperCase() : "";
  if (verdict !== "APPROVE" && verdict !== "REVISE" && verdict !== "REJECT") {
    throw new Error("Worker response omitted a valid APPROVE, REVISE, or REJECT verdict");
  }
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Worker response omitted its summary evidence");
  }
  if (typeof record.artifact !== "string" || !record.artifact.trim()) {
    throw new Error("Worker response omitted its role artifact");
  }
  return {
    verdict,
    summary: record.summary.trim(),
    artifact: record.artifact,
    invariants: stringArray(record.invariants),
    risks: stringArray(record.risks),
  };
}

async function requestOllama(
  system: string,
  prompt: string
): Promise<SwarmRoleExecutionResponse> {
  const selection = await GatewayClient.resolveModelMode("flash", prompt);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await GatewayClient.request(GATEWAY_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: selection.model,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        options: { temperature: 0, seed: 42, num_predict: 1400, num_ctx: 8192, num_batch: 96 },
        keep_alive: 0,
      }),
    });
    await GatewayClient.expectOk(response);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`${GATEWAY_ENDPOINT} returned non-JSON content (${contentType || "unknown"})`);
    }
    const outer = (await response.json()) as OllamaChatResponse;
    const body = outer.data ?? outer;
    if (typeof body.message?.content !== "string" || !body.message.content.trim()) {
      throw new Error(`${GATEWAY_ENDPOINT} returned no assistant content`);
    }
    return {
      rawResponse: body.message.content,
      endpoint: GATEWAY_ENDPOINT,
      model: body.model ?? selection.model,
      promptTokens: finiteMetric(body.prompt_eval_count),
      completionTokens: finiteMetric(body.eval_count),
      totalDurationNs: finiteMetric(body.total_duration),
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Ollama request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

const defaultRoleExecutor: SwarmRoleExecutor = ({ systemPrompt: system, prompt }) => requestOllama(system, prompt);

function systemPrompt(definition: WorkerDefinition): string {
  return [
    `You are the ${definition.name} in an evidence-audited software task review.`,
    definition.responsibility,
    "Work independently. Never claim code was executed, compiled, tested, or inspected unless supplied evidence proves it.",
    "Return exactly one JSON object with this schema:",
    '{"verdict":"APPROVE|REVISE|REJECT","summary":"reasoned conclusion","artifact":"complete role artifact","invariants":["evidence-backed invariant"],"risks":["unresolved risk"]}',
    `The artifact field is mandatory and must be a non-empty string containing your complete ${definition.role} deliverable. Never rename it to code, implementation, plan, or output.`,
    "APPROVE means the proposal is sufficiently specified and safe for your role. REVISE means concrete remediation is required. REJECT means a critical requirement cannot be met or evidence contradicts the request.",
  ].join("\n");
}

function verifierPrompt(tasks: string[], evidence: SwarmWorkerEvidence[]): string {
  const upstream = evidence
    .map((item) =>
      `ROLE ${item.verdict}\nSUMMARY: ${item.summary}\nARTIFACT:\n${item.artifact}\nRISKS: ${JSON.stringify(item.risks)}`
    )
    .join("\n\n---\n\n");
  return [
    "USER TASKS:",
    ...tasks.map((task, index) => `${index + 1}. ${task}`),
    "",
    "IMMUTABLE UPSTREAM ARTIFACTS:",
    upstream,
    "",
    "Check internal consistency, acceptance-criteria coverage, placeholder-free completeness, and behavioral correctness that can be established from the artifacts. Reject syntactically plausible work when its behavior contradicts the task. Do not claim runtime or compiler validation.",
  ].join("\n");
}

async function executeWorker(
  definition: WorkerDefinition,
  taskPrompt: string,
  workers: SwarmWorkerState[],
  onWorkerUpdate: (workers: SwarmWorkerState[]) => void,
  roleExecutor: SwarmRoleExecutor
): Promise<SwarmWorkerEvidence> {
  const worker = workers.find((candidate) => candidate.id === definition.id);
  if (!worker) throw new Error(`Missing state for ${definition.id}`);
  const startedAt = Date.now();
  const startedPerformance = performance.now();
  worker.status = "thinking";
  worker.currentTask = definition.responsibility;
  worker.progressPercent = 10;
  worker.outputPreview = "Waiting for local Ollama evidence…";
  onWorkerUpdate(cloneWorkers(workers));

  try {
    worker.status = "generating";
    worker.progressPercent = 50;
    onWorkerUpdate(cloneWorkers(workers));
    const request: SwarmRoleExecutionRequest = {
      role: definition.role,
      workerId: definition.id,
      systemPrompt: systemPrompt(definition),
      prompt: taskPrompt,
      model: MODEL,
      endpoint: GATEWAY_ENDPOINT,
    };
    const executions: SwarmRoleExecutionResponse[] = [];
    let execution = await roleExecutor(request);
    executions.push(execution);
    let rawResponse = execution.rawResponse;
    if (!rawResponse.trim()) throw new Error("Role executor returned no model output");
    let parsed: ParsedWorkerOutput;
    try {
      parsed = parseWorkerOutput(rawResponse);
    } catch (schemaError) {
      execution = await roleExecutor({
        ...request,
        systemPrompt: `${request.systemPrompt}\nYour previous response violated the JSON contract: ${schemaError instanceof Error ? schemaError.message : "invalid JSON"}. Retry once. Return raw JSON only, include every required key, and JSON-escape all newlines and quotes inside artifact.`,
      });
      executions.push(execution);
      rawResponse = execution.rawResponse;
      if (!rawResponse.trim()) throw new Error("Role executor returned no model output on its structured retry");
      parsed = parseWorkerOutput(rawResponse);
    }
    const evidence: SwarmWorkerEvidence = {
      startedAt,
      completedAt: Date.now(),
      endpoint: execution.endpoint,
      model: execution.model,
      verdict: parsed.verdict,
      summary: parsed.summary,
      artifact: parsed.artifact,
      invariants: parsed.invariants,
      risks: parsed.risks,
      rawResponse,
      promptTokens: sumMetrics(executions, "promptTokens"),
      completionTokens: sumMetrics(executions, "completionTokens"),
      totalDurationNs: sumMetrics(executions, "totalDurationNs"),
      structuredAttempts: executions.length,
    };
    worker.evidence = evidence;
    worker.status = parsed.verdict === "APPROVE" ? "passed" : "failed";
    worker.progressPercent = 100;
    worker.outputPreview = parsed.summary;
    worker.tokensCount = evidence.completionTokens ?? 0;
    worker.durationSec = Number(((performance.now() - startedPerformance) / 1000).toFixed(3));
    onWorkerUpdate(cloneWorkers(workers));
    return evidence;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evidence: SwarmWorkerEvidence = {
      startedAt,
      completedAt: Date.now(),
      endpoint: GATEWAY_ENDPOINT,
      model: MODEL,
      verdict: "ERROR",
      summary: `Worker execution failed: ${message}`,
      artifact: "No artifact was produced.",
      invariants: [],
      risks: ["No model-backed role artifact is available."],
      rawResponse: "",
      promptTokens: null,
      completionTokens: null,
      totalDurationNs: null,
      structuredAttempts: 1,
      error: message,
    };
    worker.evidence = evidence;
    worker.status = "failed";
    worker.progressPercent = 100;
    worker.outputPreview = evidence.summary;
    worker.tokensCount = 0;
    worker.durationSec = Number(((performance.now() - startedPerformance) / 1000).toFixed(3));
    onWorkerUpdate(cloneWorkers(workers));
    return evidence;
  }
}

function sharedInvariants(evidence: SwarmWorkerEvidence[]): string[] {
  const successful = evidence.filter((item) => item.verdict !== "ERROR");
  if (successful.length === 0) return [];
  const sets = successful.map((item) => new Map(item.invariants.map((value) => [value.trim().toLowerCase(), value])));
  return [...sets[0].entries()]
    .filter(([key]) => sets.every((set) => set.has(key)))
    .map(([, display]) => display);
}

export function synthesizeSwarmEvidence(evidence: SwarmWorkerEvidence[], elapsedSec: number): GodAgentSynthesis {
  const counts = new Map<SwarmVerdict, number>();
  for (const item of evidence) counts.set(item.verdict, (counts.get(item.verdict) ?? 0) + 1);
  const majority = counts.size ? Math.max(...counts.values()) : 0;
  const consensusScore = evidence.length ? Number(((majority / evidence.length) * 100).toFixed(1)) : 0;
  const disagreements = evidence
    .filter((item) => item.verdict !== "APPROVE")
    .map((item) => `${item.verdict}: ${item.summary}`);
  const hasVeto = evidence.some((item) => item.verdict === "ERROR" || item.verdict === "REJECT");
  const hasRevision = evidence.some((item) => item.verdict === "REVISE");
  const masterVerdict: GodAgentSynthesis["masterVerdict"] = hasVeto
    ? "REJECTED"
    : hasRevision
      ? "REMEDIATING"
      : "APPROVED";
  const coderArtifact = evidence.find((item, index) => index === 1 && item.verdict !== "ERROR")?.artifact ?? "";
  const totalTokensCount = evidence.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0);
  const verdictSummary = evidence.map((item) => item.verdict).join(" / ");
  return {
    timestamp: Date.now(),
    masterVerdict,
    consensusScore,
    activeWorkersCount: evidence.length,
    synthesizedDiff: coderArtifact,
    invariantsPreserved: sharedInvariants(evidence),
    executionSummary:
      `Evidence-backed verdict: ${masterVerdict}. Role verdicts: ${verdictSummary}. ` +
      `${totalTokensCount} measured completion tokens across ${evidence.length} Ollama calls in ${elapsedSec.toFixed(2)}s.` +
      (disagreements.length ? ` Unresolved findings: ${disagreements.join(" | ")}` : ""),
    workerEvidence: evidence,
    disagreements,
    totalTokensCount,
    durationSec: elapsedSec,
  };
}

export class GodAgentSwarmService {
  /**
   * Roles execute sequentially on the resource-safe Flash route. The Verifier
   * evaluates immutable upstream artifacts and retains rejection as a veto.
   */
  public static async executeSwarmPipeline(
    userPrompts: string[],
    onWorkerUpdate: (workers: SwarmWorkerState[]) => void,
    onGodSynthesis: (synthesis: GodAgentSynthesis) => void,
    dependencies: SwarmExecutionDependencies = {}
  ): Promise<GodAgentSynthesis> {
    const start = performance.now();
    const tasks = userPrompts.map((prompt) => prompt.trim()).filter(Boolean);
    if (tasks.length === 0) {
      const result: GodAgentSynthesis = {
        timestamp: Date.now(),
        masterVerdict: "REJECTED",
        consensusScore: 0,
        activeWorkersCount: 0,
        synthesizedDiff: "",
        invariantsPreserved: [],
        executionSummary: "Swarm rejected: no task was provided, so no model calls were made.",
        workerEvidence: [],
        disagreements: ["No executable task was provided."],
        totalTokensCount: 0,
        durationSec: 0,
      };
      onWorkerUpdate([]);
      onGodSynthesis(result);
      return result;
    }

    const definitions = [...INITIAL_WORKERS, VERIFIER];
    const workers: SwarmWorkerState[] = definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      role: definition.role,
      avatar: definition.avatar,
      status: "idle",
      currentTask: "Queued",
      progressPercent: 0,
      outputPreview: "No evidence yet.",
      tokensCount: 0,
      durationSec: 0,
    }));
    onWorkerUpdate(cloneWorkers(workers));

    const taskPrompt = ["USER TASKS:", ...tasks.map((task, index) => `${index + 1}. ${task}`)].join("\n");
    const roleExecutor = dependencies.roleExecutor ?? defaultRoleExecutor;
    const initialEvidence: SwarmWorkerEvidence[] = [];
    for (const definition of INITIAL_WORKERS) {
      initialEvidence.push(await executeWorker(definition, taskPrompt, workers, onWorkerUpdate, roleExecutor));
    }
    const verifierEvidence = await executeWorker(
      VERIFIER,
      verifierPrompt(tasks, initialEvidence),
      workers,
      onWorkerUpdate,
      roleExecutor
    );
    const evidence = [...initialEvidence, verifierEvidence];
    const synthesis = synthesizeSwarmEvidence(evidence, (performance.now() - start) / 1000);
    onGodSynthesis(synthesis);
    return synthesis;
  }
}
