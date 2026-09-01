import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthenticatedGatewayTransport,
  FrontierMcpClient,
  McpContractError,
} from "./client.mjs";
import { createImageByteTransport, verifyImageByteTransport } from "./image-proof.mjs";

const STATE_TOOL = "frontiercut_timeline_state";
const CUT_TOOL = "frontiercut_split_silence";

function rpcResult(request, result) {
  return { jsonrpc: "2.0", id: request.id, result };
}

function createFixtureTransport(options = {}) {
  const calls = [];
  let state = { revision: 1, clips: [{ id: "clip-a", start: 0, end: 10 }] };
  let snapshotCalls = 0;
  const tools = [
    { name: STATE_TOOL, inputSchema: { type: "object", properties: {} } },
    { name: CUT_TOOL, inputSchema: { type: "object", properties: { dryRun: { type: "boolean" } } } },
  ];
  return {
    calls,
    get snapshotCalls() {
      return snapshotCalls;
    },
    async health() {
      return options.health || { state: "healthy", dependencies: { kerfMcp: { state: "healthy" } } };
    },
    async send(request) {
      calls.push(structuredClone(request));
      if (options.sendOverride) {
        const overridden = await options.sendOverride(request, {
          state,
          setState(value) {
            state = value;
          },
        });
        if (overridden !== undefined) return overridden;
      }
      if (request.method === "initialize") {
        return rpcResult(request, { protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      }
      if (request.method === "tools/list") return rpcResult(request, { tools });
      if (request.method === "tools/call" && request.params.name === STATE_TOOL) {
        snapshotCalls += 1;
        return rpcResult(request, { structuredContent: structuredClone(state) });
      }
      if (request.method === "tools/call" && request.params.name === CUT_TOOL) {
        if (request.params.arguments.dryRun) {
          return rpcResult(request, {
            structuredContent: { wouldApply: true, affectedClipIds: ["clip-a"], estimatedCuts: 1 },
          });
        }
        state = { revision: 2, clips: [{ id: "clip-a", start: 1, end: 10 }] };
        return rpcResult(request, {
          structuredContent: { applied: true, undo: { token: "undo-token-1", tool: "frontiercut_undo" } },
        });
      }
      throw new Error(`Unexpected fixture request: ${request.method}`);
    },
  };
}

test("default transport bootstraps auth and uses only the real /api/mcp route", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/session") {
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined, "session bootstrap must not send the forbidden request body");
      return new Response(JSON.stringify({ token: "secret-session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(url, "/api/mcp");
    assert.equal(init.headers.Authorization, "Bearer secret-session");
    const request = JSON.parse(init.body);
    return new Response(JSON.stringify(rpcResult(request, { tools: [] })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const transport = createAuthenticatedGatewayTransport({ fetchImpl });
  const response = await transport.send({ jsonrpc: "2.0", id: "proof-1", method: "tools/list", params: {} });
  assert.equal(response.id, "proof-1");
  assert.deepEqual(calls.map(({ url }) => url), ["/api/session", "/api/mcp"]);
});

test("health outage prevents discovery and every mutation call", async () => {
  const transport = createFixtureTransport({
    health: { state: "degraded", dependencies: { kerfMcp: { state: "offline" } } },
  });
  const client = new FrontierMcpClient({ transport });
  await assert.rejects(
    client.mutateTimeline({ toolName: CUT_TOOL, arguments: {}, idempotencyKey: "outage-proof-001" }),
    (error) => error instanceof McpContractError && error.code === "MCP_UNHEALTHY",
  );
  assert.equal(transport.calls.length, 0, "unhealthy MCP must receive no RPC or mutation request");
});

test("capability discovery and preview-first commit verify state, idempotency, and undo", async () => {
  const transport = createFixtureTransport();
  const client = new FrontierMcpClient({ transport });
  const result = await client.mutateTimeline({
    toolName: CUT_TOOL,
    arguments: { thresholdDb: -35 },
    idempotencyKey: "timeline-edit-0001",
  });

  assert.equal(result.success, true);
  assert.equal(result.status, "verified");
  assert.notEqual(result.preStateHash, result.postStateHash);
  assert.deepEqual(result.undo, { token: "undo-token-1", tool: "frontiercut_undo", expiresAt: null });
  assert.equal(transport.snapshotCalls, 2, "state must be read before and after mutation");
  assert.deepEqual(transport.calls.slice(0, 2).map(({ method }) => method), ["initialize", "tools/list"]);
  const mutationCalls = transport.calls.filter(
    ({ method, params }) => method === "tools/call" && params.name === CUT_TOOL,
  );
  assert.equal(mutationCalls.length, 2);
  assert.equal(mutationCalls[0].params.arguments.dryRun, true);
  assert.equal(mutationCalls[0].params.arguments.idempotencyKey, "timeline-edit-0001:preview");
  assert.equal(mutationCalls[1].params.arguments.dryRun, false);
  assert.equal(mutationCalls[1].params.arguments.idempotencyKey, "timeline-edit-0001");
  assert.equal(mutationCalls[1].params._meta.idempotencyKey, "timeline-edit-0001");
});

test("dry run returns a preview without committing or inventing undo metadata", async () => {
  const transport = createFixtureTransport();
  const client = new FrontierMcpClient({ transport });
  const result = await client.mutateTimeline({
    toolName: CUT_TOOL,
    arguments: { thresholdDb: -30 },
    idempotencyKey: "timeline-preview-01",
    dryRun: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.status, "previewed");
  assert.equal(result.verification.committed, false);
  assert.equal(result.undo, null);
  assert.equal(transport.snapshotCalls, 1);
  const cutCalls = transport.calls.filter(({ params }) => params?.name === CUT_TOOL);
  assert.equal(cutCalls.length, 1);
  assert.equal(cutCalls[0].params.arguments.dryRun, true);
});

test("mutation transport failure re-reads state and reports partial failure when state changed", async () => {
  let commitAttempted = false;
  const transport = createFixtureTransport({
    async sendOverride(request, stateAccess) {
      if (
        request.method === "tools/call" &&
        request.params.name === CUT_TOOL &&
        request.params.arguments.dryRun === false
      ) {
        commitAttempted = true;
        stateAccess.setState({ revision: 2, clips: [] });
        throw new Error("connection lost after dispatch");
      }
    },
  });
  const client = new FrontierMcpClient({ transport });
  const result = await client.mutateTimeline({
    toolName: CUT_TOOL,
    arguments: {},
    idempotencyKey: "partial-failure-01",
  });
  assert.equal(commitAttempted, true);
  assert.equal(result.success, false);
  assert.equal(result.status, "partial_failure");
  assert.equal(result.verification.changed, true);
  assert.equal(result.undo, null);
  assert.match(result.failure, /connection lost after dispatch/);
});

test("malformed or mismatched JSON-RPC response is rejected", async () => {
  const transport = createFixtureTransport({
    sendOverride(request) {
      if (request.method === "initialize") {
        return { jsonrpc: "2.0", id: "wrong-correlation", result: { capabilities: {} } };
      }
    },
  });
  const client = new FrontierMcpClient({ transport });
  await assert.rejects(
    client.discoverCapabilities(),
    (error) => error instanceof McpContractError && error.code === "INVALID_JSON_RPC",
  );
});

test("missing undo metadata prevents a successful mutation claim", async () => {
  const transport = createFixtureTransport({
    sendOverride(request, stateAccess) {
      if (
        request.method === "tools/call" &&
        request.params.name === CUT_TOOL &&
        request.params.arguments.dryRun === false
      ) {
        stateAccess.setState({ revision: 2, clips: [] });
        return rpcResult(request, { structuredContent: { applied: true } });
      }
    },
  });
  const client = new FrontierMcpClient({ transport });
  const result = await client.mutateTimeline({
    toolName: CUT_TOOL,
    arguments: {},
    idempotencyKey: "missing-undo-0001",
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "partial_failure");
  assert.match(result.failure, /undo metadata/);
});

test("image proof hashes transported bytes and rejects labels, MIME lies, and tampering", async () => {
  const pngBytes = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1,
    8, 6, 0, 0, 0, 31, 21, 196, 137,
  ]);
  const payload = await createImageByteTransport(pngBytes, "image/png");
  const verified = await verifyImageByteTransport(payload);
  assert.equal(payload.byteLength, pngBytes.byteLength);
  assert.match(payload.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(verified.bytes, pngBytes);
  await assert.rejects(() => createImageByteTransport("screenshot.png", "image/png"), /bytes; filenames/);
  await assert.rejects(() => createImageByteTransport(new TextEncoder().encode("[Attached image]")), /supported image signature/);
  await assert.rejects(() => createImageByteTransport(pngBytes, "image/jpeg"), /does not match byte signature/);
  const tampered = { ...payload, data: `${payload.data.slice(0, -2)}AA` };
  await assert.rejects(() => verifyImageByteTransport(tampered), /do not match their recorded proof/);
});
