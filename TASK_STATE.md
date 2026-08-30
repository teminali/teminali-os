# Task State
## Objective
Build and verify the provider-agnostic gateway foundation for a frontier coding agent.
## Acceptance Criteria
- Quota routing models organization-scoped limits and rejects duplicate quota groups.
- The HTTP gateway authenticates clients, streams responses, fails over safely before streaming, and never exposes provider secrets.
- Provider calls abort at a configured deadline and remain within hard run budgets.
- OpenCode resolves the gateway model without replacing the controlled Groq baseline.
- Offline tests pass without real credentials, provider traffic, spending, or changes to `commercial-editor`.
## Completed
- Groq health check passed.
- Fresh session successfully recovered Active, Blocked, and Next Action with no file changes.
- Defined the capability-first frontier-agent roadmap and gateway contract.
- Implemented the organization-aware quota pool and authenticated streaming HTTP gateway.
- Implemented strict Gemini and Groq adapters with logical model mapping.
- Verified heterogeneous Gemini-to-Groq failover using fake upstreams.
- Implemented a strict local-only environment launcher with redacted startup output.
- Added requests-per-day enforcement alongside RPM, TPM, and daily-token limits.
- Implemented process-scoped request, estimated-token, and integer micro-USD guards.
- Required explicit per-lane pricing and verified local rejection before dispatch.
- Added bounded upstream abort handling and a distinct timeout response and metric.
- Added controlled Gemini and enhanced Gemini-plus-three-Groq non-secret profiles.
- Verified OpenCode resolves `frontier-gateway/frontier-code` at medium reasoning.
- Added and smoke-tested the one-command controlled-agent launcher with dummy credentials.
- Verified 32 offline tests and a clean diff check.
## Active
- Run the first controlled live Gemini validation.
## Blocked
- USD 0.01 live run approved; awaiting private Gemini key entry in the user's terminal.
## Next Action
- After approval, run `npm run agent:start`, enter the Gemini key privately, and send the exact-response health prompt in OpenCode.
## Evidence
- “GROQ GPT OSS 120B READY”
- `npm test --silent`: 32 passed, 0 failed.
- `git diff --check` passed.
- `opencode debug config --pure` resolved the gateway model and preserved the Groq baseline.
- Dummy-key `npm run agent:start` reached health, exited successfully, and left no listener behind.
