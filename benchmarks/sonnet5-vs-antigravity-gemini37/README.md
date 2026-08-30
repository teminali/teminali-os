# Sonnet 5 vs Antigravity Gemini 3.7 Flash — benchmark 001

Prepare two identical disposable repositories:

```sh
npm run benchmark:prepare
```

The command prints JSON containing `opencode_run`, `antigravity_run`, the frozen
baseline commit, and the prompt path.

Run OpenCode on `opencode_run`:

```sh
npm run benchmark:start-sonnet -- /absolute/path/from/opencode_run
```

Enter the Claude key privately and the Anthropic workspace ID when prompted.
Paste the exact contents of `TASK.md` into OpenCode. The controlled profile is
pinned to Claude Sonnet 5 at medium effort; it cannot fail over to Groq. Benchmark
001 has an explicitly approved USD 0.50 process cap; ordinary agent runs retain
their lower USD 0.20 cap.

Open `antigravity_run` in Antigravity, select Gemini 3.7 Flash at medium
reasoning, and paste the same `TASK.md`. Do not allow a fallback model.

Stop each run at 20 minutes. Then score it without exposing the oracle to the
agent:

```sh
npm run benchmark:score -- /absolute/run/path opencode-sonnet5 123
npm run benchmark:score -- /absolute/run/path antigravity-gemini37 117
```

The final argument is elapsed wall-clock seconds. Results are printed as JSON.
Do not use `commercial-editor` for this benchmark.
