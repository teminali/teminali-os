import assert from "node:assert/strict";
import test from "node:test";

import { GodAgentSwarmService } from "../src/services/godAgentSwarmService.ts";
import { SelfHealingCompilerService } from "../src/services/selfHealingCompilerService.ts";

function modelResponse(verdict, summary, artifact, overrides = {}) {
  return {
    rawResponse: JSON.stringify({
      verdict,
      summary,
      artifact,
      invariants: overrides.invariants ?? ["User acceptance criteria remain authoritative"],
      risks: overrides.risks ?? [],
    }),
    endpoint: "/api/ollama/chat",
    model: "phase3-fixture-model",
    promptTokens: overrides.promptTokens ?? 20,
    completionTokens: overrides.completionTokens ?? 10,
    totalDurationNs: overrides.totalDurationNs ?? 1_000_000,
  };
}

async function runWith(executor, prompt = "Implement the specified behavior") {
  const updates = [];
  let callbackResult;
  const result = await GodAgentSwarmService.executeSwarmPipeline(
    [prompt],
    (workers) => updates.push(workers),
    (synthesis) => {
      callbackResult = synthesis;
    },
    { roleExecutor: executor },
  );
  assert.equal(callbackResult, result, "completion callback must receive the returned immutable synthesis object");
  assert.ok(updates.length >= 7, "real role transitions must be observable");
  return result;
}

test("Architect APPROVE + Coder APPROVE + Verifier REJECT is a hard rejection", async () => {
  const executor = async ({ role }) => {
    if (role === "architect") return modelResponse("APPROVE", "Architecture is coherent.", "Boundary plan");
    if (role === "coder") return modelResponse("APPROVE", "Implementation is complete.", "export const value = 1;");
    return modelResponse("REJECT", "The implementation violates required behavior.", "Behavior audit failed", {
      risks: ["Wrong observable result"],
    });
  };

  const first = await runWith(executor);
  const second = await runWith(executor);
  assert.equal(first.masterVerdict, "REJECTED");
  assert.equal(first.consensusScore, 66.7);
  assert.equal(second.consensusScore, first.consensusScore, "identical verdicts must reproduce the same consensus");
  assert.deepEqual(first.workerEvidence.map(({ verdict }) => verdict), ["APPROVE", "APPROVE", "REJECT"]);
  assert.match(first.disagreements[0], /^REJECT:/);
  assert.match(first.executionSummary, /Unresolved findings: REJECT:/);
});

test("verifier receives the concrete patch and rejects syntactically valid wrong behavior", async () => {
  const wrongPatch = "export function isAdult(age: number): boolean { return age > 12; }";
  let verifierSawPatch = false;
  const executor = async ({ role, prompt }) => {
    if (role === "architect") {
      return modelResponse("APPROVE", "Adults must be at least 18.", "Require age >= 18.");
    }
    if (role === "coder") {
      return modelResponse("APPROVE", "The function is valid TypeScript.", wrongPatch);
    }
    verifierSawPatch = prompt.includes(wrongPatch) && prompt.includes("at least 18");
    return modelResponse(
      verifierSawPatch ? "REJECT" : "APPROVE",
      verifierSawPatch ? "The valid TypeScript implements age > 12, contradicting age >= 18." : "Artifact unavailable.",
      "Compared the requested threshold with the implementation threshold.",
    );
  };

  const result = await runWith(executor, "Implement isAdult; it must return true only when age is at least 18");
  assert.equal(verifierSawPatch, true, "verifier prompt must contain immutable upstream evidence");
  assert.equal(result.masterVerdict, "REJECTED");
  assert.match(result.workerEvidence[2].summary, /contradicting age >= 18/);
});

test("provider failure becomes ERROR evidence and can never become approval", async () => {
  const executor = async ({ role }) => {
    if (role === "architect") throw new Error("provider unavailable");
    if (role === "coder") return modelResponse("APPROVE", "Code proposal completed.", "export const ready = true;");
    return modelResponse("APPROVE", "Available artifact appears consistent.", "Limited evidence audit");
  };

  const result = await runWith(executor);
  assert.equal(result.workerEvidence[0].verdict, "ERROR");
  assert.match(result.workerEvidence[0].error, /provider unavailable/);
  assert.equal(result.masterVerdict, "REJECTED");
  assert.notEqual(result.consensusScore, 100);
  assert.match(result.disagreements.join("\n"), /ERROR:/);
});

test("valid JSON may contain a fenced TypeScript artifact without confusing the envelope parser", async () => {
  const fencedArtifact = "```typescript\nexport const answer: number = 42;\n```";
  const executor = async ({ role }) => modelResponse(
    "APPROVE",
    `${role} supplied a complete artifact.`,
    fencedArtifact,
  );

  const result = await runWith(executor);
  assert.equal(result.masterVerdict, "APPROVED");
  assert.equal(result.workerEvidence[1].artifact, fencedArtifact);
  assert.equal(result.workerEvidence[1].structuredAttempts, 1);
});

test("browser compiler fallback is explicitly unmeasured and never rewrites files", async () => {
  const files = { "valid.ts": "export const answer: number = 42;" };
  const result = await SelfHealingCompilerService.analyzeAndHeal(files);
  assert.equal(result.success, false);
  assert.equal(result.verificationLevel, "limited-lexical");
  assert.equal(result.healedErrorsCount, 0);
  assert.deepEqual(result.healedFiles, files);
  assert.match(result.verificationSummary, /not compiler-validated/);
  assert.ok(result.diagnostics.some(({ code }) => code === "FRONTIER_LIMITED_VALIDATION"));
});
