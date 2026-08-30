# Rate-Aware Model Gateway — MVP Contract

## Objective

Build a local OpenAI-compatible gateway that lets OpenCode use explicitly
authorized model-provider credentials through a single endpoint while respecting
each credential's published limits.

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

## Provider profiles

- `gateway/lanes.controlled-claude-sonnet.json`: Sonnet 5 medium, pinned, no fallback.
- `gateway/lanes.controlled-claude-opus.json`: Opus 5 high, pinned, no fallback.
- `gateway/lanes.enhanced-claude-groq.example.json`: Sonnet 5 primary plus three
  separately authorized Groq organization lanes.
- Anthropic identity-linked keys require both `ANTHROPIC_API_KEY` and
  `ANTHROPIC_WORKSPACE_ID`; both remain runtime-only and are never committed.
- Claude Sonnet 5 is budgeted at $2/M input and $10/M output; Opus 5 at $5/M
  input and $25/M output. The gateway reserves requested worst-case output before
  dispatch and reconciles it to validated reported usage after response completion.

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

- No billing system or public multi-tenant deployment.
- No browser dashboard.
- No automatic account creation or credential acquisition.
- No pooling of credentials without each owner's explicit authorization.
- No modification of the `commercial-editor` repository.
