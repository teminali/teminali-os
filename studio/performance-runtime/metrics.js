const METRIC_FIELDS = [
  "ttftMs",
  "totalLatencyMs",
  "promptTokensPerSecond",
  "outputTokensPerSecond",
  "ollamaTotalDurationMs",
  "loadDurationMs",
  "promptEvalDurationMs",
  "evalDurationMs",
  "promptTokens",
  "outputTokens",
];

export function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function nanosecondsToMilliseconds(value) {
  return Number.isInteger(value) && value >= 0 ? value / 1_000_000 : null;
}

export function tokensPerSecond(tokens, durationNs) {
  if (!Number.isInteger(tokens) || tokens < 0 || !Number.isInteger(durationNs) || durationNs <= 0) return null;
  return tokens / (durationNs / 1_000_000_000);
}

export function classifyLoad(loadDurationNs, coldThresholdMs) {
  if (!Number.isSafeInteger(loadDurationNs) || loadDurationNs < 0) return "unknown";
  return loadDurationNs >= coldThresholdMs * 1_000_000 ? "cold" : "warm";
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function percentileNearestRank(values, percentile) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) throw new RangeError("percentile must be in (0, 100].");
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

function stats(values) {
  const measured = values.filter(Number.isFinite);
  return {
    measuredCount: measured.length,
    median: median(measured),
    p95: percentileNearestRank(measured, 95),
    min: measured.length > 0 ? Math.min(...measured) : null,
    max: measured.length > 0 ? Math.max(...measured) : null,
  };
}

export function aggregateSamples(samples) {
  const aggregateGroup = (group) => ({
    runCount: group.length,
    completeRunCount: group.filter((sample) => sample.complete).length,
    metrics: Object.fromEntries(METRIC_FIELDS.map((field) => [field, stats(group.map((sample) => sample.metrics[field]))])),
  });
  return {
    all: aggregateGroup(samples),
    cold: aggregateGroup(samples.filter((sample) => sample.classification === "cold")),
    warm: aggregateGroup(samples.filter((sample) => sample.classification === "warm")),
    unknown: aggregateGroup(samples.filter((sample) => sample.classification === "unknown")),
  };
}

export function extractOllamaMetrics(finalChunk) {
  const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const promptTokens = nonNegativeInteger(finalChunk?.prompt_eval_count);
  const outputTokens = nonNegativeInteger(finalChunk?.eval_count);
  const promptEvalDurationNs = nonNegativeInteger(finalChunk?.prompt_eval_duration);
  const evalDurationNs = nonNegativeInteger(finalChunk?.eval_duration);
  const loadDurationNs = nonNegativeInteger(finalChunk?.load_duration);
  const totalDurationNs = nonNegativeInteger(finalChunk?.total_duration);
  return {
    promptTokens,
    outputTokens,
    promptTokensPerSecond: tokensPerSecond(promptTokens, promptEvalDurationNs),
    outputTokensPerSecond: tokensPerSecond(outputTokens, evalDurationNs),
    ollamaTotalDurationMs: nanosecondsToMilliseconds(totalDurationNs),
    loadDurationMs: nanosecondsToMilliseconds(loadDurationNs),
    promptEvalDurationMs: nanosecondsToMilliseconds(promptEvalDurationNs),
    evalDurationMs: nanosecondsToMilliseconds(evalDurationNs),
    raw: {
      promptEvalCount: promptTokens,
      evalCount: outputTokens,
      promptEvalDurationNs,
      evalDurationNs,
      loadDurationNs,
      totalDurationNs,
    },
  };
}
