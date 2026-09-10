# Teminali OS — working agreement

The product is **Teminali OS** (`@teminali/os`, published as `teminali/teminali-os`).
The repository directory is still `teminaliCode` on disk, under
`my_projects/teminali/` beside `landing` and `teminaliCut` — deliberately not
renamed, because a git worktree and every absolute path in these docs point at
it. The root package is `@teminali/core`; "Frontier" names only the routing
gateway and the local model wrapper (Frontier Flash / Auto / Max).

The product was called **Teminali Code** until the 0.0.1 reset. Never
reintroduce "Teminali Code", "Teminali Studio" or "Frontier Code"; the one place
the old name still legitimately appears is `studio/tests/updates.test.mjs`,
where legacy asset fixtures prove the update matcher survives a rename.

## Docs are part of the feature, not a follow-up

**Any turn that adds, removes or changes a capability must update the owning
document in the same turn.** Not "later", not in a TODO — the docs went stale
once already because shipping and documenting were separate steps, and an audit
had to reconstruct the truth from source.

A change is doc-bearing if it alters any of: a route, a panel, a keyboard
shortcut, a model or profile, an engine, a permission or default, a limit, a
config/env var, an npm script, a test count quoted in a doc, or a name.

Pure refactors, formatting, and internal renames that change nothing an operator
can observe are doc-neutral. Say so explicitly rather than staying silent.

### Which document owns what

| You changed | Update |
| --- | --- |
| `studio/src/**` (UI, shell, panels, shortcuts, stores) | `studio/DESIGN.md` §3 — and `studio/README.md` if the capability is new |
| `studio/src/components/ui/**`, `studio/src/styles/tokens.css` | `studio/DESIGN.md` §0–§2 (tokens, primitives, governance) |
| `studio/src/services/assistant/**`, `studio/native/**` | `studio/DESIGN.md` §5 |
| `studio/src/services/voice/**` | `studio/DESIGN.md` §6, and `studio/docs/VOICE_SIDECAR.md` for the sidecar contract |
| `studio/server/**` — a **route** added/removed/renamed | `studio/README.md` route table **and** `studio/server/README.md` |
| `studio/server/config.js` — an env var or default | `studio/README.md` Configuration table |
| `gateway/**` — profiles, modes, lanes, qualification | root `README.md` Product modes, `GATEWAY_DESIGN.md`, and `studio/README.md` Engines |
| `studio/{agent,mcp,performance,quality,visual}-runtime/**` | that runtime's own `README.md`, and `studio/README.md` if its role changed |
| `studio/src/services/diligenceEngine.ts` (rules) | `studio/docs/INVESTIGATION_DOCTRINE.md` and `studio/docs/DILIGENCE_TEST_PLAN.md` |
| any `package.json` scripts, or the test count | both READMEs' Verification blocks — **run the suite, quote the real number** |
| `studio/electron-builder.yml`, `studio/build/**`, `.github/workflows/release.yml` | `studio/README.md` Packaging |

`studio/DESIGN.md` is the **canonical** design contract. Root `DESIGN.md` is a
pointer to it plus repo-level decisions — do not fork the TDS contract back into
it. That duplication is what drifted last time.

### Rules for the docs themselves

1. **Never write a number you did not measure.** Test counts come from running
   the suite. Route counts come from the gateway. If you cannot measure it, do
   not state it.
2. **A doc claim must name a real path.** Every file path cited in a doc must
   exist; a rename breaks the doc as surely as it breaks an import.
3. **Say what the code does, not what it should do.** If the doc describes an
   intention the code has not reached, mark it explicitly as not yet true.
4. **A code comment is a doc.** Correct it in the same edit that invalidates it.

## Scaling the local lane

Two things here are called Frontier. `gateway/frontier-runner.js` drives the
**OpenCode binary**; the Studio chat's local lane does not — it posts to
`/api/ollama/chat` and runs its own agent loop, borrowing only the runner's
routing table. Do not route the chat through OpenCode or reimplement it; see
root `DESIGN.md`, "The local lane is not OpenCode".

**A new local-lane capability earns its place against the eval, in that order:**
write the case in `studio/evals/local-lane.mjs`, run `npm run eval:local` for a
baseline, build the tool, re-run. A capability that does not raise the score does
not ship. The lane's constraint is window, not tool count — the eval exists
because reasoning about this was wrong twice in one session.

## Verification

```bash
npm test              # root gateway/runner/licence/billing suite — 143 tests
npm run studio:test   # application suite — 2222 tests
npm run verify:all    # both, plus studio typecheck and production build
cd studio && npm run eval:local   # the local lane vs the real model — a score, not a pass/fail
cd studio && npm run eval:conversation   # the voice lane over whole conversations — a score
```

Landmines worth knowing: `ELECTRON_RUN_AS_NODE=1` may be set in the shell — use
`env -u ELECTRON_RUN_AS_NODE` for anything that spawns electron or imports
server modules — including `open -a`, which propagates the calling shell's
environment, so the packaged app exits instantly as a bare Node process. To
reproduce a Finder launch faithfully, also pin the launchd PATH:
`env -u ELECTRON_RUN_AS_NODE PATH=/usr/bin:/bin:/usr/sbin:/sbin open -a ...`.
A gateway is often already on `:4310`; use
`FRONTIER_GATEWAY_PORT=4319` for tests. `npm run assistant:doctor` (a `studio/`
script — it does not exist at the root) exits 1 until
macOS Accessibility is granted — that is expected, not a regression.
