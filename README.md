# Frontier

Frontier is the unified local-first AI coding platform. This repository contains both the agent/runtime system and the browser-based editor that presents it.

## Repository layout

- `bin/`, `gateway/`, `scripts/`, `skills/` — Frontier agent launcher, routing gateway, local-model controls, safety boundaries, and specialist skills.
- `benchmarks/` — isolated benchmark fixtures, preregistrations, evaluators, and historical evidence.
- `studio/` — the Frontier browser editor, copilot interface, local API server, visual verification, quality runtime, and desktop wrapper.

The repository root is the canonical project location. Do not develop against the former `opencode-agent-lab` or `commercial-editor` folders after migration is accepted; they are preserved temporarily only as recovery copies.

## First setup

```bash
npm run studio:install
```

The root agent runtime currently has no third-party package installation step.

## Daily development

```bash
# Browser editor plus its local API server
npm run dev

# Browser UI only
npm run dev:ui

# Frontier terminal/agent launcher
npm run frontier
```

## Verification

```bash
# Agent/runtime suite
npm test

# Browser editor suite
npm run studio:test

# Typecheck, tests, and production build across both product surfaces
npm run verify:all
```

## Product modes

- **Flash** — lightweight local model for the whole task.
- **Auto** — flagship hybrid local routing; it uses only qualified model paths and reports the path selected.
- **Max** — heavyweight local model for the whole task; locked until its exact model artifact and product path qualify on the target Mac.

## Benchmark rule

Benchmarks run only from fresh isolated workspaces with immutable preregistration, exact candidate identity, independent verification, resource telemetry, and no cross-candidate assistance. The browser editor, runtime, and model must be reported as separate failure domains.
