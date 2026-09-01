# Frontier single-agent runtime

This runtime executes an explicit `inspect → plan → edit → verify → repair → review → report` engineering loop. It permits edits only to caller-declared paths, uses exact-context atomic replacements, runs caller-declared allowlisted commands without a shell, persists resumable state under `.frontier-agent/runs`, and refuses to report success until real verification processes pass and review approves the scoped diff.

## Live seeded gate

Start the local gateway, then run:

```sh
node agent-runtime/run-seeded-live.js
```

The runner copies the deliberately broken fixture to a temporary workspace before invoking the real Ollama-backed `GatewayPlanner`. It never modifies the committed fixture. `FRONTIER_GATEWAY_URL` defaults to `http://127.0.0.1:4310`, and `FRONTIER_AGENT_MODEL` defaults to `devstral-small-2:24b-instruct-2512-q4_K_M`. If `FRONTIER_GATEWAY_TOKEN` is absent, the runner obtains the process-lifetime token through the gateway's strict allowed-origin session bootstrap.

The printed report contains the temporary workspace path, exact changed-file hashes, tool calls, subprocess output, transitions, elapsed time, repair count, review verdict, and provider-reported token/duration usage. A model answer cannot convert failing commands into a successful report.

## Focused deterministic verification

```sh
node --test agent-runtime/runtime.test.js
```

The focused suite tests the complete repair path, persisted resume, path and command boundaries, active cancellation, loop detection, and strict parsing of authoritative gateway usage.
