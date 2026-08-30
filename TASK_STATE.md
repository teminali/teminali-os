# Task State
## Objective
Build and verify the provider-agnostic gateway foundation for a frontier coding agent.
## Acceptance Criteria
- Quota routing models organization-scoped limits and rejects duplicate quota groups.
- The HTTP gateway authenticates clients, streams responses, fails over safely before streaming, and never exposes provider secrets.
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
- Verified 30 offline tests and a clean diff check.
## Active
- Save the verified hard-budget checkpoint.
## Blocked
- Live provider traffic still requires explicit user approval and interactive secret setup.
## Next Action
- Implement a bounded upstream timeout with abort and offline failure-path tests.
## Evidence
- “GROQ GPT OSS 120B READY”
- `npm test --silent`: 30 passed, 0 failed.
- `git diff --check` passed.
- `gateway/run-budget.js` uses conservative reservations and integer micro-dollar accounting.
- The hard-budget integration test records zero upstream hits after USD exhaustion.
