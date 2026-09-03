# P3 — the approval gate for media import

**Status: built in `40544f6`, tested in `tests/media-consent-gate.test.mjs`,
seen running 2026-09-03.**
Written before the port because the gate is the deliberate gap in P2's design
(`README.md` § "The exposed surface is an allowlist"), and because the shape of
the gate decides which tools P3 can afford to expose at all. It remains the
spec: where the build diverged, the divergence is marked **Built:** in place,
with the reason. Two things it describes are still not true, and say so —
`assemble_from_folder` (§ "What goes into `EXPOSED_TOOLS`") and the
project-folder grant (§ 2). The gate has now raised a real prompt in a real
window: an `import_media_from_path` call arriving from an agent CLI over MCP was
held open ~11s until a person answered it, and main's audit log recorded three
decisions in turn — `allowed · prompt`, then `refused · deny-list` for
`~/.ssh/id_rsa` (0.02s, no prompt raised), then `allowed · session-folder` for a
repeat of the granted path (0.02s, no second prompt).

## What P3 actually grants

The Cut's import surface is not "a tool that writes a file". Read the three
candidates against what each one hands to a caller:

| the Cut's tool | what it does | what the caller gains |
|---|---|---|
| `import_media_from_path` | builds `file://<path>`, probes it with a media element, adds a `MediaAsset` | **reads any absolute path** the renderer can open |
| `ffmpeg_process` | `execFile`s ffmpeg on an input path, imports the result | **spawns a subprocess** for up to 15 minutes, and `operation:"custom"` takes a raw filtergraph |
| `assemble_from_folder` | walks a directory (optionally 4 deep) and imports everything | **enumerates a filesystem tree**, then multiplies the import |

So the capabilities to gate are **read**, **enumerate** and **spawn** — not
write. That matters, because it changes what a prompt has to ask about. Nothing
here can destroy the operator's data; what it can do is see it and burn their
CPU.

Two consequences that are easy to miss:

- **The renderer runs `webSecurity: false`** (`electron/main.cjs:141`), so a
  `file://` URL for any path really does load. The Cut relies on the same thing
  and says so. There is no sandbox underneath this gate; the gate is the
  control.
- **The metadata return is a narrow read channel, but `ffmpeg_process` is a
  wide one.** `import_media_from_path` returns duration, dimensions and a
  `decoded` flag — a few bits about a file the caller named. A filtergraph can
  read a file the caller did *not* name (`movie=`, `amovie=`, `subtitles=`,
  `drawtext=textfile=`) and paint its contents into frames, and those frames
  become a pool asset. That is the difference between a read oracle and
  exfiltration, and it is why `custom` is treated separately below.

## Three callers, and they are not one trust level

| caller | how a call arrives | what the operator is doing |
|---|---|---|
| the panel's own UI | a component calls the store; `executeTool` is not involved | clicking the thing |
| the in-renderer chat | `aiService` → `videoToolCalls.ts` → `executeTool` | reading the conversation they just typed into |
| **the agent CLIs** | `videoMcpStdio.cjs` → `:3899/rpc` → IPC → `services/videoToolBridge.ts` | possibly nothing. Possibly in another app |

The third is the one the gate exists for, and two facts about it are
load-bearing:

- **The CLI's own permission model is already spent.** `server/video-mcp.js:158`
  passes `--allowedTools mcp__cut`, which names the *server*, so every tool it
  serves is pre-approved. That is not carelessness — headless `claude -p` has no
  TTY, so without the flag the first tool call is refused and the turn ends
  having done nothing. The flag is correct and it stays. It also means **the CLI
  will never ask.** The gate has to be on this side of the bridge.
- **The panel may not be on screen.** `WorkspacePanel.tsx:85` renders
  `<VideoPane />` only when a `video` panel is open, while
  `registerVideoToolBridge()` runs at module load in `main.tsx:43` precisely so
  the tools work either way. A gate drawn inside the panel would be a gate that
  is absent exactly when it is needed most.

## The design

### 1. The gate is declared on the tool, in the registry

`defineTool` gains one field beside `name` and `category`:

```ts
consent?: readonly ConsentCapability[]   // absent means what the three P2 tools mean: none
```

**Built: a list, not one value.** The table in § "What goes into
`EXPOSED_TOOLS`" demands `read-path` *and* `spawn` for `ffmpeg_process`, which a
single field cannot express. The two are also different scopes — "may you read
this file" is per path, "may you spend fifteen minutes of this machine" is per
session — so they could not have been collapsed into one either.

It lives in `mcp/toolRegistry.ts` for the reason `agentCommands.ts` gives in its
own header — the rule a call is judged by and the code that runs it stay in one
file, so they cannot drift. `isExposed(name)` says whether a caller outside this
renderer may reach a tool; `consent` says what it owes first. The two are
independent, and both are checked in `services/videoToolBridge.ts`.

### 2. Consent attaches to paths, and a human gesture is what grants it

The gate holds a session set of **granted roots**. A call whose resolved path
falls inside one runs without a prompt; anything else raises one.

Roots are granted three ways, all of them a real gesture:

- **The operator picked the file.** A file chosen in the picker or dropped on
  the window grants that file, and grants its containing directory — because
  the folder you took one clip out of is the folder the rest of the shoot is in.
- **The open project folder.** **Not wired.** `grantRoot(path, 'project-root')`
  is implemented and has no caller: nothing in `src/` tracks an open project
  folder — `chooseFolder` is only a type declaration in `WindowControls.tsx`.
  Two of the three grant paths work; this is the third.
- **The operator answered a prompt with "this folder".**

The point of folder scope is that the gate has to survive being used. A
per-file prompt on a forty-clip shoot is forty prompts, and the fortieth is
answered without being read — which is a worse security property than having no
gate, because it manufactures consent and records it as real. One prompt per
shoot converges; one prompt per file does not.

**Session scope only in P3.** No grant is persisted. A grant written to disk is
a decision made once and forgotten, and there is no UI yet in which to review or
revoke one. Persistence is a later change that has to arrive with that UI.

### 3. Two refusals that are never a prompt

A prompt is for questions with two defensible answers. These have one, so the
operator is not asked:

- **The deny list overrides every grant.** `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/Library/Keychains`, the app's own `userData`, and any dotfile or dotdir.
  A granted root means "a folder of footage"; a folder of footage that happens
  to contain a `.env` did not make the `.env` footage. This is the counterpart
  of `BLOCKED_PATTERNS` in `classifyCommand` — a category with a fixed answer.
  It is not extendable by a setting, for the reason the launch catalogue gives:
  an allowlist an operator can be talked into extending mid-session is not an
  allowlist.
- **A non-media extension is refused by the schema, not by a human.** The
  picker already declares the list (`mp4 mov mkv webm mp3 wav aac png jpg jpeg
  webp`, `teminaliCut/electron/main.ts:236`) and the agent path is the *same
  import*, so it is held to the same list. The honest answer to
  `import_media_from_path('/etc/passwd')` is "that is not media", and returning
  it without a prompt means the operator is never shown a question whose only
  correct answer is no.

  **Built: the list is per path argument, not one global media list.**
  `ffmpeg_process`'s `lutPath` is a real read of a real `.cube` sidecar, and a
  media-only rule would refuse it forever — leaving the `lut` operation
  permanently dead. Each `RequestedPath` carries its own `accepts`, and
  `MEDIA_EXTENSIONS` / `LUT_EXTENSIONS` are the two that exist. The rule is
  still the schema's list rather than a human's judgement, which is the point.

Both checks run on the **resolved** path — symlinks followed, `..` collapsed —
and the resolved string is the one shown in the prompt. A gate that validates
one path and opens another is worse than no gate.

### 4. `operation: "custom"` is not exposed over MCP

Ever. A raw ffmpeg filtergraph reaches the filesystem through filters that take
a filename, so it defeats every path check above by construction: the gate sees
the `input` and the filtergraph reads something else. It is the terminal in the
launch catalogue — an escape hatch wearing an allowlist.

The other nine operations are a closed enum (`stabilize interpolate denoise
sharpen deflicker reverse speed lut extract_audio`), and `lutPath` is a path
like any other and gated like one. `custom` stays defined and callable
in-process, which is the split `isExposed` already draws.

One change to make while porting: the Cut types `operation: z.string()` and
validates it in the handler with `oneOf`. The exposed schema should be
`z.enum([...])`, so the manifest tells the model the truth instead of an error
message doing it on the second try.

### 5. Where the gate runs, and the 20-second problem

`registerVideoToolBridge()` runs outside React, so the gate core is
**React-free** — the shape `createApprovalGate` in `agentCommands.ts` already
has, and for the same reason its header gives: the "always settles" invariant is
only testable if no component is required to settle it. The difference is
ownership: the shell gate is created per-hook (`useCommandApproval`), and this
one is a module singleton the bridge owns, which a component subscribes to.

**The prompt is drawn in `App.tsx`'s modal layer** (beside `CursorSettingsModal`
et al., ~line 300), not in `VideoPane`, for the reason in § "Three callers". The
chat can render an inline row as well, the way it does for commands — but the
app-level host is the one that has to exist, and one host means one tested path.

The timeout is a real constraint, not a detail. `electron/videoToolBridge.cjs:47`
sets `DEFAULT_TIMEOUT_MS = 20_000` with `SLOW_TOOLS` empty and a comment saying
P3/P4 will need entries. A human does not read a prompt in 20 seconds.

**Decision (confirmed by the operator, 2026-09-03): the call blocks, with a
bounded deadline.** `SLOW_TOOLS` gains
entries for the gated tools, and the *prompt* carries its own deadline — after
it, the gate settles as a denial that says nobody answered. Blocking is the
honest representation of "a person has to decide": a protocol that lets the
agent proceed while the question is still open is a gate that can be waited out.
The deadline is what stops a blocked call from becoming a wedged CLI. The 20s
figure was chosen for tools that finish in single-digit milliseconds; it was
never a claim about human latency.

The rejected alternative was **refuse-and-arm** — answer the first call
immediately with "waiting on the operator, ask again", raise the prompt, and let
the retry find the grant. It keeps every call inside the existing budget and
never blocks an unattended turn. It was rejected because it makes the agent's
progress independent of the human's answer, which is the property the gate is
supposed to remove. Worth revisiting if blocking turns out to break a CLI in a
way a deadline cannot fix.

Because the app may be in the background while `claude -p` runs, the prompt
should ask for attention through the paths Code already has (dock, the assistant
tray). Without that, the deadline is reached by a prompt nobody saw.

### 6. No UI means deny

If nothing is subscribed to the gate — a dev browser build, the overlay surface,
a headless test — the gate denies immediately rather than waiting out its
deadline. A gate that cannot ask must not grant. One invariant, one test.

### 7. What the prompt says

- **who asked.** `agentName` is already threaded through `executeTool` ("Agent
  CLI over MCP" against the chat's own name). Same words, different weight: a
  call from the sentence you just typed is not a call from a process running
  unattended, and the operator should be able to tell them apart at a glance.
- **the resolved absolute path**, in full, not elided — it is the whole
  question.
- **for `ffmpeg_process`: the operation, and that it can take minutes.**
- **three answers:** allow this file · allow this folder for the session · deny.
  No "always allow" in P3, per § 2.

### 8. Every decision is one audit line

Through `videoRpc.cjs`'s `log`: tool, agent, resolved path, verdict, and *which*
grant satisfied it — `picker`, `project-root`, `session-folder`, `prompt`,
`deny-list`, `not-media`, `no-ui`, `deadline`. The assistant subsystem already
does this for `act`. Without the grant reason, "the agent imported something
odd" has no answer.

**Built: two more, and one rename.** `declined` (the operator said no) and
`superseded` (a second prompt arrived and denied this one) are the two
operator-driven outcomes this list did not enumerate — a denial that cannot tell
"someone said no" from "nobody was there" is not an audit line. `session-spawn`
joins `session-folder` because the two session grants answer different
questions. The full set is `ConsentOutcome` in `services/mediaConsent.ts`.

## What goes into `EXPOSED_TOOLS`, in what order

Adding a name costs tokens on every request that advertises the panel, so the
staging is by cost and by blast radius. Measured from the Cut's registry, not
estimated:

| tool | description | schema `describe` text | consent |
|---|---:|---:|---|
| `list_media_pool` | 74 chars | 0 | none |
| `import_media_from_path` | 173 | 84 | `read-path` |
| `ffmpeg_process` | 610 (incl. the operations list, interpolated twice at 95 chars) | ~511 | `read-path` + `spawn` |
| `assemble_from_folder` | 562 | not measured | `read-path`, recursive |

Against P2's measured baseline — 912 chars of descriptions, 1,798 for the full
manifest — the first three take descriptions to **1,769 chars** and the manifest
to roughly **3,700 (~920 tokens)**, against `TOOL_BUDGET = 15` and the Cut's
15-20k for all 115. Affordable. Dropping `custom` from the description saves
some of it back.

**Decided 2026-09-03: all three land together.** The recommendation was
import-only first, to prove the gate in anger before adding a subprocess; the
operator chose one workstream over two. Taken as their call. What it means in
practice is that P3 lands two *kinds* of grant at once, so the gate core has to
be capability-shaped from the first commit rather than path-shaped and widened
later — there is no intermediate ship where only `read-path` exists.

- **`list_media_pool`.** Read-only, no disk, 74 chars, and it is what makes the
  others usable: the agent needs asset ids. The `file://` urls it returns are
  paths the operator already imported, so it discloses nothing new.
- **`import_media_from_path`,** behind `read-path`.
- **`ffmpeg_process`,** enum minus `custom`, behind `read-path` + `spawn`.
  `spawn` is granted once per session rather than per call: path consent answers
  "may you read this", not "may you spend fifteen minutes of this machine", and
  those are two questions with two different scopes. It also needs its own
  `SLOW_TOOLS` entry on top of the gate deadline — the Cut gives ffmpeg 15
  minutes of `execFile` timeout, and a gate deadline is not a work deadline.
- **Not in P3 — `assemble_from_folder`.** It is the right tool to want and the
  wrong one to ship second: it turns one grant into an unbounded number of reads
  and a directory listing. It goes in after folder-scoped consent has been used
  in anger.

## Three findings that change P3's shape

Found while designing this; each one is work P3 owns that the stated scope did
not name.

- **`dialog:openMedia` appears to be dead code in the Cut.** It is handled in
  `electron/main.ts:232` and exposed in `preload.ts:352`, but the only other
  reference anywhere in `src/` is the type declaration. The Cut's real human
  import is `components/sidebar/MediaPanel.tsx` — an `<input type="file">` and a
  drop target. So porting `dialog:openMedia` would port a channel nobody calls.
- **`File.path` is gone in both Electrons, so the human path needs
  `webUtils.getPathForFile`.** `MediaPanel.tsx:75` reads `(file as any).path`
  and silently falls back to `URL.createObjectURL(file)` — a blob URL, which
  previews but is not a path, so ffmpeg and export cannot use it and it dies on
  reload. Neither install declares `File.path` (Cut on Electron 34.5.8, Code on
  **44.1.0**) and both declare `webUtils.getPathForFile`. **Observed at runtime
  2026-09-03**, no longer read off the typings: it is exposed through
  `electron/preload.cjs:138`, and driven under `electron/main.cjs`'s own
  `webPreferences` a filesystem-backed `File` crossed the context bridge and
  came back as its absolute path. What was exercised is the picker route —
  Code's `src/components/sidebar/MediaPanel.tsx:147`; the drop target at `:177`
  hands the same `bring()` a `FileList` from `dataTransfer` and has **not** been
  driven by a real drag. This is also the gate's own foundation: without a real
  absolute path there is no gesture to grant consent from.
- **No media-pool UI came across in the port.** The 25 ported components are
  inspector, timeline, preview and primitives; `MediaPanel.tsx` is not among
  them, though the store behind it is complete (`mediaPool`, `addMediaAsset`,
  `removeMediaAsset`, `useMediaPool`). So P3 has to build the operator's own
  import surface, and it is not optional garnish — it is where consent comes
  from.

  **Decided 2026-09-03, and it is larger than the question asked:** the import
  surface is not a panel-local `MediaPanel` port. The left sidebar becomes
  **icon-only, and therefore thinner**, and Media joins it as a tab alongside
  the others. The skills surface merges too — one list, IDE/code skills and
  video skills together, rather than two.

  For the gate that is a better answer than the one recommended, for a reason
  worth writing down: a sidebar tab is **always mounted**, where `VideoPane` is
  not. The consent gesture and the app-level prompt host then have the same
  lifetime, and "the operator dropped a file" cannot depend on which workspace
  panel happens to be open.

  It is also a separate workstream. Narrowing the sidebar to glyphs, moving its
  contents into tabs, and merging two skill catalogues is IA work on the shell
  that touches `components/sidebar/`, `PanelGlyph.tsx` and `SkillsModal.tsx` —
  none of which the gate needs in order to be correct. Sequence it first
  (the gate has nowhere to take consent from until Media has a home), but do not
  let it arrive in the same commit as the gate.

## Tests the gate owes

**Built: all ten, as `tests/media-consent-gate.test.mjs`.** 1–7 drive the real
gate under plain Node — it is React-free and takes its path resolution as an
argument, so the real policy runs with a fake filesystem beneath it and a short
deadline. 8–10 are assertions over source in the style of
`tests/video-mcp-bridge.test.mjs`, because `toolRegistry.ts` reaches the
timeline store through extensionless specifiers that plain Node cannot resolve.

1. An ungranted path raises a prompt; the granted path does not.
2. The deny list refuses inside a granted root.
3. A non-media extension is refused with no prompt raised.
4. Resolution: `..`, a symlink out of a granted root, and a relative path.
5. No subscriber ⇒ immediate denial, not a deadline.
6. The prompt deadline settles as a denial, and the call is answered.
7. A second prompt while one is outstanding denies the first rather than
   dropping its resolver — the invariant `createApprovalGate` already holds.
8. `operation: "custom"` is refused over MCP and accepted in-process.
9. `getToolManifest()` does not list a `consent` tool that has no gate wired.
10. `EXPOSED_TOOLS` stays within `TOOL_BUDGET`. **Built wider:** the budget
    alone was already asserted in `tests/video-mcp-bridge.test.mjs`, so this one
    also pins the *gated* subset by name. It is meant to fail when the list
    changes — a new tool that reads a path needs its `consent` declaration and a
    line in the test, and a tool that loses `consent` needs someone to say why.
