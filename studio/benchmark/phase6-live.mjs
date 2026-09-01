import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { FrontierMcpClient, McpContractError, createAuthenticatedGatewayTransport } from "../mcp-runtime/client.mjs";
import { createImageByteTransport, verifyImageByteTransport } from "../mcp-runtime/image-proof.mjs";
import { crc32 } from "../visual-runtime/png.mjs";

const baseUrl = process.env.FRONTIER_GATEWAY_URL || "http://127.0.0.1:4310";
const origin = "http://localhost:3000";
const auditPath = new URL("../benchmark-results/gateway-audit.jsonl", import.meta.url);
const originalFetch = globalThis.fetch.bind(globalThis);

const fetchImpl = (input, init = {}) => {
  const target = typeof input === "string" && input.startsWith("/") ? new URL(input, baseUrl) : input;
  const headers = new Headers(init.headers);
  if (typeof input === "string" && input.startsWith("/")) headers.set("Origin", origin);
  return originalFetch(target, { ...init, headers });
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function mcpAuditCount() {
  try {
    return (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.route === "/api/mcp").length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

const beforeMcpRequests = await mcpAuditCount();
const mcpClient = new FrontierMcpClient({
  transport: createAuthenticatedGatewayTransport({ fetchImpl }),
});
let outageCode = null;
try {
  await mcpClient.mutateTimeline({
    toolName: "frontiercut_split_silence",
    arguments: { thresholdDb: -32 },
    idempotencyKey: `phase6-outage-${Date.now()}`,
  });
} catch (error) {
  if (!(error instanceof McpContractError)) throw error;
  outageCode = error.code;
}
const afterMcpRequests = await mcpAuditCount();
assert(outageCode === "MCP_UNHEALTHY", `Expected MCP_UNHEALTHY, received ${outageCode || "no error"}.`);
assert(afterMcpRequests === beforeMcpRequests, "An MCP RPC was attempted despite the unhealthy dependency gate.");

const width = 384;
const height = 384;
const colors = [
  { name: "RED", rgba: [230, 30, 45, 255] },
  { name: "GREEN", rgba: [25, 185, 80, 255] },
  { name: "BLUE", rgba: [35, 95, 235, 255] },
  { name: "YELLOW", rgba: [245, 205, 30, 255] },
];
const selected = colors[randomBytes(1)[0] % colors.length];
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const insideCenter = x >= 128 && x < 256 && y >= 128 && y < 256;
    const border = x % 128 < 5 || y % 128 < 5;
    const color = border ? [255, 255, 255, 255] : insideCenter ? selected.rgba : [45, 45, 48, 255];
    pixels.set(color, (y * width + x) * 4);
  }
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBytes, data]);
  return Buffer.concat([uint32(data.length), crcInput, uint32(crc32(crcInput))]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 6;
const scanlines = Buffer.alloc(height * (width * 4 + 1));
for (let y = 0; y < height; y += 1) {
  const rowOffset = y * (width * 4 + 1);
  scanlines[rowOffset] = 0;
  scanlines.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), rowOffset + 1);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", header),
  pngChunk("IDAT", deflateSync(scanlines)),
  pngChunk("IEND", Buffer.alloc(0)),
]);
const imageTransport = await createImageByteTransport(png, "image/png");
const verifiedImage = await verifyImageByteTransport(imageTransport);
assert(verifiedImage.byteLength === png.byteLength, "Image byte verification changed the payload length.");

const sessionResponse = await fetchImpl("/api/session", { method: "POST", headers: { Accept: "application/json" } });
assert(sessionResponse.ok, `Gateway session returned HTTP ${sessionResponse.status}.`);
const session = await sessionResponse.json();
assert(typeof session.token === "string" && session.token.length >= 32, "Gateway session returned no valid token.");
const modelResponse = await fetchImpl("/api/ollama/chat", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    model: "devstral-small-2:24b-instruct-2512-q4_K_M",
    stream: false,
    messages: [{
      role: "user",
      content: "Inspect the attached 3 by 3 grid. Reply with exactly one word naming the center square color: RED, GREEN, BLUE, or YELLOW.",
      images: [imageTransport.data],
    }],
    options: { temperature: 0, seed: 73, num_predict: 12 },
  }),
});
assert(modelResponse.ok, `Vision handoff returned HTTP ${modelResponse.status}.`);
const modelBody = await modelResponse.json();
const observed = String(modelBody.message?.content || "").trim().toUpperCase().replaceAll(/[^A-Z]/g, "");
const pixelsRecognized = observed === selected.name;

const result = {
  phase: 6,
  passed: pixelsRecognized,
  mcpOutage: {
    errorCode: outageCode,
    rpcRequestsBefore: beforeMcpRequests,
    rpcRequestsAfter: afterMcpRequests,
    mutationAttempted: false,
  },
  imageTransport: {
    mediaType: imageTransport.mediaType,
    byteLength: imageTransport.byteLength,
    sha256: imageTransport.sha256,
    expectedCenterColor: selected.name,
    modelObservedCenterColor: observed,
    pixelsRecognized,
    model: modelBody.model || null,
    promptTokens: Number.isInteger(modelBody.prompt_eval_count) ? modelBody.prompt_eval_count : null,
    outputTokens: Number.isInteger(modelBody.eval_count) ? modelBody.eval_count : null,
    totalDurationNs: Number.isInteger(modelBody.total_duration) ? modelBody.total_duration : null,
  },
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1) {
  const outputPath = process.argv[outputIndex + 1];
  assert(outputPath, "--output requires a path.");
  await writeFile(resolve(outputPath), serialized, { flag: "wx", mode: 0o400 });
}
process.stdout.write(serialized);
if (!pixelsRecognized) process.exitCode = 1;
