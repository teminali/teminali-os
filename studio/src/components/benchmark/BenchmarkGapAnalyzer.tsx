import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileCheck2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

interface ParticipantSummary {
  runs: number;
  taskCoverage: number;
  acceptanceRate: number | null;
  regressionRate: number | null;
  criticalRegressions: number;
  safetyViolations: number;
  humanInterventions: number;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  totalCostUsd: number | null;
}

interface BenchmarkParticipant {
  participantId: string;
  displayName: string;
  summary: ParticipantSummary;
}

interface BenchmarkScoreArtifact {
  schemaVersion: "frontier-benchmark-score/v1";
  benchmarkId: string;
  artifactId: string;
  generatedAt: string;
  source: {
    manifestSha256: string;
    resultSha256: string;
  };
  status: "complete" | "partial" | "invalid";
  eligibility: {
    comparisonEligible: boolean;
    reasons: string[];
  };
  participants: BenchmarkParticipant[];
  comparison: {
    status: "winner" | "tie" | "inconclusive";
    winnerParticipantId: string | null;
    rationale: string;
  };
  artifactRefs: string[];
}

const RESULT_ENDPOINTS = [
  "/api/benchmarks/latest",
  "/benchmark/results/latest.json",
] as const;

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const isScoreArtifact = (value: unknown): value is BenchmarkScoreArtifact => {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<BenchmarkScoreArtifact>;
  if (
    artifact.schemaVersion !== "frontier-benchmark-score/v1" ||
    typeof artifact.benchmarkId !== "string" ||
    typeof artifact.artifactId !== "string" ||
    typeof artifact.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(artifact.generatedAt)) ||
    !artifact.source ||
    !/^[a-f0-9]{64}$/.test(artifact.source.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(artifact.source.resultSha256) ||
    !artifact.eligibility ||
    typeof artifact.eligibility.comparisonEligible !== "boolean" ||
    !Array.isArray(artifact.eligibility.reasons) ||
    !Array.isArray(artifact.participants) ||
    !artifact.comparison ||
    !Array.isArray(artifact.artifactRefs)
  ) return false;

  return artifact.participants.every((participant) =>
    typeof participant.participantId === "string" &&
    typeof participant.displayName === "string" &&
    participant.summary &&
    Number.isInteger(participant.summary.runs) &&
    isNumberOrNull(participant.summary.acceptanceRate) &&
    isNumberOrNull(participant.summary.regressionRate) &&
    isNumberOrNull(participant.summary.medianDurationMs) &&
    isNumberOrNull(participant.summary.p95DurationMs) &&
    isNumberOrNull(participant.summary.totalCostUsd)
  );
};

const formatPercent = (value: number | null): string => value === null ? "Unmeasured" : `${value.toFixed(1)}%`;
const formatDuration = (value: number | null): string => value === null ? "Unmeasured" : `${(value / 1000).toFixed(2)}s`;
const formatCost = (value: number | null): string => value === null ? "Unmeasured" : `$${value.toFixed(4)}`;

export const BenchmarkGapAnalyzer: React.FC = () => {
  const [artifact, setArtifact] = useState<BenchmarkScoreArtifact | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("Loading measured benchmark evidence…");

  const loadArtifact = useCallback(async () => {
    setIsLoading(true);
    setMessage("Loading measured benchmark evidence…");
    const failures: string[] = [];

    for (const endpoint of RESULT_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) {
          failures.push(`${endpoint}: HTTP ${response.status}`);
          continue;
        }

        const candidate: unknown = await response.json();
        if (!isScoreArtifact(candidate)) {
          failures.push(`${endpoint}: invalid score artifact`);
          continue;
        }

        setArtifact(candidate);
        setMessage(`Loaded immutable artifact ${candidate.artifactId}.`);
        setIsLoading(false);
        return;
      } catch (error) {
        failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    setArtifact(null);
    setMessage(`No measured benchmark artifact is available. ${failures.join(" · ")}`);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadArtifact();
  }, [loadArtifact]);

  const winner = artifact?.comparison.winnerParticipantId
    ? artifact.participants.find((participant) => participant.participantId === artifact.comparison.winnerParticipantId)
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3 font-sans text-xs bg-frame-bot text-ink-prose">
      <section className="p-3 bg-surface-sunken border border-edge rounded-xl space-y-3 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/30 flex items-center justify-center">
              <BarChart3 className="w-4 h-4 text-accent" />
            </div>
            <div>
              <h2 className="font-semibold text-ink-bright">Controlled Benchmark Evidence</h2>
              <p className="text-4xs text-ink-faint">Only scored runner artifacts are shown; missing evidence remains unmeasured.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadArtifact()}
            disabled={isLoading}
            className="px-2.5 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-50 text-ink-bright rounded-md flex items-center gap-1.5 border border-edge"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
            Refresh evidence
          </button>
        </div>

        <div className={`p-2.5 rounded-lg border flex gap-2 ${
          artifact ? "bg-accent/[0.06] border-accent/20" : "bg-warning/[0.06] border-warning/20"
        }`}>
          {artifact ? <FileCheck2 className="w-4 h-4 text-accent shrink-0" /> : <AlertTriangle className="w-4 h-4 text-warning shrink-0" />}
          <div>
            <p className="text-3xs text-ink-prose">{message}</p>
            {artifact && (
              <p className="text-4xs text-ink-faint mt-1 font-mono break-all">
                manifest sha256 {artifact.source.manifestSha256} · result sha256 {artifact.source.resultSha256}
              </p>
            )}
          </div>
        </div>
      </section>

      {!artifact ? (
        <section className="p-5 bg-surface-sunken border border-edge-chrome rounded-xl text-center">
          <ShieldAlert className="w-7 h-7 text-warning mx-auto mb-2" />
          <h3 className="font-semibold text-ink-bright">Comparison unmeasured</h3>
          <p className="text-3xs text-ink-faint mt-1 max-w-md mx-auto">
            Run the controlled scorer against a sealed manifest and real run evidence, then publish its immutable score artifact through a configured endpoint.
          </p>
        </section>
      ) : (
        <>
          <section className="p-3 bg-surface-sunken border border-edge-chrome rounded-xl space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-ink-bright">{artifact.benchmarkId}</h3>
                <p className="text-4xs text-ink-faint">Scored {new Date(artifact.generatedAt).toLocaleString()}</p>
              </div>
              <span className={`px-2 py-1 rounded-full border text-4xs font-mono ${
                artifact.eligibility.comparisonEligible
                  ? "text-success bg-success/10 border-success/25"
                  : "text-warning bg-warning/10 border-warning/25"
              }`}>
                {artifact.eligibility.comparisonEligible ? "COMPARISON ELIGIBLE" : "INCOMPLETE EVIDENCE"}
              </span>
            </div>

            <div className="p-2.5 bg-frame-bot rounded-lg border border-white/[0.05]">
              <div className="flex items-center gap-1.5 text-ink-bright font-semibold">
                {winner ? <CheckCircle2 className="w-3.5 h-3.5 text-success" /> : <AlertTriangle className="w-3.5 h-3.5 text-warning" />}
                {winner ? `${winner.displayName} leads this measured benchmark` : "No defensible winner"}
              </div>
              <p className="text-3xs text-ink-muted mt-1">{artifact.comparison.rationale}</p>
            </div>

            {artifact.eligibility.reasons.length > 0 && (
              <ul className="space-y-1 text-4xs text-warning list-disc pl-4">
                {artifact.eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-2">
            {artifact.participants.map((participant) => (
              <article key={participant.participantId} className="p-3 bg-surface-sunken border border-white/[0.07] rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-ink-bright">{participant.displayName}</h3>
                  <span className="text-4xs font-mono text-ink-faint">{participant.summary.runs} runs</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    ["Acceptance", formatPercent(participant.summary.acceptanceRate)],
                    ["Regression pass", formatPercent(participant.summary.regressionRate)],
                    ["Median time", formatDuration(participant.summary.medianDurationMs)],
                    ["p95 time", formatDuration(participant.summary.p95DurationMs)],
                    ["Measured cost", formatCost(participant.summary.totalCostUsd)],
                    ["Task coverage", `${participant.summary.taskCoverage}`],
                  ].map(([label, value]) => (
                    <div key={label} className="p-2 bg-frame-bot rounded-lg border border-white/[0.04]">
                      <div className="text-4xs uppercase tracking-wide text-ink-ghost">{label}</div>
                      <div className="text-3xs font-mono font-semibold text-ink-prose mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 text-4xs">
                  <span className="px-1.5 py-0.5 rounded bg-danger/10 text-danger">{participant.summary.criticalRegressions} critical regressions</span>
                  <span className="px-1.5 py-0.5 rounded bg-danger/10 text-danger">{participant.summary.safetyViolations} safety violations</span>
                  <span className="px-1.5 py-0.5 rounded bg-warning/10 text-warning">{participant.summary.humanInterventions} interventions</span>
                </div>
              </article>
            ))}
          </section>

          {artifact.artifactRefs.length > 0 && (
            <section className="p-3 bg-surface-sunken border border-edge-chrome rounded-xl">
              <div className="flex items-center gap-1.5 text-ink-bright font-semibold mb-2">
                <Clock className="w-3.5 h-3.5 text-accent" /> Evidence references
              </div>
              <ul className="space-y-1.5">
                {artifact.artifactRefs.map((ref) => (
                  <li key={ref} className="text-3xs font-mono text-accent flex items-center gap-1.5 break-all">
                    <ExternalLink className="w-3 h-3 shrink-0" /> {ref}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};
