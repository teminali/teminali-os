# Rate-Aware Model Gateway — contract

> **Status: shipped.** This began as an MVP contract and the code now meets it.
> Everything below describes behaviour that exists in `gateway/`, not intent.
> The implementation is [`gateway/http-gateway.js`](gateway/http-gateway.js)
> (the HTTP surface), [`gateway/frontier-runner.js`](gateway/frontier-runner.js)
> (modes and profiles), [`gateway/quota-pool.js`](gateway/quota-pool.js) and
> [`gateway/run-budget.js`](gateway/run-budget.js) (the accounting this contract
> is mostly about).

## Objective

A local OpenAI-compatible gateway that lets a client use explicitly authorized
model-provider credentials through a single endpoint while respecting each
credential's published limits.

Two clients exist. Teminali OS's studio is the primary one and reaches the
gateway through its own local server; OpenCode is the original one and still
works, via `opencode.gateway.jsonc`. Neither needed a workflow change to gain
the pooling behaviour, which was the point.

The gateway is a product prototype, not a mechanism for evading provider terms.

## Baseline and production modes

- **Controlled baseline:** pin one Groq credential and GPT-OSS-120B so benchmark
  results remain comparable.
- **Authorized pool:** route requests across separately authorized credentials
  using observed quota and cooldown state.
- **Future provider pool:** add other OpenAI-compatible providers behind the same
  interface without changing OpenCode's workflow.

## MVP request path

1. OpenCode calls the gateway's `/v1/chat/completions` endpoint.
2. The gateway authenticates the local caller.
3. It selects an eligible credential with the most conservative available quota.
4. It reserves the request attempt, conservative input estimate, requested maximum
   output, and worst-case USD cost against the process-scoped run budget.
5. It forwards the request without changing messages, tools, or reasoning options.
6. It streams the upstream response transparently.
7. At response EOF, it settles token, quota, and USD accounting to strict canonical
   provider usage when available. Missing, malformed, oversized, or interrupted
   telemetry retains the conservative reservation.
8. On a pre-stream `429`, it records `retry-after`, cools down that credential,
   and tries another eligible credential at most once.
9. If quota or run budget is unavailable, it returns a local `429` without
   contacting another provider.

## Safety and security requirements

- Listen on `127.0.0.1` by default.
- Require a local gateway access token.
- Load provider credentials only from environment variables or a secret file
  outside the repository.
- Never log, return, persist, or commit provider credentials.
- Never include authorization headers in diagnostics.
- Keep credential state isolated; do not mix credentials between tenants.
- Reject unsupported upstream hosts and models.
- Bound request size, retry count, and request duration.
- Require process-scoped maximum requests, estimated tokens, and USD before start.
- Price output at its requested maximum, including reasoning/thinking tokens.
- Reconcile successful responses only from validated input/output usage fields;
  never trust inconsistent totals or partial telemetry.
- Preserve provider error codes and useful non-secret rate-limit metadata.

## Routing requirements

- Maintain per-quota-group RPM, RPD, TPM, daily-token, cooldown, and in-flight state.
- Prefer response rate-limit headers over estimates when available.
- Use conservative token estimates before dispatch.
- Do not send a request whose estimated size exceeds a credential's remaining
  budget.
- Settle completed usage after the response body finishes; interrupted responses
  keep conservative accounting so disconnects cannot bypass limits.
- Use deterministic selection so runs can be audited and reproduced.
- Emit credential aliases such as `groq-a`, never key fragments.

## Initial endpoints

- `POST /v1/chat/completions`
- `GET /health`
- `GET /metrics` with non-secret counters only

## Model modes

The product surface is three modes, defined in `MODEL_MODES` in
[`gateway/frontier-runner.js`](gateway/frontier-runner.js). They pick a profile;
they are not themselves models.

| Mode | Resolves to | Meaning |
| --- | --- | --- |
| `flash` | `local` | Lightweight local model for every task. |
| `auto` | `local`, escalating | Hybrid routing between the lightweight and heavyweight local models. |
| `max` | `local-expert` | Heavyweight local model for every task. |

`max` is gated. `isExpertModelQualified()` reads
[`gateway/model-qualification.json`](gateway/model-qualification.json), where
`qwen38Iq3m.qualified` is currently **`false`** — "Pending isolated model
comparison and FrontierCode safety canary". The mode is offered in the picker
and refuses to resolve until that flips.

## Profiles

Six, from `PROFILES` in the same file. Every one names its own lane file, and
the local profiles need no credentials at all.

| Profile | Lane file | Requires |
| --- | --- | --- |
| `local` | `lanes.controlled-local-coder.json` | nothing — Qwen2.5-Coder 14B, 16 GB floor |
| `local-expert` | `lanes.controlled-qwen38-expert.json` | nothing — Qwen3.8 27B IQ3_M, on demand |
| `local-24b` | `lanes.controlled-devstral.json` | nothing — Devstral 24B, needs 32 GB |
| `auto` | `lanes.enhanced-devstral-claude.example.json` | `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` |
| `claude-sonnet` | `lanes.controlled-claude-sonnet.json` | `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` |
| `claude-opus` | `lanes.controlled-claude-opus.json` | `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` |

The `local` profile carries a second, narrower configuration for structured
turns — `lanes.controlled-local-coder-8k.json`, an 8k context window and a
24 KiB snapshot cap — because a structured repair turn needs a tighter budget
than a conversational one.

## Lane files

All of `gateway/lanes.*.json` are configuration only and contain no keys.
Beyond the six above: `lanes.controlled-gemini.json` (the first-live-test
profile), `lanes.controlled-devstral-structured.json`,
`lanes.enhanced.example.json` (Gemini primary plus three independent Groq
organizations) and `lanes.enhanced-claude-groq.example.json` (Sonnet 5 primary
plus three separately authorized Groq organization lanes).

Anthropic identity-linked keys require both `ANTHROPIC_API_KEY` and
`ANTHROPIC_WORKSPACE_ID`; both remain runtime-only and are never committed.
Claude Sonnet 5 is budgeted at $2/M input and $10/M output; Opus 5 at $5/M input
and $25/M output. The gateway reserves requested worst-case output before
dispatch and reconciles it to validated reported usage after completion.

## Runtime launcher

Run `npm run gateway:start` only after defining:

- `GATEWAY_ACCESS_TOKEN`: local caller credential, at least 12 characters.
- Exactly one of `GATEWAY_LANES_JSON` or `GATEWAY_LANES_FILE`. It supplies a JSON
  array of explicitly authorized lanes. Each lane
  must contain `alias`, `provider`, `quotaGroup`, `apiKeyEnv`, `providerModel`,
  exact `limits` from that provider project or organization, and current
  `pricing.inputUsdPerMillion` and `pricing.outputUsdPerMillion`.
- The environment variable named by each lane's `apiKeyEnv`.
- `GATEWAY_MAX_REQUESTS_PER_RUN`, `GATEWAY_MAX_TOKENS_PER_RUN`, and
  `GATEWAY_MAX_USD_PER_RUN`.

Optional controls are `GATEWAY_PINNED_ALIAS`, `GATEWAY_PORT`,
`GATEWAY_LOGICAL_MODEL`, `GATEWAY_MAX_ATTEMPTS`,
`GATEWAY_MAX_OUTPUT_TOKENS`, `GATEWAY_DEFAULT_OUTPUT_TOKENS`, and
`GATEWAY_UPSTREAM_TIMEOUT_MS`.

The launcher binds only to `127.0.0.1`. It rejects endpoint overrides and does
not serialize provider keys or the local access token. Configuration names the
environment variables holding credentials; credential values never belong in
`GATEWAY_LANES_JSON`, files, logs, metrics, or commits.

`gateway/lanes.controlled-gemini.json` is the first-live-test profile.
`gateway/lanes.enhanced.example.json` is the Gemini-primary plus three independent
Groq-organization profile. Both contain configuration only; they contain no keys.

`npm run agent:start-claude` launches controlled Sonnet 5. `npm run
agent:start-opus` is an explicit escalation path. `npm run agent:start-enhanced`
requires one Anthropic key/workspace plus three separately authorized Groq keys.
The default interactive run cap is 12 requests, 300,000 estimated tokens, and
USD 0.20. `npm run claude:diagnose` and `npm run claude:diagnose-opus` each use
one request with a USD 0.005 hard cap.

Benchmark 001 is under `benchmarks/sonnet5-vs-antigravity-gemini37`. Preparation
creates two identical disposable Git repositories under the system temporary
directory. The hidden oracle stays outside both agent workspaces.

For the first controlled live validation, `npm run agent:start` prompts privately
for `GEMINI_API_KEY`, generates an ephemeral local access token, caps the gateway
at 1 request, 6,000 estimated tokens, 256 output tokens, and USD 0.01, then opens OpenCode. Exiting
OpenCode stops the gateway and deletes its temporary startup log.

Run budgets reset only when the gateway process restarts. Request attempts are
never refunded. Pre-stream failures release their estimated token and USD
reservation. Completed JSON and SSE responses settle to canonical reported usage
when valid. Missing or malformed telemetry, oversized capture, non-success HTTP
responses, and interrupted streams commit the conservative estimate. A request is
counted as completed only after a successful 2xx body is fully delivered.

After the gateway is running, `opencode.gateway.jsonc` can be selected through
`OPENCODE_CONFIG`. It connects OpenCode to `frontier-code` over loopback and
reads only the local gateway access token from the environment. The original
`opencode.jsonc` remains the controlled Groq baseline.

## Acceptance criteria

- Works with streaming and non-streaming OpenAI chat-completion requests.
- Preserves local tool-call payloads unchanged.
- A fake-upstream test proves a `429` fails over to a second authorized credential.
- A test proves secrets never appear in logs or responses.
- A test proves exhausted credentials produce a bounded local `429`.
- A test proves an exhausted run budget contacts no upstream.
- Tests prove JSON and fragmented SSE bodies remain byte-identical while valid
  usage reconciles quota and cost.
- A test proves an interrupted response releases reservations, keeps conservative
  accounting, and is not counted as completed.
- Controlled mode never uses more than its pinned credential.
- `npm test` passes without contacting Groq or any external service.

## Explicit non-goals for the MVP

- No public multi-tenant deployment.
- **Entitlements, not billing, are in the gateway.** The gateway refuses a
  profile the current plan does not carry — `POST /api/frontier/resolve-mode`
  answers `402 PLAN_UPGRADE_REQUIRED` when a resolved profile needs a
  capability the signed licence does not grant. It never talks to a payment
  provider, holds no card data and issues no licence; it reads a locally
  verified Ed25519 token and enforces what that token says. Signing and the
  payment rails live in `billing/`, a separate deployable service, which the
  `/api/entitlement/*` routes relay device-code sign-in and licence refresh to
  — a relay, not a rail: no amount, instrument or card ever passes through the
  gateway. Not every gate refuses: a caller
  without `voice.vibevoice` is served the built-in speech engines rather than a
  402, because the sidecar it gates runs locally. That capability is granted to
  every plan since 2026-09-05 — the free substitute it assumed does not exist
  on Windows — but the downgrade path is kept rather than deleted. See
  `licence/entitlements.js` for the plan/capability registry and the reasoning.
- No browser dashboard.
- No automatic account creation or credential acquisition.
- No pooling of credentials without each owner's explicit authorization.
