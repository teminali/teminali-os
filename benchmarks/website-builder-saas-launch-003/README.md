# Benchmark 003: Website Builder SaaS Launch

Evaluates autonomous coding agents on building a production-grade, accessible,
responsive website under the `website-builder` skill contract.

The contestant receives only a fresh copy of `seed/` plus `TASK.md`. The oracle
and rubric remain outside the contestant workspace. The seed is intentionally
functional but incomplete: its visible tests pass while the frozen oracle scores
20/100. This prevents a no-op submission from winning.

Validation commands from this directory:

```sh
(cd seed && npm test)
node oracle/score.mjs seed
shasum -a 256 -c MANIFEST.sha256
```

Do not edit `seed/src/site-data.json` during a run; it is the canonical fact set.

The preregistered comparison is Frontier Code local Devstral versus a fresh
Codex CLI process using `gpt-5.6-sol` at High reasoning. Runs are sequential in
byte-identical workspaces. Codex ignores saved user configuration and rules;
Frontier Code uses only its local profile, with cloud credentials removed. The
current coordinating conversation never edits either contestant workspace.
