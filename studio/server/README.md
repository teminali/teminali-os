# Frontier local gateway

The gateway binds to `127.0.0.1:4310` by default. It never accepts a non-loopback bind address, forwards provider credentials only from the server process environment, and writes metadata-only audit records to `benchmark-results/gateway-audit.jsonl` with bounded rotation.

## Browser session

An allowed development origin obtains the process-lifetime bearer token with:

```http
POST /api/session
Origin: http://localhost:3000
```

The request must have no body. Send the returned token on every protected request as `Authorization: Bearer <token>`. The exact default allowed origins are `localhost` and `127.0.0.1` on ports 3000 and 3001. Override this list with `FRONTIER_ALLOWED_ORIGINS`, which still accepts only exact HTTP loopback origins.

## Routes

- `GET /health` and `GET /api/health`: public gateway, Ollama, and Kerf MCP health.
- `POST /session` and `POST /api/session`: allowed-origin session bootstrap.
- `POST /ollama/generate` and `POST /api/ollama/generate`: authenticated Ollama generate proxy.
- `POST /ollama/chat` and `POST /api/ollama/chat`: authenticated Ollama chat proxy.
- `POST /anthropic/v1/messages` and `POST /api/anthropic/v1/messages`: authenticated Anthropic Messages proxy.
- `POST /mcp` and `POST /api/mcp`: authenticated, health-gated Kerf JSON-RPC proxy.
- `POST /api/audit`: authenticated metadata-only client audit ingestion.

Ollama and Anthropic preserve streaming response bodies. Client disconnects and configured timeouts abort the upstream request. Non-streamed responses are bounded, parsed, and checked against provider response schemas before reaching the client.

## Environment

- `FRONTIER_GATEWAY_PORT` defaults to `4310`.
- `FRONTIER_ALLOWED_ORIGINS` is a comma-separated loopback-origin allowlist.
- `OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434` and must remain loopback HTTP.
- `KERF_MCP_URL` defaults to `http://127.0.0.1:3888` and must remain loopback HTTP.
- `ANTHROPIC_API_KEY` enables the Anthropic route. Client-provided provider keys are ignored.
- `FRONTIER_REQUEST_TIMEOUT_MS` defaults to 120 seconds.
- `FRONTIER_HEALTH_TIMEOUT_MS` defaults to 1.5 seconds.
- `FRONTIER_MAX_JSON_BYTES` defaults to 1 MiB.
- `FRONTIER_MAX_OLLAMA_JSON_BYTES` defaults to 8 MiB so optimized image attachments can reach the dedicated local vision lane; non-Ollama JSON endpoints remain at 1 MiB.
- `FRONTIER_MAX_STREAM_BYTES` defaults to 64 MiB.
- `FRONTIER_AUDIT_MAX_BYTES` defaults to 2 MiB per file.
- `FRONTIER_AUDIT_MAX_FILES` defaults to three rotated files.

Run the gateway with `npm run server`. Run its focused tests with `node --test server/gateway.test.js`.
