# Investigation Doctrine

Why Teminali answers questions about the user's machine by looking at it.

## The failure this fixes

Asked *"can you tell me how much storage my files on downloads folder takes?"*, Frontier Auto replied:

> I'm unable to directly access or interact with your local file system, including the Downloads folder.

…then produced a Windows/macOS tutorial telling the user to right-click and choose Properties.

Nothing was blocking it. `du` was already in `AUTO_COMMANDS`; `du -sh ~/Downloads` classifies as `auto` and would have run with no approval dialog. The engine had the capability, the classifier permitted it, and the model still declined to use it and handed the work back.

The same prompt given to Claude Code returned `2.4G` in one command — and then kept going in ways that turned out to be the actual lesson.

## What Claude Code did that was worth copying

Nine tool calls, 86 seconds. Six behaviors, none of which are about disk usage:

| # | Behavior | What it looked like |
|---|---|---|
| 1 | **Measured instead of declining.** | Ran `du -sh` rather than explaining how to run it. |
| 2 | **Decomposed the aggregate.** | `du -sh */` → sorted → drilled into the two heavy directories until it reached individual files. The total is not an answer; the actionable items are. |
| 3 | **Verified identity before advising a delete.** | Two `FrontierCut-1.12.6` dmgs, one suffixed `(1)` — an obvious duplicate. It ran `md5` first. **Different checksums**, 1,620 bytes apart: two distinct builds. It said explicitly it would have recommended deletion on sight and that the checksum stopped it. |
| 4 | **Disclosed what the number measures.** | `du` reports 2.4 GiB; Finder reports ~2.57 GB. Pre-empted the mismatch instead of letting it read as an error. |
| 5 | **Checked for invisible confounders.** | `.icloud` placeholder stubs (0 — nothing cloud-only under-reporting), symlinks (72, all valid npm shims, so no double-counting), permission errors (0). |
| 6 | **Volunteered adjacent context.** | Noticed the volume was 91% full and said clearing Downloads wouldn't move the needle. |

It also debugged its own shell: its first permission check used `find ... 2>&1 >/dev/null`, which under zsh's `MULTIOS` tees stdout instead of discarding it. It recognized the zsh-vs-bash difference and re-ran.

## The task class

The generalization is not "disk usage" and not even "filesystem". It is:

> **Any question whose true answer lives on the user's machine rather than in the weights — followed by advice about what to do with it.**

Storage was just the first instance to expose the gap. The same six behaviors apply to *what is holding port 3000*, *which dependency bloats the bundle*, *which tests actually fail*, *what version is really installed*, *why is the build slow*. Each one is a measure → decompose → verify → advise loop, and each one fails the same way when the model answers from memory.

## Why this is core, not a skill

Teminali skills (`SKILLS_LIST` in `studioStore.ts`, dispatched in `frontierEngine.ts`) are **domain expertise the user opts into for a task**: Website Builder, QA Verifier, Screenshot-to-Code. One at a time, selected deliberately.

Diligence fails all three tests for that shape:

- **It is not domain-specific.** Verify-before-you-recommend-a-delete applies to files, database tables, git branches, and video timeline clips alike.
- **It cannot be opt-in.** The moment a user has to remember to enable "actually check things first", the default is a confident wrong answer. A safety disposition that ships off by default is decoration.
- **It is not fully expressible as a prompt.** Three of the six behaviors are engine facts, not instructions: whether `md5` is executable at all, how many sequential command rounds the loop permits, and whether `find -exec rm` reaches a human first. No amount of system-prompt text changes those.

That last point is the load-bearing one. Frontier Flash runs a **14B model in an 8k window**. A long list of dispositions in the system prompt is reliably forgotten by the time it is answering, and every line of doctrine displaces a line of the user's actual files. So the doctrine is a short reminder, and each rule is *also* **checked after the fact** and fed back through the correction channel the completeness audit already uses.

The engine header already stated this principle: it "reviews model output". Diligence extends the review from what the model *wrote* to what it *looked at first*.

## Where each flow is enforced

Three layers, because the six behaviors do not all live at the same altitude.

### 1. Doctrine — `DiligenceEngine.wrapSystemPrompt`

Five compact lines appended to the system prompt, wrapping `CompletenessEngine.wrapSystemPrompt`. Deliberately under 1200 characters, and there is a test that keeps it that way. This is the reminder, not the guarantee.

### 2. Capability — `agentCommands.ts`

An investigation is limited by what it is allowed to run. Three families were missing:

- **Forensics** — `md5`, `shasum`, `cksum`, `cmp`, `diff`. Without these, behavior #3 is impossible: the engine cannot establish that two similar things are actually different, which is precisely the step that prevented a bad delete recommendation.
- **System state** — `df`, `ps`, `lsof`, `uname`, `sw_vers`. These are the non-filesystem half of the task class.
- **Path/text shaping** — `basename`, `realpath`, `cut`, `jq`, etc., so a probe can be narrowed without spending another model round-trip.

While adding them, five commands were found that classified as `auto` — running with **no approval dialog** — despite mutating the machine:

| Command | Was | Now |
|---|---|---|
| `find . -type f -exec rm {} +` | `auto` | `confirm` |
| `find . -name x -delete` | `auto` | `confirm` |
| `sed -i '' s/a/b/ file.ts` | `auto` | `confirm` |
| `sort -o out.txt in.txt` | `auto` | `confirm` |
| `node -e "<arbitrary JS>"` | `auto` | `confirm` |

`node -e` was explicitly allowlisted as a read-only subcommand; it evaluates arbitrary JavaScript. The others share one root cause: **allowlist membership describes a binary's usual job, not a promise about every invocation of it.** So the fix is one general rule (`MUTATING_FLAGS`), not five patches.

`find -exec` needed more care than a blanket ban. `-exec rm` deletes, but `-exec stat` is the single most useful way to inspect a large tree — and it is exactly what Claude Code used to find the largest files. So the **payload is classified on its own terms**: the inner binary must itself be allowlisted and carry no mutating flags.

### 3. Loop — `frontierEngine.ts`

Two changes.

**Separate turn budgets.** `MAX_AGENT_COMMAND_TURNS = 3` previously bounded *everything*. But honest investigation is `total → breakdown → drill in → verify` — four sequential rounds before the answer even starts, which is why the model had to guess at step three. Correction turns and investigation turns have different economics: a correction re-emits whole files (expensive at 9 t/s), an investigation emits a few commands and no files. They are now budgeted separately (`MAX_INVESTIGATION_TURNS = 8`), with `MAX_TOTAL_TURNS` as a hard stop.

**A pre-delivery audit.** When the model stops asking for things, the text in hand is what the user will read — the last point at which "you never actually looked" is still correctable. `DiligenceEngine.auditInvestigation` checks it against the full command history for the exchange and, if it finds a gap, returns a brief through the same `observation` channel the completeness audit uses. It asks **once**: a model that will not ground its answer after being told exactly what is missing will not do better on a third pass.

The audit surfaces as a `frontier.review_investigation` tool call, so the user can see the engine checking its own work.

## The rules

| Rule | Fires when |
|---|---|
| `capability-denial` | Answer claims no machine access while a shell exists |
| `ungrounded-answer` | A state question answered with zero commands executed |
| `deflected-to-user` | Answer explains how the user could check it themselves |
| `aggregate-without-breakdown` | A total reported with no decomposing command run |
| `unverified-destructive-advice` | Delete advised on lookalike names, no checksum/diff/stat run |
| `undisclosed-units` | A `du`/`df` size with no GiB-vs-GB disclosure |

Alongside the audit, `frontierEngine.ts` repairs one protocol miss directly. A
model that reaches for ```bash out of habit prints the command, tells the
operator to run it, and ends the turn — observed on "give me a total size of all
the files in my desktop folder", which came back as a shell block and "Please
run this command on your machine to get the result". ```bash stays
non-executable; the engine instead returns a `frontier.correct_protocol` notice
carrying the same command back inside a ```frontier-run fence. The notice also
offers the other reading — that the block was an example to keep — so a genuine
code sample costs one turn and is not forced into being run.

Two patterns were widened after that exchange, both from observed text rather
than imagination: `deflected-to-user` now matches the imperative hand-back
("please run this command on your machine"), which the original "you can run"
phrasing missed entirely, and `MEASUREMENT_INTENT` now matches the instruction
form of a measurement ("give me a total size of…") beside the question form
("how much…").

**The doctrine grants action, not just inspection.** Rule 1 of the injected
prompt used to say the model could run *read-only* commands, which taught it to
refuse anything that changed state — asked to create a folder it handed back
`mkdir` for the operator to run. It now says the model acts through the fence:
read-only commands run on their own, state-changing ones run once the operator
approves them, and a request to do something is done rather than explained.

**A turn ends at the closing fence.** The stream is cut there by
`frontierEngine.ts` (`closedFenceEnd` in `services/agentCommands.ts`). Anything
a model writes after asking to run something is invented — the command has not
run, and may still be sitting at an approval prompt — so it is neither shown to
the operator nor kept in the transcript. Rule 5 states the same contract in
prose, but the cut is what enforces it.

**Every rule requires positive evidence that something was skipped.** A false finding costs a full generation turn on a local model, so the bias is toward silence. Two consequences worth knowing:

- A question needs *both* an intent to measure and something concrete to measure it on. "How many ways could I refactor this" trips the quantifier and is correctly ignored.
- Phrasings that carry their own subject (`is postgres running`, `what version is installed`) bypass the noun requirement — enumerating every program a user might name is a list that is wrong the moment they install something new.
- A command that was parsed but never approved is **not** evidence. Only `executed: true` counts.

## Tests

- `tests/diligence.test.mjs` — each rule firing, each rule staying silent, and the false-positive guards
- `tests/agent-commands.test.mjs` — the forensic allowlist, the five closed holes, and `find -exec stat` still permitted

`npm run verify:core` (typecheck + 277 tests + build) is green.

An independent review pass found five defects in the first implementation — a rule that fired on hosts with no shell, a rule that demanded a breakdown of things that were never aggregated, phrase-matching that missed the doctrine's own headline example, an unrelated `git status` laundering the destructive-advice check, and a dead "not run" feedback branch. All five are fixed, each with a regression test. See [DILIGENCE_TEST_PLAN.md](./DILIGENCE_TEST_PLAN.md).

One existing assertion in `tests/engine-boundary.test.mjs` was relaxed: it pinned the loop condition's exact source text, which broke when the budget conjunct was added. It still asserts the invariant it exists to protect — that `capabilities.runCommand` is the first thing guarding execution — but no longer forbids additional conditions.
