# The local gateway (`studio/server/`)

Every privileged thing Teminali Code does — reading the workspace, running a
command, driving the screen, spending a provider token — happens here, not in
the renderer. The renderer is treated as untrusted: it may ask, and the gateway
decides.

The process binds to `127.0.0.1` and refuses to start on any other host. Bind
address, upstream URLs and allowed origins are all re-validated as loopback at
startup, so a non-loopback value is rejected rather than accepted and quietly
ignored. Provider credentials are read from the server process environment only;
a key supplied by a client is discarded.

Entry point is [`api-server.js`](api-server.js), which is a thin wrapper around
`createGateway()` in [`gateway.js`](gateway.js). Configuration lives in
[`config.js`](config.js), and each area has its own module beside it
(`guardian.js`, `arena.js`, `providers.js`, `voice.js`, `assistant.js`, …).

## Authentication

Two endpoints are reachable without a token: `GET /health` and
`POST /api/session`. Everything else answers `401 AUTH_REQUIRED` without a valid
bearer.

```http
POST /api/session
Origin: http://localhost:3000
```

The request must carry no body; one is rejected with `SESSION_BODY_FORBIDDEN`.
The response is a process-lifetime token to send as
`Authorization: Bearer <token>` on every other route.

Origin is load-bearing here. `POST /api/session` requires an `Origin` header and
refuses without one, because the gateway never fabricates an origin for a
header-less caller — doing so would hand the bearer token to any local process
that simply omitted the header. Default allowed origins are `127.0.0.1` and
`localhost` on ports 3000 and 3001; `FRONTIER_ALLOWED_ORIGINS` replaces that
list and still accepts only exact `http://` loopback origins.

A subset of routes needs more than a bearer. `admin` in the table below means
the caller's connected GitHub login must be an administrator, enforced in the
gateway with `403 ADMIN_REQUIRED`. The first connected account may claim that
role via `POST /api/admin/claim`, and only while no administrator exists yet;
`TEMINALI_ADMINS` additionally pins logins that no API call can remove.

## Routes

62 method-and-path pairs over 67 request paths — most `/api/…` routes have no
un-prefixed alias, but `/health`, `/session`, `/mcp`, `/anthropic/v1/messages`
and the two Ollama routes do. `studio/README.md` summarises these by area; this
is the complete list.

### Health, session, audit

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/health` · `/api/health` | public | Gateway state plus Ollama and Teminali Cut MCP probes. Reports `healthy` only when both dependencies are, `degraded` otherwise. |
| `POST` | `/session` · `/api/session` | origin | Session bootstrap. Allowed origin required, body forbidden. |
| `POST` | `/api/audit` | bearer | Client audit ingestion, metadata only, validated against an allowlist. Answers `202`. |

### Model mode and routing

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/frontier/status` | bearer | Current model mode and whether an expert-qualified provider is reachable. |
| `POST` | `/api/frontier/resolve-mode` | bearer | Resolves a requested mode against what the machine and providers can actually serve. Answers `402 PLAN_UPGRADE_REQUIRED` when the resolved profile needs a capability the licence does not carry. |
| `GET` | `/api/models` · `/api/models/local` | bearer | Models installed in Ollama, from its `api/tags`. |
| `GET` | `/api/models/library` | bearer | The catalog, filtered against the detected device and what is already installed. |
| `POST` | `/api/models/resolve` | bearer | Picks a model for a given prompt. |
| `POST` | `/api/models/pull` | bearer | Pulls an Ollama model. |
| `GET` | `/api/system/device` | bearer | Detected device class — the memory ceiling the model picker respects. |

### Hosted providers

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/providers` | bearer | Configured providers and their lanes. Keys are never returned. |
| `POST` | `/api/providers/key` | bearer | Stores a provider key, written `0600`, never echoed back to the renderer. |
| `POST` | `/api/providers/lanes` | bearer | Assigns which lanes a provider serves. |

### Workspace

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/workspace/tree` | bearer | The workspace tree under the configured root. |
| `POST` | `/api/workspace/file` | bearer | Reads one file. Paths over 2,048 characters are rejected. |
| `POST` | `/api/workspace/write` | bearer | Writes one file. |
| `POST` | `/api/workspace/search` | bearer | Searches the workspace. |
| `GET` | `/api/workspace/projects` | bearer | The current project plus the remembered recents. A recent whose directory is gone is filtered out of the response but kept in the store, so a project on an unmounted volume comes back when the volume does. |
| `POST` | `/api/workspace/open` | bearer | Opens a project and rebinds the workspace root. An unopenable or over-broad root is refused. |
| `POST` | `/api/workspace/projects/remember` | bearer | Records a project in the recents **without** rebinding the workspace root. What a video project uses, so opening a timeline does not repoint the file tree, search and terminals at the folder holding it. |
| `POST` | `/api/workspace/projects/forget` | bearer | Drops one project from the recents. |

### Terminal

| | Path | Auth | |
| --- | --- | --- | --- |
| `POST` | `/api/terminal/exec` | bearer | Runs one shell command in the workspace, streaming `application/x-ndjson`. |

### Agent CLIs

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/agents` | bearer | Which agent CLIs are installed and runnable. |
| `GET` | `/api/agents/models` | bearer | What each CLI actually resolved its model alias to, learned from its own init event. |
| `POST` | `/api/agents/run` | bearer | Runs a turn through one agent CLI. |

### Screen assistant

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/assistant/capabilities` | bearer | What the native helper can do on this machine right now. |
| `POST` | `/api/assistant/permissions` | bearer | Raises the system Accessibility dialog. Only on an explicit operator action — never on a poll. |
| `POST` | `/api/assistant/observe` | bearer | Captures one observation of the screen and returns its `observationId`. |
| `POST` | `/api/assistant/act` | bearer | Acts on a named observation. The gateway re-checks the action against that observation; an expired one is refused. A `launch` step opens an application from the fixed catalogue in `server/assistant.js` — never a path or a command — and expires the observation it ran under. |

### Voice

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/voice/status` | bearer | Whether the VibeVoice sidecar is up, and whether it offers ASR, TTS or both. Reports `gated: "voice.vibevoice"` when the plan cannot reach the sidecar tier. |
| `POST` | `/api/voice/transcribe` | bearer | Speech to text. Refused when no ASR is available at all; served by whisper.cpp rather than the sidecar when the plan does not carry `voice.vibevoice`. Multipart fields: `audio`, `language` (`auto` guesses, and guesses badly on short or non-English takes), and `maxSegmentChars` — pass it and the local engine returns `segments` with real millisecond `startMs`/`endMs`, which is what a caption track needs. The sidecar returns none. |
| `POST` | `/api/voice/speak` | bearer | Text to speech. Refused when no TTS is available at all; served by the system voices rather than the sidecar when the plan does not carry `voice.vibevoice`. |

### Entitlement

What this machine may do, and how it comes to be allowed more. The gates
themselves live at the routes they guard; these routes exist so the UI can show
the state and act on it rather than inferring the plan from a refusal it
happened to receive.

The last three are thin proxies to the billing service, and they are proxies
rather than direct calls from the renderer for one reason: the gateway holds
the billing session token and the service address, and a token reachable from
the page is a token reachable from anything the page ever renders. Nothing here
decides what a plan costs or what it unlocks — prices come from the service,
capabilities from `licence/entitlements.js`, and a licence only ever arrives
through `/api/entitlement/refresh`, where it is verified before it is stored.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/entitlement` | bearer | The current plan, capabilities, licence state and expiry, plus the capability catalogue an upgrade screen renders from. |
| `POST` | `/api/entitlement/refresh` | bearer | Asks the billing service for a fresh licence. A network failure returns the cached entitlement rather than a downgrade. |
| `POST` | `/api/entitlement/sign-in` | bearer | Starts a device-code sign-in and returns the code to type on another device. Optional `provider` (`github`, the default, or `google`) is passed through to the billing service. |
| `POST` | `/api/entitlement/sign-in/poll` | bearer | `{ status: "pending" }` until the code is claimed, then the granted entitlement. |
| `POST` | `/api/entitlement/sign-out` | bearer | Revokes the session at the billing service, then forgets the licence and the session here. The local half happens even when the service cannot be reached, so this route does not fail. |
| `GET` | `/api/entitlement/plans` | bearer | What is for sale, proxied from the billing service. Public on the far side — no billing session needed, because a price is a thing you read before you have an account. |
| `POST` | `/api/entitlement/checkout` | bearer | Starts a payment. `{ rail: "stripe" \| "lipia", priceId, msisdn? }`. Stripe answers `{ url }` to open in a browser; Lipia answers `{ order }` to poll while the handset prompt is approved. Refuses an unknown rail and a signed-out caller before touching the network. |
| `GET` | `/api/entitlement/order/:id` | bearer | How one payment is going. Scoped to the signed-in account by the billing service, which reconciles on read. |

### Guardian

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/guardian/snapshot` | bearer | Memory pressure and loaded models, with the same thresholds the sweep acts on. |
| `POST` | `/api/guardian/unload` | bearer | Unloads a loaded model. |
| `GET` | `/api/guardian/governor` | bearer | Governor settings plus the current open-application inventory. |
| `POST` | `/api/guardian/governor/settings` | bearer | Saves governor settings. |
| `POST` | `/api/guardian/governor/enforce` | bearer | Applies the governor now. |
| `GET` | `/api/guardian/storage` | bearer | Disk reclaim advice. |

### Files

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/files/capabilities` | bearer | Which attachment types can be ingested on this machine. |
| `POST` | `/api/files/ingest` | bearer | `multipart/form-data` only; any other content type is rejected. |

### Usage

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/usage` | bearer | The ledger, `?days=` clamped to 1–90, default 7. |
| `POST` | `/api/usage` | bearer | Records a turn the gateway cannot observe for itself — a local turn is counted in the renderer. |
| `GET` | `/api/plan` | bearer | Who each agent CLI is signed in as, and the plan windows it last reported. `limits` is `{}` until a subscription turn runs. |

### Benchmarks and arena

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/benchmarks/latest` | bearer | The newest benchmark artifact. The analyzer validates its own provenance hashes; the gateway only hands it over. |
| `POST` | `/api/arena/sandbox` | admin | Creates a contestant sandbox. |
| `POST` | `/api/arena/measure` | admin | Runs a measurement. |
| `POST` | `/api/arena/measure/stream` | admin | The same, streamed. |
| `GET` | `/api/arena/history` | admin | Past runs. |
| `POST` | `/api/arena/history` | admin | Appends a run. |
| `POST` | `/api/arena/cleanup` | admin | Removes sandboxes. |

### GitHub and identity

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/github/status` | bearer | Whether a GitHub token is present, from the provider store or `GITHUB_TOKEN`. |
| `GET` | `/api/github/repos` | bearer | Repositories visible to that token. |
| `POST` | `/api/github/token` | bearer | Stores a GitHub token. Malformed tokens are rejected as `INVALID_GITHUB_TOKEN`. |
| `POST` | `/api/github/clone` | bearer | Clones a repository into the workspace. |
| `GET` | `/api/me` | bearer | The connected identity and whether it is an administrator. |
| `POST` | `/api/admin/claim` | bearer | First-account administrator bootstrap; refused once an administrator exists. |
| `POST` | `/api/admin/admins` | admin | Adds or removes administrators. |

### Updates and releases

| | Path | Auth | |
| --- | --- | --- | --- |
| `GET` | `/api/updates/check` | bearer | Deliberately not administrator-gated: knowing you are behind is not a privileged fact. |
| `POST` | `/api/updates/download` | bearer | Downloads a release, abortable by client disconnect. |
| `POST` | `/api/updates/publish` | admin | Publishes a release to `TEMINALI_RELEASE_REPO`. |

### Upstream proxies

| | Path | Auth | |
| --- | --- | --- | --- |
| `POST` | `/ollama/generate` · `/api/ollama/generate` | bearer | Ollama generate. |
| `POST` | `/ollama/chat` · `/api/ollama/chat` | bearer | Ollama chat. |
| `POST` | `/anthropic/v1/messages` · `/api/anthropic/v1/messages` | bearer | Anthropic Messages. Needs `ANTHROPIC_API_KEY` in the server environment. |
| `POST` | `/mcp` · `/api/mcp` | bearer | Teminali Cut MCP JSON-RPC. Health-gated: an unhealthy sidecar fails with `503 MCP_OFFLINE` rather than attempting a timeline mutation. |

Anything unmatched is `404 NOT_FOUND`.

## Proxy behaviour

Ollama and Anthropic preserve streaming response bodies. A client disconnect or
a configured timeout aborts the upstream request rather than orphaning it.
Non-streamed responses are bounded, parsed, and checked against the provider's
response schema before any of it reaches the client.

## Terminal bounds

`/api/terminal/exec` runs a real shell command, so its bounds are enforced in
[`terminal.js`](terminal.js) rather than trusted to the caller:

- The working directory is resolved against the workspace root and cannot escape
  it (`TERMINAL_CWD_ESCAPE`).
- Commands are capped at 8,000 characters, output at 1 MiB, runtime at 120
  seconds, with a 2-second kill grace.
- The process is killed on timeout, on the output cap, or when the requesting
  client disconnects.
- `ANTHROPIC_API_KEY`, `FRONTIER_SESSION_TOKEN`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY` and `GROQ_API_KEY` are stripped from the child environment.
  A command inherits the gateway's environment, and leaving those readable would
  make any `env`-capable command a credential exfiltration path.

Note that this route is bearer-authenticated but **not** administrator-gated,
and the command string is passed to a shell. The bearer token is the boundary.

## Audit

Every request writes a metadata-only record to
`benchmark-results/gateway-audit.jsonl`: route, method, status, duration,
correlation id and byte counts. Prompts, responses, file contents and
transcripts are never written. Rotation is bounded by `FRONTIER_AUDIT_MAX_BYTES`
and `FRONTIER_AUDIT_MAX_FILES`, and the path itself by `FRONTIER_AUDIT_PATH`.

Every response carries `x-correlation-id`, echoing the request's own if it sent
a well-formed one.

## Configuration

All optional; every default is loopback. Non-loopback URLs and origins throw at
startup.

| Variable | Default |
| --- | --- |
| `FRONTIER_GATEWAY_PORT` | `4310` |
| `FRONTIER_ALLOWED_ORIGINS` | `127.0.0.1` and `localhost` on ports 3000 and 3001 |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `TEMINALI_CUT_MCP_URL` | `http://127.0.0.1:3888` — `KERF_MCP_URL` is still read as a fallback, but it is the old name |
| `TEMINALI_VOICE_URL` | `http://127.0.0.1:8321` |
| `TEMINALI_VOICE_TIMEOUT_MS` | `30000` |
| `TEMINALI_VOICE_MAX_AUDIO_BYTES` | 25 MiB |
| `ANTHROPIC_API_KEY` | unset; enables the Anthropic route |
| `GITHUB_TOKEN` | unset; fallback when no token is in the provider store |
| `FRONTIER_REQUEST_TIMEOUT_MS` | `600000` (10 minutes) |
| `FRONTIER_HEALTH_TIMEOUT_MS` | `1500` |
| `FRONTIER_MAX_JSON_BYTES` | 1 MiB |
| `FRONTIER_MAX_OLLAMA_JSON_BYTES` | 8 MiB, so optimized image attachments reach the local vision lane without widening other JSON ingress |
| `FRONTIER_MAX_STREAM_BYTES` | 64 MiB |
| `FRONTIER_WORKSPACE_ROOT` | the repository root |
| `FRONTIER_WORKSPACE_MAX_FILE_BYTES` | 8 MiB |
| `FRONTIER_TERMINAL_TIMEOUT_MS` | `120000` |
| `FRONTIER_TERMINAL_MAX_OUTPUT_BYTES` | 1 MiB |
| `FRONTIER_AUDIT_PATH` | `benchmark-results/gateway-audit.jsonl` in the working directory |
| `FRONTIER_AUDIT_MAX_BYTES` | 2 MiB per file |
| `FRONTIER_AUDIT_MAX_FILES` | `3` rotated files |
| `TEMINALI_RUNTIME_MODE` | `local`; `api` routes to a hosted provider instead |
| `TEMINALI_RELEASE_REPO` | `teminali/teminalicode` |
| `TEMINALI_APP_ROOT` | the working directory |
| `TEMINALI_ADMINS` | unset; comma-separated logins pinned as administrators |

State files, all defaulting under `benchmark-results/` in the working directory:

| Variable | Holds |
| --- | --- |
| `FRONTIER_PROJECTS_STORE` | `recent-projects.json` |
| `TEMINALI_PROVIDER_STORE` | `provider-keys.json`, written `0600` |
| `TEMINALI_GUARDIAN_STORE` | `guardian-settings.json` |
| `TEMINALI_AGENT_MODEL_STORE` | `agent-models.json` |
| `TEMINALI_ADMIN_STORE` | `admins.json` |
| `TEMINALI_USAGE_LEDGER` | `usage-ledger.jsonl` |
| `TEMINALI_PLAN_STORE` | `plan-limits.json` — the plan windows the agent CLI last reported |
| `TEMINALI_ARENA_HISTORY` | `arena-runs.jsonl` |
| `TEMINALI_ASSISTANT_FRAMES` | `assistant-frames/` — screenshots the assistant looked at, pruned to the last handful |

## Running and testing

```bash
npm run server        # the gateway alone
npm run dev:full      # gateway + Vite renderer in the browser
npm run test:gateway  # this server's focused suite — 20 tests
```

A gateway is often already listening on `:4310`; use
`FRONTIER_GATEWAY_PORT=4319` when running the tests against a busy machine. If
`ELECTRON_RUN_AS_NODE=1` is set in your shell, prefix with
`env -u ELECTRON_RUN_AS_NODE`.
