# Design — Teminali Code

> **The Teminali Design System (TDS) lives in one place:
> [`studio/DESIGN.md`](studio/DESIGN.md).**

This file used to hold a second copy of that contract. It drifted — it was still
calling the product "Teminali Studio", its shell diagram predated the screen
assistant, and it was missing §5 entirely. A design contract that exists twice is
a design contract that is wrong once, so the copy is gone rather than resynced.

Read [`studio/DESIGN.md`](studio/DESIGN.md) for:

| § | Subject |
| --- | --- |
| 0 | The token sheet — the only source of colour, size, radius, duration and curve |
| 1 | Zero-slop principles — no gradients, no edge lighting, no decorative colour |
| 2 | Component primitives and the governance law |
| 3 | Shell architecture — sidebar, panels, agent tabs, arena, usage, menu bar items |
| 4 | The official model wrappers |
| 5 | The screen assistant |
| 6 | Voice |

## What belongs here instead

Design decisions that span the repository rather than the interface.

### One product, three trust boundaries

```
renderer  ──▶  gateway  ──▶  the machine
 no keys       loopback      Ollama · CLIs · whisper · AX tree · gh
 no weights    bearer token
 no fs         re-checks everything the renderer checked
```

The renderer is treated as untrusted by the gateway even though they ship in one
binary. Every check the interface performs for the operator's benefit is
performed again at the boundary, because the interface is the layer a bug or an
injected script can reach. The clearest case is the screen assistant:
`validatePlan` drops unresolvable steps in the renderer, and
`/api/assistant/act` independently refuses an expired observation, an unknown or
disabled element, and any action taken after the frontmost application changed.

### Measured or null, never plausible

Guardian reports a metric it could not read as `null` and names it in
`unavailable`. The visual and performance runtimes return `unmeasured` rather
than a score. The usage ledger stores an unreported cost as `null`, never `0`.
A number that looks like data but is a fallback is worse than a gap, because a
gap is legible and a fallback is not.

### The dangerous verbs are the defensive ones

Three subsystems can affect things outside the app, and each is deliberately the
most conservative code in its area:

- **The governor** closes applications: graceful `quit` only, unsaved work is
  absolute, *unknown* counts as unsafe, and the protected list cannot be emptied.
- **The screen assistant** clicks things: autonomy defaults to `confirm`, and
  positions come from the accessibility tree because a vision model asked for a
  coordinate returns one that is plausible and wrong.
- **Release publishing** puts a binary in front of every install: administrator
  only, gated on typecheck → test → build → preflight, and it ships what is
  committed.

### No shell strings

Every subprocess in the repository is `execFile`/`spawn` with an argument array.
Model names, repository names and prompts all arrive from outside, and a `;` in
one must be an invalid name rather than a command separator.

### Verification is a runtime, not a convention

`studio/{agent,quality,visual,performance,mcp}-runtime/` are dependency-free Node
packages with their own tests and READMEs, kept separate from the app so a
failure can be attributed to the editor, the runtime or the model rather than
being scored against whichever is easiest to blame.

## Related documents

- [`studio/README.md`](studio/README.md) — what the application actually does.
- [`GATEWAY_DESIGN.md`](GATEWAY_DESIGN.md) — the routing gateway's own design.
- [`studio/docs/INVESTIGATION_DOCTRINE.md`](studio/docs/INVESTIGATION_DOCTRINE.md)
  — how a model is required to investigate before it answers.
