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
- Verified 19 offline tests and a clean diff check.
## Active
- Save the verified provider-adapter checkpoint.
## Blocked
- Live provider adapters require explicit secret handling and spending approval.
## Next Action
- Implement an environment-based launcher with strict configuration validation, without live provider traffic.
## Evidence
- “GROQ GPT OSS 120B READY”
- `npm test --silent`: 19 passed, 0 failed.
- `git diff --check` passed.
- `gateway/provider-adapters.js` maps the logical model to official OpenAI-compatible Gemini and Groq endpoints.
