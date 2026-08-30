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
4. It forwards the request without changing messages, tools, or reasoning options.
5. It streams the upstream response transparently.
6. On a pre-stream `429`, it records `retry-after`, cools down that credential,
   and tries another eligible credential at most once.
7. If none are eligible, it returns a clear `429` with the earliest safe retry time.

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
- Preserve provider error codes and useful non-secret rate-limit metadata.

## Routing requirements

- Maintain per-credential RPM, TPM, daily-token, cooldown, and in-flight state.
- Prefer response rate-limit headers over estimates when available.
- Use conservative token estimates before dispatch.
- Do not send a request whose estimated size exceeds a credential's remaining
  budget.
- Use deterministic selection so runs can be audited and reproduced.
- Emit credential aliases such as `groq-a`, never key fragments.

## Initial endpoints

- `POST /v1/chat/completions`
- `GET /health`
- `GET /metrics` with non-secret counters only

## Acceptance criteria

- Works with streaming and non-streaming OpenAI chat-completion requests.
- Preserves local tool-call payloads unchanged.
- A fake-upstream test proves a `429` fails over to a second authorized credential.
- A test proves secrets never appear in logs or responses.
- A test proves exhausted credentials produce a bounded local `429`.
- Controlled mode never uses more than its pinned credential.
- `npm test` passes without contacting Groq or any external service.

## Explicit non-goals for the MVP

- No billing system or public multi-tenant deployment.
- No browser dashboard.
- No automatic account creation or credential acquisition.
- No pooling of credentials without each owner's explicit authorization.
- No modification of the `commercial-editor` repository.
