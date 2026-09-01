import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.FRONTIER_GATEWAY_URL || "http://127.0.0.1:4310";
const origin = process.env.FRONTIER_BENCHMARK_ORIGIN || "http://localhost:3000";
const model = process.env.FRONTIER_BENCHMARK_MODEL || "devstral-small-2:24b-instruct-2512-q4_K_M";
const auditPath = new URL("../benchmark-results/gateway-audit.jsonl", import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function parseNdjsonStream(response, onFirstChunk) {
  assert(response.body, "The gateway returned no stream body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let chunks = 0;
  let text = "";
  let finalChunk = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (chunks === 0) onFirstChunk();
    chunks += 1;
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (typeof item.message?.content === "string") text += item.message.content;
      if (item.done === true) finalChunk = item;
    }
  }

  if (buffer.trim()) {
    const item = JSON.parse(buffer);
    if (typeof item.message?.content === "string") text += item.message.content;
    if (item.done === true) finalChunk = item;
  }
  return { bytes, chunks, text, finalChunk };
}

const healthResponse = await fetch(`${baseUrl}/api/health`);
assert(healthResponse.ok, `Health returned HTTP ${healthResponse.status}.`);
const health = await healthResponse.json();

const unauthorizedResponse = await fetch(`${baseUrl}/api/ollama/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "unauthorized probe" }], stream: false }),
});
assert(unauthorizedResponse.status === 401, `Unauthenticated request returned HTTP ${unauthorizedResponse.status}, expected 401.`);

const sessionResponse = await fetch(`${baseUrl}/api/session`, { method: "POST", headers: { origin } });
assert(sessionResponse.ok, `Session bootstrap returned HTTP ${sessionResponse.status}.`);
const session = await sessionResponse.json();
assert(typeof session.token === "string" && session.token.length >= 32, "Session bootstrap returned no valid token.");
const authorization = `Bearer ${session.token}`;

const startedAt = performance.now();
let firstTokenAt = null;
const streamResponse = await fetch(`${baseUrl}/api/ollama/chat`, {
  method: "POST",
  headers: { authorization, "content-type": "application/json", origin },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [
      { role: "system", content: "Follow the user's output format exactly. Do not add explanation or punctuation." },
      { role: "user", content: "Reply with exactly PHASE1_STREAM_OK" },
    ],
    options: { temperature: 0, num_predict: 16 },
  }),
});
assert(streamResponse.ok, `Authenticated stream returned HTTP ${streamResponse.status}.`);
const stream = await parseNdjsonStream(streamResponse, () => {
  firstTokenAt = performance.now();
});
const completedAt = performance.now();
assert(stream.finalChunk?.done === true, "Ollama stream ended without a final done chunk.");
assert(stream.text.trim() === "PHASE1_STREAM_OK", "Devstral did not return the deterministic acceptance phrase.");

const cancelController = new AbortController();
const cancelCorrelationId = `phase1-cancel-${Date.now()}`;
const cancelResponse = await fetch(`${baseUrl}/api/ollama/chat`, {
  method: "POST",
  headers: {
    authorization,
    "content-type": "application/json",
    origin,
    "x-correlation-id": cancelCorrelationId,
  },
  signal: cancelController.signal,
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: "user", content: "Generate a detailed 1000-word explanation of sorting algorithms." }],
    options: { temperature: 0, num_predict: 1024 },
  }),
});
assert(cancelResponse.ok && cancelResponse.body, `Cancellation probe returned HTTP ${cancelResponse.status}.`);
const cancelReader = cancelResponse.body.getReader();
const firstCancelChunk = await cancelReader.read();
assert(!firstCancelChunk.done && firstCancelChunk.value?.byteLength > 0, "Cancellation probe received no streamed bytes.");
cancelController.abort();
await new Promise((resolve) => setTimeout(resolve, 150));

const auditLines = (await readFile(auditPath, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const cancellationRecorded = auditLines.some((entry) => entry.correlationId === cancelCorrelationId
  && entry.errorCode === "CLIENT_CANCELLED"
  && entry.cancelled === true);
assert(cancellationRecorded, "The live client cancellation was not recorded by the gateway audit log.");

const totalDurationMs = Math.round((completedAt - startedAt) * 10) / 10;
const timeToFirstTokenMs = firstTokenAt === null ? null : Math.round((firstTokenAt - startedAt) * 10) / 10;
const outputDigest = createHash("sha256").update(stream.text).digest("hex");

const result = {
  phase: 1,
  passed: true,
  gateway: health.gateway.state,
  ollama: health.dependencies.ollama.state,
  kerfMcp: health.dependencies.kerfMcp.state,
  authentication: { unauthorizedStatus: unauthorizedResponse.status, sessionBootstrap: "passed" },
  stream: {
    model,
    bytes: stream.bytes,
    chunks: stream.chunks,
    timeToFirstTokenMs,
    totalDurationMs,
    promptTokens: stream.finalChunk.prompt_eval_count,
    outputTokens: stream.finalChunk.eval_count,
    outputSha256: outputDigest,
    deterministicOutputMatched: true,
  },
  cancellation: { upstreamCancellationRecorded: true },
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1) {
  const outputPath = process.argv[outputIndex + 1];
  assert(outputPath, "--output requires a file path.");
  await writeFile(resolve(outputPath), serialized, { flag: "wx", mode: 0o600 });
}
process.stdout.write(serialized);
