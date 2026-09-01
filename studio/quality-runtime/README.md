# Fail-closed quality gate runtime

This dependency-free Node runtime executes configured typecheck, unit, integration, and browser commands without a shell. It is preparation for Phase 4, not evidence that Phase 4 has passed.

Each run creates a unique append-only artifact directory. Command stdout and stderr are preserved byte-for-byte in separate files with SHA-256 digests, byte counts, UTF-8 previews, command start/finish timestamps, duration, exit code, signal, timeout state, and output-limit state. The JSON report contains references to those exact streams and is bounded by `maxReportBytes`.

The runtime fails closed:

- all four gate types are mandatory;
- a missing runner is `unmeasured`, which prevents success;
- a zero-exit browser command remains `unmeasured` without a timestamped browser report, trace, and screenshot;
- recorded browser assertion, console, page, or network failures fail the browser gate;
- timeouts, non-zero exits, spawn failures, output overflow, missing evidence, and digest mismatches cannot pass.

Configuration commands use `{ "executable": "...", "args": ["..."] }` and never pass through a shell. Working directories, evidence, and artifact output must remain inside `projectRoot`.

Run focused tests:

```sh
node --test quality-runtime/tests/orchestrator.test.mjs
```

Run a configuration:

```sh
node quality-runtime/cli.mjs path/to/quality-config.json
```

The CLI exits non-zero unless every required gate has measured passing evidence.
