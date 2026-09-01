# Live Ollama performance harness

This harness measures Ollama through Frontier's authenticated loopback gateway. It records wall-clock time to first emitted token, wall-clock total latency, and Ollama's authoritative prompt/evaluation counts and durations. Prompt and output content are never written to reports; the prompt is represented by its byte count and SHA-256 digest.

Run a warm benchmark with one unrecorded warmup and five recorded samples:

```sh
node performance-runtime/cli.js --runs 5
```

To observe a possible cold first request without unloading or restarting the model:

```sh
node performance-runtime/cli.js --runs 5 --include-cold
```

`--include-cold` only skips the warmup and records the first request as a cold observation candidate. Classification still comes from Ollama's `load_duration` and the report's recorded threshold. If the model was already resident, the sample remains classified as warm and the report contains a warning. The harness has no unload operation and never sends `keep_alive: 0`.

Reports are written with mode `0600` under `performance-runtime/results/`. Each contains raw samples, separate cold/warm/unknown groups, median, nearest-rank p95, measured field counts, run count, cancellation latency, configuration, and environment metadata. Missing provider values remain `null`; they are excluded from aggregates and mark the sample/report incomplete.

Run deterministic math, aggregation, stream-parser, schema, privacy, and no-unload tests with:

```sh
node --test performance-runtime/metrics.test.js
```
