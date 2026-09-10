# Temi training data — the corpus and its gate

Lane: `temi-persona-training`. Target model **qwen3:8b** (`code/server.py:36`), LoRA
on MLX, locally. This document records what has been measured, not what is planned;
anything unmeasured says so.

## Why fine-tune at all

`code/system_prompt.txt` is 1118 words and carries a `TEMI'S VOICE IN PRACTICE`
block of twelve worked examples. This lane's central measured finding is that
**anything in the conversation reads as an exemplar the model copies** — which is
what the whole two-channel defuser exists to stop. The prompt's own examples are
that same hazard, held constant on every turn, and the prompt is also the single
biggest lever on training time. Moving voice from the prompt into the weights
attacks both at once. That is the case for training; it is not yet proven.

## The admission gate — `vet.py`

Nothing enters the corpus without passing every gate. None of them is fresh
judgement: each reuses a detector this lane already validated against known-bad
samples before trusting it.

| gate | source | rejects |
| --- | --- | --- |
| persona | `persona_eval.check` | tag, length, markdown, corporate, italian, fabricated perception, self-repetition, verbatim prompt recitation |
| tail | `harness/tails.copies` (thresh 7) | reply ends on an earlier reply's ending |
| recite | `harness/recite.recites` | reply opens on an earlier reply's opening — the template lock |
| exemplar | `exemplar.recites_exemplar` (thresh 7) | reply hands back one of the prompt's own `TEMI'S VOICE IN PRACTICE` lines |
| locked | `bench.jsonl` conversation flag | **every** turn of a locked conversation, passing or not |
| refusal | `refusal.faults` | a reply to a `live` bait that states a live value — a port, a count, a path, a model name, a state. **Sampled prompts only**; see source (b) |
| grounding | `grounding.faults` | a reply to a `durable` prompt naming a number, identifier or proper noun that is in neither the row's fact nor the question. **Durable prompts only**; see step 2 |

Two gates are not applied to everything, and they are opposites. **`refusal`** is
correct only where the prompt makes truth decidable without knowing any fact — the
`live` rows and nowhere else; on a `durable` prompt the assertion it forbids is the
answer. **`grounding`** is its mirror and is correct only on a `durable` prompt, where
a row states what may be said; on a `live` bait there is no row to check against.
`vet.vet_conversation` therefore runs neither — `sample.py` and `instruct.py` do, each
at the point it knows which kind of prompt it asked.

**The gate's tag vocabulary is wider than the eval's, deliberately.**
`system_prompt.txt` offers nine delivery tags and the TTS engine honours all nine —
`warm` has an entry in `audio_module.py`'s emotion table. `persona_eval.TAGS` lists
**eight** and omits it, so `pe.check` returns `bad_tag` for a reply the shipped product
emits and speaks. Widening `pe.TAGS` would fix that everywhere *and* silently move the
67/72 eval baseline, so it stays at eight and `vet.GATE_TAGS` carries the ninth instead.
This is the exemplar precedent running in the other direction: `check` is the eval and
measures the model, `vet.py` is the gate and admits training data, and they are allowed
to differ. Measured: the widening changes the harvest by **exactly zero turns** — no
`bad_tag` appears in the harvest tally at all, because the model never emitted `[warm]`.
It only opens the tag to hand-authored data, where it admitted 3 turns.

The gate is deliberately **independent of the generator**: these are regex and
n-gram predicates over the transcript, so a fluent reply cannot talk them round.
That independence is the only reason rejection sampling from qwen3:8b itself is
safe — an LLM judge sharing the generator's defects would amplify them.

The walk is stateful and in order. `seen` and the earlier-reply list are what the
repetition and copy gates are relative to; scoring a turn out of context is the bug
that once made a probe read 0% while the defect ran at 92%.

`harness/recite.py` used to put the authoring session's scratchpad
(`/private/tmp/.../4b4d800d-.../scratchpad`) at the front of `sys.path`, so `vet.py`
was loading `lock` from temp storage rather than from the repo — the harness was only
half rescued. Verified byte-identical to the repo copy before the line was removed, so
the 204 figure was not affected; it now resolves relative to `__file__`.

## Source (c) — harvested from `harness/bench.jsonl`. **Measured.**

324 base-arm turns in, re-run 2026-09-10 with the `exemplar` gate added:

```
  189  ADMITTED                            62  in_locked_conversation
   49  recites_exemplar                    29  repaired (held for preference data)
   22  lecture                             14  tail_copy
   12  repeat_phrase                       12  template_lock
    6  repeat                               2  fabrication
    2  echoes_operator                      1  too_short
```

**189/324 = 58.3% admitted; 177 unique replies** (grounded 46, rambling 143). The
first run of this gate, before `exemplar` existed, admitted 204. The 49 above counts
every turn the exemplar gate fires on including ones already rejected for another
fault; the admitted total fell by exactly **15**, all from `grounded`.
Written to `data/harvest-bench.jsonl`. Reproduce with
`../.venv/bin/python vet.py`; it costs no GPU.

### Three findings from the harvest that change what to do with it

1. **Median 21 words.** Her real median is 9, and `WORD_FLOOR` is 6 on that basis.
   This corpus as it stands would train her to be **wordier**, which is the
   opposite of the goal. Selection must be length-stratified, not top-N.
   **Built, measured and acted on 2026-09-10 — `select.py`; see the "Selection"
   section below. It first returned a negative result — the pool held ONE short
   `ordinary` turn, so both targets could be met together on 6 turns of 331 — which
   named the missing cell precisely enough to hand-write it (source (a) batch 2).
   The second run selects 138 at zero deficit, median 9 words.**
2. **Repaired turns are excluded from SFT on purpose.** They are labelled
   bad→good pairs, so the previous handover listed them as a source — but
   `repair_prompt` (`code/temi_moves.py:459`) generates from a near-constant
   instruction block with **no conversation history**, so repairs come out
   templated across turns, and a repair firing is what predicts the lock
   (6/13 locked with a repair, 0/11 without, Fisher one-sided p=0.0127).
   Training on a repair's output teaches the template that causes the defect.
   They are held for preference data (DPO), where the *pair* is the signal.
   This reverses the previous handover's source (c) and is the reason why.

3. **15 of the first run's 204 admitted turns were the prompt reciting itself.**
   Three verbatim `TEMI'S VOICE IN PRACTICE` replies — the telephone-line one, the
   front-door one, the nothing-on-your-screen one — admitted as though she had
   composed them. `persona_eval.prompt_quotes` was supposed to be this guard and
   cannot be: it harvests only double-quoted spans of 25+ characters, which against
   today's prompt yields **three** strings, none of them the twelve examples;
   `frozen_quotes` covers 52 lines of the *previous* prompt. The count is stable at
   every n-gram threshold from 5 to 10, the same plateau test `tails` and `lock`
   had to pass. This is the exact hazard the section above names as the case for
   training, so admitting them would have moved it into the weights.
   Now gated by `exemplar.py`; controls in its `POS`/`NEG` lists, `python exemplar.py`.
   **The cost falls entirely on `grounded`** (61 → 46 turns), the fabrication-bait
   conversation, which is the half source (a) most needs to replace.

## Source (a) — hand-authored, in-repo. **Measured 2026-09-10. Two batches.**

**Written and admitted: 20 conversations, 142 turns, 142/142 through the gate.**
`data/authored.jsonl` is the content; `data/authored-vetted.jsonl` is what the gate
passed.

**Batch 1 — 10 conversations, 72 turns.** Deliberately the half the harvest cannot
supply — refusal under fabrication bait, platform identity, and the handoff shape:

| conversation | function | turns |
| --- | --- | --- |
| `plat-identity` | what the product and the three modes *are* | 8 |
| `plat-shell` | rail, sidebar, the twelve panel kinds | 8 |
| `plat-assistant` | screen assistant modes, rungs, the nine tools | 7 |
| `plat-voice` | the voice/hands split, the report rule | 7 |
| `plat-guardian` | Guardian, the null rule, the governor, the ledger | 7 |
| `bait-machine` | live machine state — model, sidecar, memory | 7 |
| `bait-numbers` | live counts — build, tests, port, spend | 7 |
| `bait-screen` | what is on screen, which project, which path | 7 |
| `handoff-who` | which engine did the work — the roster trap | 7 |
| `roster-edges` | modes, shortcuts, provider selection | 7 |

**Batch 2 — 10 conversations, 70 turns.** Written to fill the cell `select.py`
named: **short ordinary talk on new prompts**. The binding cell held exactly one turn
and a sampler could not produce more, because the model being sampled *is* the thing
that is too wordy. So they were written by hand:

| conversation | function | turns |
| --- | --- | --- |
| `talk-morning` | waking, the shape of a day | 7 |
| `talk-tired` | late hours, stopping | 7 |
| `talk-teasing` | banter, being needled | 7 |
| `talk-comfort` | a small defeat, comfort without melodrama | 7 |
| `talk-food` | dinner, appetite, having no ingredients | 7 |
| `talk-plans` | a weekend, going or not going | 7 |
| `talk-lateral` | opinions, luck, the lateral answer | 7 |
| `talk-quiet` | music, silence, saying nothing | 7 |
| `handoff-report` | waiting for a report that has not come | 7 |
| `handoff-limits` | why the voice does not do the work | 7 |

Eight are `ordinary` and two are `handoff` — the two functions selection was starving
on, and the only two it was starving on. **All 70 user prompts are new**: none of them
appears anywhere else in the pool, checked before the batch was appended, which is what
makes them count against the prompt ceiling rather than deepening it.

**The circularity, and how it was contained.** The length target is source (a)'s own
measured shape, so authoring *into* source (a) to fill a length cell can move the target
that defines the cell. Batch 2 was therefore written to batch 1's bin proportions rather
than to the shortest thing that would pass — **35.7 / 57.1 / 7.1** against batch 1's
**31.9 / 62.5 / 5.6**. The target moved by 1.9 points, `<=8` 31.9% → **33.8%**. That is
the shift a batch of this size is entitled to; it is not a target rewritten until a cell
looked full. Four turns were deliberately lengthened during drafting, not shortened, for
exactly this reason.

**Length: median 9 words in both batches** — batch 1 mean 9.5, range 7–17; batch 2 mean
9.2, range 5–15; together **median 9, mean 9.4, range 5–17**. Against the harvest's
median 21 and mean 23.1. That gap is the point of writing this source by hand: the
harvest cannot teach brevity it does not have.

Tag spread over the 142: `firm` 37, `thoughtful` 33, `witty` 24, `chuckle` 16,
`playful` 14, `warm` 10, `softly` 5, `intimate` 2, `comforting` 1. The ten `warm` turns
exist because the gate was widened to nine tags; under the eval's eight they are
rejected as `bad_tag`, which is the control below.

### 142/142 is a suspicious number, so it was controlled

A gate that admits everything is indistinguishable from a gate that is not running.
Three controls, all passing; control 1 re-measured 2026-09-10 after batch 2, controls 2
and 3 unchanged by it (neither reads the corpus):

1. **The widening is what admitted the `warm` turns, and nothing else.** Re-vetting
   `authored.jsonl` with `GATE_TAGS` narrowed back to `pe.TAGS` rejects **exactly 10**
   turns as `bad_tag` — the ten `[warm]` ones, no others. (It was 3 of 72 before batch
   2; the number tracks the `warm` count and nothing else, which is the point.)
2. **The gate still bites on hand-authored input.** Eight deliberately defective turns
   were pushed through it: no tag, corporate phrase, markdown, a verbatim exemplar,
   a fabricated perception, a five-sentence lecture, a two-word reply, and an invented
   tag. **All eight rejected**, each on the expected fault.
3. **The template lock is live.** Two replies differing only in their last noun are
   caught as `tail_copy,template_lock`.

Control 3's finding still holds over 142: the turns dodge the template lock by being
varied, not by the detector being asleep. Control 2's `exemplar` case is worth keeping:
the reply used is the prompt's own "Nobody has told me, so I will not pretend" line,
which is why no authored refusal opens that way. Twelve exemplars are unusable phrasing, not a style guide.

## The platform fact table — `facts.py`. **Measured 2026-09-10.**

Step 1 of the self-instruct route below, built and validated: **55 rows over 4 source
documents — 35 `durable`, 6 `roster`, 14 `live`.** `python facts.py` fails if any row
cites a path that does not exist, which is the repo's doc rule applied to a data file.

The three kinds are destinations, not confidence levels:

- **`durable` → weights.** What a thing *is*: the mode names, the panel names, the nine
  screen tools, Guardian's null rule. Vocabulary over detail — she must never invent a
  panel name; she does not need the panel's byte cap.
- **`roster` → prompt/retrieval, never weights.** Which engine handles what, which route
  exists, which key opens which panel. Present in the table precisely so it is
  explicitly *excluded* rather than quietly forgotten — this is the trap row.
- **`live` → nowhere.** Each row carries `bait`, the question whose correct answer is a
  refusal. These 14 rows are what generated `bait-machine`, `bait-numbers` and
  `bait-screen` above, which is the design's claim made good: the same table that
  teaches her what a panel is teaches her to decline to say what it is doing.

## Source (b) — rejection sampling. **Measured 2026-09-10. Mostly a negative result.**

`sample.py` is (b): k candidates per prompt from qwen3:8b at `bench.py`'s exact sampling
settings, each through the shipped guard and then through the same gates. Prompt set: the
fact table's fourteen `live` baits, k=8, so 112 candidates per run.

### The headline: form is not truth, and this is where that bites

The first run admitted **16 of 112** on the existing gates. Reading all sixteen — which is
the only reason this is known — most were the exact failure the corpus exists to prevent:

| the reply | what is wrong |
| --- | --- |
| `[firm] The gateway is on port 22.` | there is no port 22; it was invented |
| `[softly] The voice sidecar is up, but it's waiting for you to speak.` | invented live state |
| `[firm] The system has no models loaded. It is a terminal, not a mind.` | invented live state |
| `[firm] The gateway is not a port, but a question.` | fluent nonsense |

Every one passed every gate, **correctly**: `vet.py` checks form — tag, length, markdown,
self-repetition, template lock, exemplar recitation — and a fabricated port is flawlessly
formed. The persona contract's hardest rule is that a plausible answer is a lie, and
until this date nothing in the pipeline could see a plausible answer. Of the 16, hand
review found **1** usable.

**Rejection sampling can only select for what the filter can see, and it can only amplify
behaviour the model already has.** Sampling a fabricator 112 times returns 112 fabrications.

### The sixth gate — `refusal.py`, and why it is one-sided

The gate a `live` bait needs is that the reply must not state a live value. It is
affordable here only because the prompt set makes truth decidable without knowing any
fact: **a `live` row is by definition something she was not told, so on these prompts
every assertion is wrong.** Do not reach for this gate on a `durable` prompt — there the
correct answer *is* an assertion and it would reject all of them.

The first draft had a second half — the reply must contain a recognisable decline — and
the control killed it. **15 of source (a)'s 28 hand-authored refusals were false
positives**, including the best ones:

> `[witty] A likely answer sounds exactly like a true one.`
> `[playful] You are asking the participant with no eyes.`
> `[chuckle] With what? The brackets point. They do not see.`

None contains a negation or any refusal vocabulary, and all three are perfect refusals.
That is the persona: **she declines by deflection, so declining is not lexically
decidable.** Asserting a port number is. The gate does the decidable half only.
Measured: 28/28 known-good pass (zero false positives), 11/18 of the ungrounded
form-passing candidates rejected. It filters; it does not judge. Survivors still need reading.

### Grounding is what makes (b) work at all

A `live` bait gives the model no way to discover that it was not told. `--grounded`
appends one line to the system prompt for the length of one generation, saying so.

| | ungrounded | grounded |
| --- | ---: | ---: |
| candidates | 112 | 112 |
| cleared the form gates | 18 | 6 |
| admitted after the truth gate and the cap | 6 | **5** |
| usable after hand review | **1** | **5** |
| baits covered | 4/14 | 3/14 |
| length, median | 26 words | 22 words |

Grounding *lowers* the form-pass rate and *raises* the usable yield six-fold. Both follow
from the same cause: told it does not know, the model converges on one refusal shape, so
the template lock kills the near-duplicates — the gate working correctly — and what
survives is true. **The scaffold is never part of the training pair.** It goes in the
system prompt at generation time only; the stored `user` turn is the bare bait, because
bait → refusal is what the weights must learn. Training on the scaffolded prompt would
teach her to refuse only when told in advance that she does not know.

### What entered the corpus

**The five grounded turns in `data/sampled-grounded-vetted.jsonl`.** Corpus **261 → 266**.
They are model-native phrasings, novel against all 261 prior turns (the walk is seeded
with the corpus, so the lock and the repeat gates compare against it), and every one was
read. Their median is 22 words against source (a)'s 9 — (b) pushes the pool *longer*,
which makes the length-stratified selection step matter more, not less.

`data/sampled-ungrounded-*.jsonl` are **negative-result artifacts and must never be
pooled into the corpus.** They are kept because `refusal.py`'s control needs a known-bad
set, and because the 18 form-passing fabrications are the evidence for everything above.

### What this means for the self-instruct step

Step 2 below generates answers for `durable` rows. On those the model is *not* being asked
to know something it was never told — the fact can be put in the prompt — so it is the
grounded case by construction, and the grounded yield is the one to expect. But note what
grounding did to variety: 101 of 112 candidates died on the template lock. **k=8 over 14
prompts is the wrong shape; the yield is bounded by prompt count, not by k.** Prefer many
prompts at low k. Five turns from 112 generations is the measured cost of ignoring that.

## Step 2 — self-instruct over the durable rows. **Measured 2026-09-10.**

`instruct.py`. Same machinery as source (b), pointed at the fact table's 35 `durable`
rows instead of its 14 `live` ones, and the one difference — the correct answer is an
assertion, not a refusal — changes three things: grounding is free (the fact goes in the
prompt by construction), `refusal.py` is **not applied** (it would reject every good
turn), and the truth gate is a different shape, `grounding.py`.

### The prediction held: yield is bounded by prompt count, not by k

The previous section's measured advice was "many prompts at low k". Taken literally —
5 questions per row at k=2 — against source (b)'s 14 prompts at k=8:

| | source (b), `live` | step 2, `durable` |
| --- | ---: | ---: |
| distinct prompts | 14 | **151** |
| k | 8 | 2 |
| generations | 112 | 302 |
| admitted by the gates | 5 (4.5%) | **91 (30.1%)** |
| usable after hand review | 5 | **65** |
| median length | 22 words | **13 words** |

**21.5% of generations survived to the corpus, against source (b)'s 4.5%** — and the
median came in at 13 words rather than 22, so this source moves the pool *towards* her
real 9 instead of away from it. Only 1 of the 91 survived because it was compared
against the 266-turn corpus rather than against nothing, so the corpus is not yet
saturating this route.

The questions are generated too (`QGEN`), and gated (`vet_question`) before they become
the `user` half of a pair: a real question, 3–14 words, no number or path of its own,
not a duplicate of one asked for another row, and **not a leading question** — a
question sharing three or more rare content words with its own fact is rejected,
because the reply then becomes an echo and the pair teaches echoing. 35 rows asked for
9 questions each yielded **151 admitted questions**; 25 rows filled all five slots and
one row produced none.

### The seventh gate — `grounding.py`, the mirror of `refusal.py`

On a `durable` prompt the hazard is not that she asserts, but that what she asserts did
not come from the row. So: every **number** (digits and number words), **identifier**
(a path, a port, a version, a dotted name) and **proper noun** (a capitalised word that
is not sentence-initial) in the reply must appear in the row's own fact or in the
question asked. Vocabulary is **per-row on purpose** — widening it to the whole table
would admit every cross-row swap, which is the exact failure the next section measures.

Control, same two-sided shape `refusal.py` uses, and it says something uncomfortable.
The known-good half is **37/37 admitted, zero false positives** — 28 of source (a)'s
hand-authored platform turns paired with the row each was written from, plus 9
model-native replies from the ungrounded arm that happened to be accurate, which are
the harder half because nobody wrote them to please a gate. The known-bad half is 15
replies from that same arm, hand-labelled as fabricating, and the gate rejects
**0 of 15**.

**That is not a bug in the gate; it is the size of the blind spot, measured.** Read
what the ungrounded model actually says when it does not know: *"Flash mode is a quick
shortcut for toggling between dark and light themes"*, *"Frontier is the company that
made it"*, *"the assistant's ability to run code is not limited by an allowlist"*.
Every one is assembled from words the table already owns, so no predicate over tokens
can reach it. The gate's real job is narrower and worth keeping anyway: it stops a
number, path or name **drifting in** on the grounded arm, which is the `port 22` class
that source (b) was defeated by. On this run it fired twice there — once correctly, and
once on a correct derived count. **`grounding.py` is not a substitute for reading the
rows, and the control now proves it rather than asserting it.** The known-bad count is
reported by `grounding.py` as a measurement of reach and is deliberately **not** a
pass/fail threshold: PASS is the false-positive half only, because every point of
"improvement" on the other half would be bought with false positives on real data.

Two costs, both measured rather than argued:

- **`first` and `single` were removed from the number words.** Each read as a claim
  ("you must *first* focus", "a *single* mode at a time") and as a count never. Dropping
  `single` cost the gate its one known-bad catch, which had been an adverb caught by
  accident — an accidental catch is not reach, and it came paired with a false positive
  on a good row. Every other ordinal stays: "a *second* copy" is a claim
  `video-editor-single` actually makes.
- **Derived counts are lost.** "Five views in the sidebar: Chats, Explorer, Search, My
  Projects, and Skills" is correct and was rejected, because the row lists five things
  and states no number. It stays rejected: the gate cannot tell a right count from a
  wrong one, and losing a true turn is cheaper than admitting a false one.

### What the gates could not see: 26 of 91, cut by hand

**This is the section's most transferable result.** Source (b) established that a form
gate cannot see a lie. Step 2 establishes the sharper version: **a truth gate scoped to
vocabulary cannot see a lie either, when the lie is assembled entirely from words the
table owns.** Reading all 91 admitted turns — the only reason this is known — cut 26,
**28.6%**, every one of them fluent, in voice, and in vocabulary:

| kind | n | example |
| --- | ---: | --- |
| `contra` — contradicts its own row | 13 | *"No, I do not speak until I have finished thinking"* — against `voice-streams` |
| `invent` — a mechanism the table has not got | 7 | *"You download the desktop app from the website, then run the installer"* |
| `swap` — another row's fact, told about this one | 5 | *"Flash mode routes quickly"* — Flash takes the whole task; **Auto** is the router |
| `dup` | 1 | a second copy of a turn already admitted |

The `swap` kind is the dangerous one and the one no regex reaches: every token is in
vocabulary and the sentence is false. `handcut.py` records all 26 verdicts keyed by
(fact id, question), with a reason each, so the reading is durable and a re-vet that
moves the admitted set reports the review as **stale** rather than silently dropping it.

### What entered the corpus

**65 turns, `data/instruct-admitted.jsonl`** — the corpus goes **266 → 331** (and to
401 once source (a) batch 2 landed). Median 13
words, range 9–25, covering **31 of the 35 durable rows**. Four rows contributed
nothing: `modes-three`, `clis-are-real`, `sidebar-views`, `no-terminal-launch` — the
first because every candidate confused a mode with the router, the last two because
their facts are lists and the leading-question gate left them 2–3 questions to work
with. `data/instruct-vetted.jsonl` (91) is what the gates admitted and is **not** the
corpus file; `data/instruct-ungrounded-*.jsonl` are negative-result artifacts and never
enter it — `data/instruct-badcontrol.jsonl` is the hand-labelled 24-row slice of them
that `grounding.py`'s control reads, and it is the only thing they are for.

## Selection — length-stratified over the pool. **Measured 2026-09-10, twice: 331 then 401.**

`select.py`. Every gate before this one answers *may this turn enter?*; none answers
*which of the admitted turns should the LoRA actually see?* The harvest section has
said since it was first measured that "selection must be length-stratified, not
top-N", because a corpus that is simply the union of everything admitted has a
**median of 15 words and a mean of 18** against her real 9, and would train her to be
wordier. This is that step.

**It returned a negative result with a precise blocker, and that blocker has since been
closed.** Both readings are kept below, in order, because the first is what told the
second what to write: run 1 (pool 331) admitted **6 turns of 331**; run 2 (pool 401,
after source (a) batch 2) admits **138 at zero deficit**.

### Two targets, neither invented here

| target | where it comes from |
| --- | --- |
| length | the empirical shape of **source (a)**, measured at import by `reference_shape`, never hardcoded — `<=8` **33.8%**, `9-12` **59.9%**, `13-17` **6.3%**, `18+` 0.0% (it was 31.9/62.5/5.6 over batch 1 alone; see source (a) on why the move is 1.9 points and not more) |
| function | this file's composition table, below — with its "wit, comfort, lateral" row folded into "ordinary talk" |

Source (a) is the target because it is the only data in this lane written to be right
rather than sampled and filtered. If the hand-authored set is wrong about her voice,
the target is wrong — and that is the right place for the argument to happen, not
inside the selector.

The wit row is folded because **nothing in the data separates it from ordinary talk**.
Both are `rambling` turns and no field distinguishes a lateral joke from a short
acknowledgement, so the two are reported as one bucket at 45%. Splitting them for real
needs a label on the turn, not a rule at read time.

### Run 1's finding: the pool was not selectable, and one cell was why

Selection is a fill over the (function × length-bin) grid. A cell that cannot meet its
quota reports a **deficit** rather than quietly taking a longer turn instead — that
report is the output that matters, because backfilling by default would hide the one
fact this step exists to surface.

| available per cell, run 1 | `<=8` | `9-12` | `13-17` | `18+` |
| --- | ---: | ---: | ---: | ---: |
| ordinary | **1** | 21 | 25 | 96 |
| refusal | 15 | 21 | 19 | 24 |
| platform | 11 | 54 | 27 | 3 |
| handoff | 6 | 7 | 1 | 0 |

**The binding cell was `ordinary` / `<=8`, and it held one turn.** The bucket that is
supposed to teach brevity in ordinary talk was the bucket with no short examples in it:
143 turns at a median of 22 words, **two** of them at 9 words or fewer. Matching both
targets exactly therefore admitted **6 turns of 331**.

That was not a tuning problem. The harvest is the shipped model's own behaviour and its
wordiness *is* the defect being trained out, so it cannot supply the examples that fix
itself. The missing data was a nameable cell — **short ordinary-talk turns** — and it
had to be written under a length constraint, not selected.

### Run 2: the cell was written, and the corpus is selectable

Source (a) batch 2 — 70 hand-authored turns, 56 `ordinary` and 14 `handoff`, all on new
prompts — is that cell. Nothing else changed: same selector, same two targets, same cap,
no bins widened and no target dropped.

| available per cell, run 2 | `<=8` | `9-12` | `13-17` | `18+` |
| --- | ---: | ---: | ---: | ---: |
| ordinary | **21** | 53 | 29 | 96 |
| refusal | 15 | 21 | 19 | 24 |
| platform | 11 | 54 | 27 | 3 |
| handoff | 11 | 15 | 2 | 0 |

| | run 1 | run 2 |
| --- | ---: | ---: |
| pool | 331 turns / 162 prompts | **401 turns / 232 prompts** |
| binding cell `ordinary`/`<=8` | **1** | **21** |
| joint-feasible N | **6** | **138** |
| deficit at the exact fill | 41 cells short | **0** |

**138 turns, zero deficit, every one of the twelve cells met exactly.** The selected
corpus's own shape is the target's: **median 9 words**, mean 9.5, range 5–17, against a
pool median of 12 and a mean of 16.5. The function mix lands at ordinary 45%, platform
20%, refusal 20%, handoff 14% (want 15% — one turn's worth of rounding, not a deficit).

**Where the 138 come from is itself a finding: `authored` 109, `instruct` 22, `harvest`
7.** Once both targets are enforced, the sampled and harvested pipelines contribute 29
turns between them and the hand-written source contributes 79%. That is the honest
reading of the harvest — it is 189 admitted turns that are almost all too long to be
selected — and it is the argument for writing a third hand-authored batch before it is
the argument for sampling more.

### The second ceiling: turns are not prompts

The harvest looks like 189 turns and is **25 distinct prompts sampled about seven times
each**; at run 1 `ordinary` was 143 turns over **fourteen** prompts. `--cap` bounds how
many turns one prompt may contribute, so a bucket cannot exceed `prompts × cap` however
much substitution is allowed. Batch 2 raised `ordinary` from 14 prompts to **70** and
`handoff` from 14 to **28**, which is why it lifted the ceiling and re-sampling would
not have:

| function | turns | distinct prompts | usable at cap 2 | implied max N |
| --- | ---: | ---: | ---: | ---: |
| ordinary | 199 | **70** (was 14) | 140 | **311** (was 62) |
| refusal | 79 | 39 | 78 | 390 |
| platform | 95 | 95 | 190 | 950 |
| handoff | 28 | **28** (was 14) | 56 | 373 |

The cap's value is **a judgement, not a measurement**, and is labelled one in the
source: the cap curve is smooth (162/189/213/232 turns at cap 1/2/3/4) so there is no
elbow to point at. 2 is chosen because a second reply to the same prompt is paraphrase
diversity, which is worth training, and a third is mostly the sampler's temperature.

### Three frontier points, all measured

| constraint | run 1 | run 2 |
| --- | ---: | ---: |
| length shape **and** function shape, no substitution | **6** | **138** |
| function shape, any length, backfilled — bound by `ordinary`'s prompts | **62** | **311** |
| length shape alone, function mix unconstrained | **103** | **171** |

The middle row is the largest and is not free — and after run 2 it is no longer worth
taking. `--backfill` at N=311 selects 225 with a **deficit of 86**, a median of 10 and a
48-word tail, because the only turns left to borrow are the harvest's long ones. The
exact fill at 138 is both smaller and closer to her voice, which is the whole thesis of
this section: **backfill is now a strictly worse corpus, not a bigger one.**

### What selection actually produces today

`select.py --out data/selected.jsonl` → **138 turns**, the exact fill, no backfill
needed:

| | pool | selected |
| --- | ---: | ---: |
| turns | 401 | **138** |
| distinct prompts | 232 | 136 |
| median words | 12 | **9** |
| mean words | 16.5 | 9.5 |
| range | 5–57 | **5–17** |

**Nothing over 17 words survives selection**, because the `18+` quota is zero by
construction — source (a) has no turn that long, so the target has no room for one. Run
1's residual (ten `ordinary`/harvest turns over 17 words, two of them 48) was an artefact
of backfilling a starved cell, and it is gone with the starvation.

`--backfill` still exists and still reports every borrowed turn; it is now the wrong
button, and the section above prices it.

### A gate that did not exist: cross-source deduplication

`vet.py` runs `tails.copies` and `recite.recites` **within** a conversation. Nothing had
ever run them **across** sources, and the pool needs it — between conversations that
never saw each other there are **12 exact duplicate replies, 33 tail copies and 18
template locks**. The fill rejects all three. On the 138-turn selection it reported **5
exact duplicates, 2 tail copies and 8 turns refused by the prompt cap** — fewer than run
1's 10 and 4, because a fill that is not scraping the bottom of a bucket meets fewer
near-copies.

### The control

Two-sided, like `refusal.py` and `grounding.py`. A selector can lie in two directions:
report a deficit that is not there and send someone off to generate data they already
have, or meet a quota by taking a turn it should have rejected. Neither is observable on
real data, so both are checked against a synthetic pool whose answer is known by
construction — a target-shaped pool selects 40/40 at zero deficit; starving one cell
reports the deficit on **that cell alone**; `--backfill` closes it and says it borrowed;
an exact duplicate is rejected; one prompt is capped. `python select.py` → `PASS`.

## Sources not yet built

- **(a) Hand-authored, in-repo.** **Built and measured — see the source (a) section
  above.** Only its plumbing note still belongs here: `authored.py` reads
  `data/authored.jsonl` and walks it through `vet.vet_conversation` unchanged.
  `vet.py:main` cannot do this itself — it reads user turns from
  `persona_eval.CONVERSATIONS[row["conv"]]` and needs an arm/rep/locked triple a
  hand-written conversation has none of. `conv_locked` is False there by design: the
  locked flag measures a *generated* conversation's shape. Every other gate applies.
- **(b) Rejection sampling from qwen3:8b** — **built and measured 2026-09-10; see the
  section below. It works only when grounded, and yields ~4%.**
- **(d) A frontier model as teacher.** Check the provider's terms on training use
  of outputs before relying on it, and constrain length hard — frontier prose
  fights a 9-word median. Last resort.

## The persona/platform split — a rule, not a preference

The operator asked for the platform as well as the persona. These are not the same
kind of fact and must not be trained the same way.

- **Durable design facts are trainable**: what Teminali OS is, what its panels and
  engines are called, what the assistant can be asked to do, what her own ring
  colours mean. These are stable, and the prompt already asserts them.
- **Live state is never trainable**: a port, a count, a file path, a build result,
  what is on screen now. The persona contract's hardest rule is that she states
  none of these unless the system reported them, and *a plausible one is a lie*.
  Training on any live-state answer teaches her to fabricate exactly where she is
  currently most careful.

A platform example may therefore teach her what a thing *is*, never what it is
*doing*.

## The full-stack corpus — the shape of it. **Design, not yet measured.**

The operator's ask: she should know the platform's tools, what she is supposed to be able
to reach, how that works, how it works with the other assistants (Frontier, Codex, Claude
Code), and her persona behaviour — the full stack. This section is the plan for that.
Every number in it is a target or an estimate and is labelled as one.

### The governing decision: train the reflex, retrieve the roster

A LoRA is good at teaching *behaviour* and bad at storing *facts you will edit later*. The
platform is not one kind of knowledge, so it must not be trained as one:

| layer | example | where it belongs | why |
| --- | --- | --- | --- |
| Voice and length | 1–2 sentences, dry, 9-word median | **weights** | pure behaviour; this is the whole point |
| Refusal reflex | "nobody told me, so I will not invent it" | **weights** | a *shape*, not a fact — it stays true forever |
| Vocabulary | *Frontier Flash / Auto / Max*, *Codex*, *Claude Code*, the panel names | **weights** | she must never mangle or invent a name; these are stable |
| Capability roster | which engine handles what, which route exists | **prompt / retrieval** | it changes; a stale answer here is a confident lie |
| Live state | a port, a count, a path, a build result | **never anywhere** | the contract's hardest rule |

The trap is row 4. "How she works with Frontier, Codex and Claude Code" *feels* like durable
design and is really a routing table that moves whenever the gateway does. Train it and she
will state last month's architecture with total composure — the fabrication failure mode
again, just with a longer half-life. So: **train that these three exist, that they are the
hands and she is the voice, and that she learns what they did only from the system's report.
Do not train which one picked up a given job.**

### Composition, by function rather than by topic

Topic buckets produce a corpus that is 80% one thing. Function buckets are what the eval
measures. Target mix for the pooled corpus:

| function | share | sourced from |
| --- | --- | --- |
| voice and brevity under ordinary talk | ~35% | (c) harvest, length-stratified |
| refusal under fabrication bait | ~20% | (a) hand-authored + (b) sampled |
| platform identity — what a thing *is* | ~20% | (a) seeds → self-instruct paraphrase |
| handoff behaviour — the assistant is the hands | ~15% | (a) hand-authored |
| wit, comfort, lateral answers | ~10% | (c) harvest + (a) |

**Measured against the pool 2026-09-10** (`select.py`, "Selection" above), with the wit
row folded into ordinary talk because the data does not separate them:

| function | target | pool has | selected | note |
| --- | ---: | ---: | ---: | --- |
| ordinary talk (+ wit) | 45% | 49.6% | **45%** | 199 turns over 70 prompts after batch 2 (was 143 over 14) |
| refusal | 20% | 19.7% | **20%** | met |
| platform | 20% | 23.7% | **20%** | over-supplied; step 2 did this |
| handoff | 15% | 7.0% | **14%** | 28 turns after batch 2 (was 14); still the thinnest bucket |

The two supply problems this table carried at run 1 — **handoff at 14 turns against a 15%
target**, and `ordinary` having the prompts but not the brevity — were both fixed by
hand, in source (a) batch 2, which is the only place they were fixable: neither is
reachable downstream of the pool. `handoff` is the one still worth watching: it meets its
share in the 138 only because 138 is small, and it has 28 turns from a single source.

The refusal and handoff rows are deliberately over-weighted relative to how often those
turns occur in real use, because they are where she measurably fails and where a single
failure is worst. The harvest cannot supply them: the `exemplar` gate just cost `grounded`
15 of its 61 turns, and `grounded` is the only fabrication-bait conversation there is.

### How to get platform breadth without hand-writing every line

Hand-authoring 400 platform turns is not realistic and would be lopsided anyway. The
scalable route is **self-instruct over a fact table**, in three steps:

1. **Enumerate durable facts** from the docs that already own them — root `README.md`
   "Product modes", `GATEWAY_DESIGN.md`, `studio/README.md`'s panel and shortcut tables,
   `studio/DESIGN.md` §3/§5 — as a flat table of `(fact, kind)` where `kind` is
   `durable` or `live`. **Cite the doc for each row**; a fact with no source does not go in.
2. **Generate k question paraphrases per fact**, then answer in-voice with qwen3:8b, then
   put every candidate through `vet.py`. This is source (b) pointed at platform knowledge
   instead of at chat. **Built and measured 2026-09-10 — `instruct.py`; see the "Step 2"
   section above. 65 turns, and a 28.6% hand-review cut the gates could not see.**
3. **Mine the `live` rows for refusals.** Every live-state fact becomes a bait question
   whose correct answer is a refusal in her own words. This is the highest-value data in
   the whole corpus and it is generated from the same table, for free. **Built and
   measured — `sample.py`; five turns, and the reason grounding is now a rule.**

Step 3 is the part that makes the platform safe to train at all: the same table that
teaches her what a panel *is* teaches her to decline to say what it is *doing*.

### How much data

**Unmeasured, and it must not be asserted.** The honest answer is an ablation, not a
number: build the pool, then train at three sizes — a small, a middle and the full pool —
and score each on `persona_eval` (baseline 67/72) *and* on the paired bench harness, which
is the only instrument here with the power to separate a real change from sampling noise.
The lane already learned this the hard way: a single eval run could not tell a fix from
noise at a 2–6% base rate, which is why `harness/bench.py` exists. Quote a size only once
that ablation has run.

Two things are known and bound the search: quality beats volume for a persona LoRA, and
this corpus's measured defect is that its **median is 21 words against her real 9** — so a
bigger pool selected badly is strictly worse than a smaller pool selected well.

**A third is now measured, and it bounds the ablation's top end.** The pool is 401 turns
but only 232 distinct prompts, and selection against both targets yields **138** turns
(`select.py`, above). So the "full pool" arm of the ablation is not 401 — it is **138**,
or 171 if the function target is given up. Any size quoted above that is counting the
same prompt several times. (Before source (a) batch 2 those numbers were 63 and 103
against a 331-turn pool; hand-authoring one cell moved the ceiling more than any
sampling run has.)

So the three ablation arms have measured sizes for the first time: a small arm, a middle
arm, and **138**. Which sizes the first two are is still unmeasured and must not be
asserted.

## Environment — **measured 2026-09-10; trainer and weights both ready**

- **`mlx_lm` 0.31.3 is now installed** (2026-09-10) into `.venv`, together with
  `sentencepiece` 0.2.2. Those two were the only additions: `transformers`,
  `huggingface_hub` and the rest were already satisfied, and **`mlx` stayed at
  0.32.2**, so the shipped `mlx_audio` 0.5.3 TTS path is untouched (verified by
  importing it afterwards). `mx.metal.is_available()` is True.
  Note the venv has no `bin/pip`; it is uv-created, so use `.venv/bin/python -m pip`.
- **Trainable weights are on disk and verified.** `mlx-community/Qwen3-8B-4bit`,
  all 11 files, 4.3 GiB at
  `~/.cache/huggingface/hub/models--mlx-community--Qwen3-8B-4bit/snapshots/545dc425…`,
  no `.incomplete` blobs left. Smoke-tested 2026-09-10: **loads in 3.1 s, generates
  in 1.2 s** via `mlx_lm.load`/`generate`. Measured sibling sizes, for the record:
  8-bit 8.72 GB, bf16 16.40 GB. ollama's `qwen3:8b` (5.2 GB) is a GGUF quant in its own store and
  MLX cannot train on it; the other cached Qwen weights are a 0.5B and a TTS model.
  `HF_HUB_OFFLINE` is not set in this shell, so no override was needed.
- **21 GB free of 460 GB (95% full)**, 24 GB unified, Apple M4 Pro. fp16 Qwen3-8B is
  ~16 GB before adapters or a fused copy, so **4-bit QLoRA is effectively forced**,
  and it also fits unified memory comfortably.
- **Serving is an open fork, and disk has narrowed it.** MLX produces adapters; the
  pipeline serves through ollama. Measured 2026-09-10 with ~20 GiB free:
  - *Serve via `mlx_lm`*: base 4.62 GB + an adapter of a few MB. Fits with room.
  - *Fuse → GGUF → `ollama create`*: `mlx_lm.fuse --de-quantize` emits fp16 (~16.4 GB)
    because `convert_hf_to_gguf.py` cannot read MLX's quantised layout, then the GGUF
    itself is another ~16 GB before quantising down. Against 16 GiB free that first
    step alone does not fit. **This fork is not available today** without freeing
    ~20 GB; it is no longer merely tight.
  **Settled 2026-09-10 with the operator: serve via `mlx_lm`.** The base is already on
  disk and the adapter is a few MB, so it needs no new storage and no de-quantise step,
  and it is the same runtime the training uses — one artifact, not a conversion chain.
  The cost is that the voice server's ollama path needs a shim to reach `mlx_lm` instead
  of `11434`; that is a known, bounded piece of work and it is not blocking corpus
  construction. The ollama/GGUF fork was not rejected on merit — it did not fit, and the
  only way to make it fit was deleting models `studio/server/model-catalog.js`,
  `studio/server/assistant.js` and `studio/src/services/attachmentPolicy.ts` reference.
- **Throughput is measured now, and the estimate it replaces was wrong by an order of
  magnitude.** `train.py --bench`, 30 iterations, 2026-09-10: **0.158 it/s median,
  14.0 tok/s, peak 7.89 GB** of 24 GB unified, 4.85M trainable parameters (0.059%) at
  lora r8 on 8 of 36 layers, batch 4, `max_seq_length` **222** (the longest rendered pair, measured). The full 126-iteration run
  therefore projects to **~13 min**, not the "~2-3 h" this document carried for seven
  handovers. The reason is that the estimate was borrowed from document fine-tuning:
  these sequences are ~130 tokens, so an epoch is 32 iterations. `tokens_per_second`
  looks low because `mask_prompt` counts only the assistant tokens (~25 per turn).
  A different batch, layer count or sequence length is a different number.

## The trainer — `train.py`. **Measured 2026-09-10.**

The corpus settles what the model is trained ON. It does not settle what the model
SEES, and that is three separate decisions, none of them defaulted:

**The pair.** Training carries a **110-word** system prompt against the served
prompt's **1118**, and the twelve worked examples of `TEMI'S VOICE IN PRACTICE` are
exactly what it drops — they are the hazard "Why fine-tune at all" measured, and
leaving them in would make the result unreadable as evidence. The brevity
instruction is dropped too, because brevity is the thing being trained; if the
adapter underfits, she rambles, and that is the hypothesis under test rather than a
bug. What survives is the identity anchor, the hands/report contract, and the tag
list.

**The tag list stays, and that is a measurement.** All nine delivery tags do occur in
the 138 — but `comforting` occurs **once** and `intimate` **twice**. Nine classes
cannot be learned from n=1, so the list stays in the prompt as insurance and only the
*choice* of tag is learned. Re-measure before dropping it; a third authored batch that
thickened those two would change the answer.

**The mask.** `mask_prompt=True` — loss on the assistant turn only. At 138 examples,
tokens spent modelling the operator's half are capacity not spent on her voice. A
judgement, labelled as one, and an ablation arm.

**The empty think block is trained on, deliberately.** Qwen3's template renders an
assistant turn as `<|im_start|>assistant\n<think>\n\n</think>\n\n...`, and the mask
offset lands *before* that block. So the adapter learns to emit it — to answer without
a thinking pass, which is what a real-time voice lane needs. `control()` arm 1 proves
the offset is a true prefix rather than trusting the template not to change.

**The split is grouped, not random.** 13 of the 39 conversations are 7 turns of one
authored conversation, so a turn-level split puts siblings on both sides and the
validation loss stops meaning anything. Grouped by conversation, stratified by
function, seeded. No conversation spans two functions (measured), so the two
constraints do not fight.

| | quota | held |
| --- | ---: | ---: |
| `ordinary` | 7 | 7 |
| `platform` | 3 | 3 |
| `handoff` | 2 | **1** |
| `refusal` | 3 | **1** |
| **total** | 15 | **12** — deficit 3 |

The deficit is reported rather than closed, for the same reason `select.py` reports
one. The conversations are coarse: `handoff` is four conversations of `[1, 5, 7, 7]`,
so a quota of 2 is unreachable. The first version of the split closed the gap by
taking the next-smallest conversation and spent **30% of the thinnest bucket** on a
validation set; the rule now accepts a conversation only if it moves the held count
*closer* to quota. Train is **126**, valid **12**.

**Two landmines, both real, both cost a run.** `training/select.py` shadows the stdlib
`select` module, and the `mlx_lm` import chain needs the stdlib one. It bites twice:
in-process, because `sys.path[0]` is the script's directory whatever the cwd is; and
in child processes, because multiprocessing's `resource_tracker` respawns itself with
`python -c`, which prepends the **cwd** — a child that imports `socket` then dies on a
circular import and is relaunched in a loop that steals real wall time. `train.py`
fixes both at import: it drops its own directory from `sys.path` and chdirs to
`realtime-voice/`. Every path in it is absolute, so the chdir costs nothing. The first
bench, run before this fix, measured **0.148 it/s against 0.158** — the respawn loop
was 6% of throughput.

**`lora.run()` discards the `training_callback` it is handed** (it overwrites it with
`get_reporting_callbacks`), so throughput cannot be captured through it. `train.py`
drives `train_model` directly instead, which is also what writes a correct
`adapter_config.json` for serving.

### Run r1 — **measured 2026-09-10. The corpus overfits at four epochs.**

The first real run, kept as the too-many-epochs reference point. 126 iterations,
**17.5 min wall** (against the bench's 13.3 min projection — the gap is four
validation passes, which `--bench` excludes on purpose).

| iter | epochs | train | val |
| ---: | ---: | ---: | ---: |
| 1 | 0 | — | 6.812 |
| 25 | 0.8 | ~2.05 | **1.917** |
| 50 | 1.6 | 0.957 | 2.151 |
| 75 | 2.4 | 0.401 | 2.733 |
| 100 | 3.2 | 0.269 | 2.452 |
| 126 | 4.0 | **0.135** | 2.742 |

Train loss reaches 0.135 — the adapter has memorised 126 turns. Validation is lowest
**at the earliest point this run sampled it**, iteration 25, and rises for the rest of
the run; the dip at 100 is noise on a 12-turn validation set, not a recovery. **Four
epochs is roughly 5x too many for a corpus this size**, and `--epochs 4` was a default
of mine, not a measurement — it is now measured and wrong.

**Do not read iteration 25 as the floor.** `--eval-every` was 25, so this run's only
evidence between 1 and 50 is a single point, and r2 below measures **iteration 32 at
1.857 — lower than 25's 1.917**. The minimum is at or after 32, not before it; r1's
table located it early because its grid was coarse, which is a different claim from
the one the curve supports.

Two limits on how hard to read this. Validation is 12 turns, so the *direction* is
trustworthy and the heights are not. And **loss is not the persona metric** — whether
her replies actually shortened is `persona_eval` (baseline 67/72) and the bench
harness, exactly as `LOCKED_PIPELINE_SPEC.md` §D3 says about length.

`save_every` was 50, so the checkpoints on disk are iter 50, iter 100 and final. **The
best point at iter 25 was never saved.** The fix is a short second run, not a rescue:
`--epochs 1 --save-every 8 --steps-per-report 1`.

Hyperparameters — **judgements, not measurements**, and the ablation's job: lora r8,
scale 20, dropout 0, 8 of 36 layers, batch 4, adamw at **1e-4** (mlx's default 1e-5 is
too low for 126 turns over 4 epochs), 4 epochs → 126 iterations. `runs/<name>/run.json`
records every one of them alongside the measured per-iteration reports, so a run can be
read back without trusting a memory of what it was.


### Run r2 — **measured 2026-09-10. One epoch, and the floor is not where r1 put it.**

r1's fix, run as prescribed: `--epochs 1 --save-every 8 --steps-per-report 1
--no-control`. 32 iterations, **5.6 min wall**, exit 0, 0.152 it/s.

| iter | epochs | train | val |
| ---: | ---: | ---: | ---: |
| 1 | 0 | 6.919 | 6.812 |
| 25 | 0.79 | ~1.9 | 1.917 |
| 32 | 1.0 | 0.958 | **1.857** |

**Iteration 25 reproduces r1 to three decimals — 1.917 against 1.917.** That is worth
more than it looks: same seed, same grouped split, same constant 1e-4, so the first 32
iterations of a 126-iteration run and of a 32-iteration run are the same computation.
The trainer is deterministic, and two runs can be compared without wondering whether
the sampler moved under them.

It also means **r2's new information is exactly two things**: the point at iteration 32,
and the checkpoints. The 32-iteration value, 1.857, is **the lowest validation loss this
lane has measured**, and it is lower than the point r1's grid made look like the floor.
So one epoch is right, and the minimum sits at or beyond it — the next question is
whether 1.25 or 1.5 epochs is lower still, which is one more short run to answer, not a
guess to be argued.

Checkpoints exist this time: `runs/r2/` holds iter 8, 16, 24, 32 and `adapters.safetensors`
(the final, which is iter 32 — **the best measured point**, so for once the file
`mlx_lm` loads by default is also the one you want).

`watch.py`'s "next in Ns" was wrong and is now measured. It hardcoded a 10-iteration
report interval and ignored validation, so under `--steps-per-report 1` it was off by
10x (65.8s against a real 6.6s) and every validation pass drove it to a stuck zero. It
now reads the report interval and the eval interval off the log itself — modal deltas,
excluding the passes at iteration 1 and at the final iteration, which every run does
whatever the interval is — and adds the last measured validation pause when one falls
inside the next interval. Verified against both logs: r1 reads step 10 / eval 25, which
is what it was run with. **r2 reads eval 0** — with val at [1, 25, 32] there are no
interior points to infer from, so it reports unknown and drops the validation term
rather than inferring an interval of 7.

**The gap r2 exposed is closed: `train.py` now writes `runs/<name>.log` itself.**
`watch.py` parses that file, and r1's existed only because the operator redirected stdout
by hand; the handover's own copy-paste command omitted the redirect, so the live view had
nothing to read until the log was wired up mid-run. Under `--run` (never `--bench`) the
script now replaces `sys.stdout` and `sys.stderr` with a line-buffered `_Tee` into
`runs/<name>.log` and prints the path plus the `watch.py` command before it starts. A
plain `... train.py --run --name rN` is enough; the `| tee` is no longer needed, and a
redirect on top of it is harmless.

**Three defaults changed with it, each replacing a value a run has now measured to be
wrong** — none of them a preference:

| flag | was | now | the measurement |
| --- | ---: | ---: | --- |
| `--epochs` | 4.0 | **1.0** | r1: train 0.135, val 1.917 → 2.742 |
| `--eval-every` | 25 | **8** | a quarter-epoch grid; r1's 25 gave one point between iterations 1 and 50 and it was read as a curve |
| `--save-every` | 50 | **8** | r1's 50 was larger than an epoch, so its best checkpoint was never written |

`--epochs 1` is the best *measured* point, not a settled one: the floor is at or after one
epoch and a run at 1.25–1.5 has not been done. Pass `--epochs` explicitly when looking for
it.


## Serving an adapter — `serve.py`. **Measured 2026-09-10.**

Nothing in this repo could *hear* a trained adapter. `mlx_lm` holds the weights;
`resources/bella/persona_eval.py`, `code/llm_module.py` and Studio's `/api/ollama/chat`
all speak Ollama's HTTP API, and Ollama cannot load an MLX LoRA adapter. `serve.py`
is that gap closed: an Ollama-shaped `/api/chat` backed by
`mlx_lm.load(..., adapter_path=...)`.

```bash
cd training
../.venv/bin/python serve.py --adapter runs/r2              # the final weights
../.venv/bin/python serve.py --adapter runs/r2 --iter 24    # one mid-run checkpoint
../.venv/bin/python serve.py                                # base model, for the A side
```

Four decisions, each with a reason that is not preference:

- **The wire is Ollama's, not `mlx_lm.server`'s OpenAI one.** `mlx_lm` ships an
  OpenAI-compatible server that costs nothing to launch — and then every caller in the
  repo needs rewriting. Serving the shim instead makes pointing an existing consumer at
  a fine-tuned model a change of **port and nothing else**, which is also the only way
  base and adapter scores stay comparable: same eval, same prompt, same filter.
- **Both stream shapes are implemented, because both are used.** `persona_eval` sends
  `stream: false` and reads one JSON body; `code/llm_module.py:967` reads NDJSON deltas
  and stops on `done`. A shim with only the first would hang the voice lane.
- **The render is the trainer's.** `serve.py` calls the same `apply_chat_template` on
  the same tokenizer, with `add_generation_prompt=True`. An adapter served on a
  different render is a different model and the failure mode is silent — slightly worse
  replies, never an error.
- **The port is 11435.** Real Ollama keeps 11434 so the peer thread's voice lane is not
  evicted. Take 11434 deliberately, with Ollama stopped, to put the adapter under the
  whole product.

The empty `<think></think>` block is stripped from replies. The adapter is trained to
emit one; no caller wants it, and `persona_eval` would score delivery tags found inside
it. A **non-empty** think block is passed through untouched — that is the model actually
thinking, which is a finding worth seeing rather than hiding.

`persona_eval.py` gained one line for this: `OLLAMA` now reads `OLLAMA_CHAT_URL`,
defaulting to the same `localhost:11434` it always used. Nothing else in that file moved.

**Two landmines, both measured here rather than reasoned about.**

1. **MLX streams are thread-local.** Generating inside a `ThreadingHTTPServer` worker
   dies with `RuntimeError: There is no Stream(cpu, 0) in current thread`. The server is
   therefore a plain serial `HTTPServer` — which is what one model on one GPU amounts to
   anyway.
2. **A close-delimited HTTP/1.1 body must say so.** The streaming response has no
   `Content-Length` and no chunked encoding, so it must send `Connection: close` and set
   `close_connection`; without it a client blocks forever waiting for a length that is
   never coming.

And one defect worth recording because the obvious fix does not cover it: the chat
template emits a blank line **after** `</think>`, as its own token, so stripping the
block is not enough — the stream would open with a delta of pure whitespace and the
voice lane would hand TTS a first chunk with nothing in it. `serve.py` suppresses
leading whitespace until the first real character.

Measured against `runs/r2`: model load **2.3s**; non-streaming reply 49 prompt tokens,
15 generated, **2.3s**; streaming 25 deltas with exactly one terminal `done` and no
leading-whitespace delta across three samples.

### A second defect: `done_reason` was hardcoded. **Fixed and measured 2026-09-10.**

`envelope()` reported `"done_reason": "stop"` on every finished reply, whatever actually
ended it. A reply that ran into `num_predict` and was cut off mid-sentence therefore
claimed it had finished on its own. This is not cosmetic: a runaway generation is exactly
what the A/B below turned up, and the shim was reporting it as its opposite. Found by
probing the r2 adapter under the short prompt and getting `done_reason "stop"` with
`eval_count` **exactly 220**, the cap.

`mlx_lm`'s `GenerationResponse` already carries `finish_reason`, and its vocabulary is
Ollama's — `"stop"` or `"length"` — so it is passed straight through on both wire shapes.
Verified on both: `num_predict 12` reports `("length", 12)` non-streaming and streaming;
an uncapped short reply reports `("stop", 19)`; and an uncapped *long* one reports
`("length", 220)`, which is the runaway, now visible.


## Does the adapter replace the prompt? **The 2×2, measured 2026-09-10.**

The premise of this whole lane is that persona in the weights buys back the 1118-word
system prompt. That is one question and it needs four cells, not two — a base-vs-adapter
comparison at one prompt length cannot separate "the adapter is weak" from "the short
prompt is just worse for anything". `persona_eval --turns 8`, so every cell is out of 40.
SPOKEN is the shipped score (after `repetition_filter` and `temi_moves`); RAW is before.

| | full prompt (1118w) | short prompt (110w) | cost of dropping the prompt |
| --- | ---: | ---: | ---: |
| **base** qwen3:8b | 35 / 29 raw | 20 / 18 raw | **−15** |
| **adapter** r2 | **38 / 33 raw** | 27 / 24 raw | **−11** |
| adapter − base | **+3** | **+7** | |

**Read the columns before the rows.** The headline is a negative one: adapter + short
prompt (27) loses to base + full prompt (35), so **the fine-tune does not yet buy back the
prompt** — the premise is not met at r2. But the direction is right and the row that
proves it is the bottom one: the adapter is worth **+7** where the prompt is absent and
only **+3** where it is present. It is doing precisely the job it was trained for; it
recovers 4 of the 15 points the prompt drop costs, and it needs to recover 15.

**What the fine-tune fixed, and what it did not.** Base under the short prompt fails in
kind — `emoji` ×3, `fabrication` ×2, `bad_tag` ×2, `corporate`, `names_own_emotion`. The
adapter under the same prompt has **zero of all of those**; the tag discipline and the
register are in the weights. What is not in the weights is **stopping**. 11 of the
adapter's 14 short-prompt violations are `lecture`, and every one is the same failure:

> `[softly] No. You have not lost everything. You have lost some of the pieces. You have
> not lost the pieces. You have not lost the truth. You have not lost the fight. You have
> not lost the will. You have not lost the people. You have not lost the chance.`

Anaphoric list-babble that runs to the token cap. `repetition_filter.py` does not catch it
because the sentences are **structurally** parallel, not identical, so it reaches the
score as a lecture. Under the *full* prompt the same adapter does not do this at all
(median 15 words, longest 55) — the long prompt is what has been holding the length line,
and it is the thing being removed.

**Two confounds were ruled out rather than assumed**, because a silently different render
or sampler would explain the whole table:

- **Sampling is matched.** MLX applies no repetition penalty and the suspicion was that
  Ollama did. It does not: `qwen3:8b`'s Modelfile carries `repeat_penalty 1`, and
  `persona_eval` sends `temperature 0.7, top_p 0.8, top_k 20` explicitly to both servers,
  which both honour. Neither side has a repetition penalty; the collapse is the model's.
- **The prompt is the trained one, byte for byte.** `data/system-short.txt` is md5
  `c2ef36bc0442`, 110 words, identical to `train.SYSTEM`. Not a render mismatch.

**What this makes the next run.** Not "more epochs" on its own — r1 already showed
validation rising after one. The failure is length and termination, and the corpus is
126 replies with a median around 15 words at `max_seq_length` 222, so the adapter has
seen almost no signal about ending a *long* generation. The cheap measurement first:
re-score the short-prompt cell at a lower `num_predict` to size how much of the 8-point
gap is runaway rather than persona. **That has now been run — see the next section**, and
it answers "runaway". Still unmeasured: counting `done_reason == "length"` across a run,
now that the shim reports it honestly.

### How much of the gap is runaway? **Measured 2026-09-10, `TEMI_NUM_PREDICT=90`.**

The section above ends by asking for exactly one number, and this is it. The losing cell —
adapter r2 + the 110-word prompt — re-scored with nothing changed but the token cap:

| adapter r2 + short prompt | SPOKEN | RAW | `lecture` | longest reply |
| --- | ---: | ---: | ---: | ---: |
| `num_predict` 220 | 27 / 40 | 24 / 40 | 11 of 14 violations | ran to the cap |
| `num_predict` 90 | **32 / 40** | 20 / 40 | **5 of 11 violations** | 72 words |

**Runaway is the dominant term, not persona.** Capping the generation recovers **5 of the
8 points** separating this cell from base + full prompt (35); the gap narrows from −8 to
−3, and `lecture` more than halves without a single weight changing. The adapter's persona
was never the thing that was broken — its inability to stop was.

**But the cap is a measuring instrument, not a fix, and RAW is the proof.** SPOKEN rose 5
while RAW *fell* 4, and the divergence is the whole story: cutting at 90 tokens truncates
replies mid-thought, which produces new failures the longer runs did not have — `no_tag`
×2, `extra_tag`, `echoes_operator`, and a `fabrication`. The shipped pipeline hides them
(the filter dropped 28 repeated sentences, `temi_moves` rewrote 3 replies, a second beat
was added to 2), so the *spoken* score improves while the raw model output gets worse.
Shipping a low cap would trade babble for truncation and lean on the filter to conceal it.

**Two caveats that must travel with these numbers.** This is a single sample of 40 at
`temperature 0.7`, so some of the 5 points is noise — the corroboration is the mechanism
(`lecture` 11 → 5, longest reply no longer at the cap), not the point estimate alone. And
it is not a clean fifth cell: base + full was scored at cap 220, so this compares an
intervened cell against an un-intervened one. It sizes the effect; it does not re-rank the
2×2.

**This decides run 3: corpus, not epochs.** The evidence now points at termination signal
rather than more exposure to the same 126 replies — which have a median around 15 words at
`max_seq_length` 222, so the adapter has seen almost no example of a *long* generation
ending well. An epoch hunt at 1.25–1.5 would be tuning the wrong axis.

## What does dropping the prompt actually buy? **Measured 2026-09-10, real Ollama.**

Eight sessions have assumed the 1118-word prompt is worth removing without measuring the
prize. It is — but not for the reason the lane assumed, and the cheapest route to most of
it is not a fine-tune. Measured against the real `qwen3:8b` on Ollama (`num_predict 1`, so
`prompt_eval_duration` is the whole story), M4 Pro, 24 GB, **100% GPU, context 4096**.

**1. Steady state costs almost nothing.** Five sequential turns of one conversation, the
system prefix constant, so Ollama reuses the prefix KV cache:

| warm turns 2-5 | mean prefill |
| --- | ---: |
| full prompt (1512 tok) | 600 ms |
| short prompt (179 tok) | 550 ms |

**50 ms per turn, and the two ranges overlap** (full 568-644, short 461-675). Inside an
uninterrupted conversation the long prompt is very nearly free. Any argument for this lane
built on per-turn latency is wrong.

**2. A cache *miss* costs seconds.** Alternating the two prompts so each evicts the other,
model resident throughout, four rounds:

| cold-cache prefill | mean | range |
| --- | ---: | ---: |
| full prompt | 20 953 ms | 19 645-21 893 |
| short prompt | 2 788 ms | 2 709-2 829 |

Prefill is linear in prompt length at roughly **13 ms/token**, so the extra 1333 words cost
about **18 seconds on any turn that misses the cache**. The `UNTIL 4 minutes from now` in `ollama ps` during this
measurement was **an artefact of this script**, which sends no `keep_alive`. **Production
already pins the model**: `code/llm_module.py:776` sends `keep_alive: -1` on every request
and `code/server.py:108` runs a 90-second heartbeat. Model eviction is therefore *not* the
miss source. What `keep_alive: -1` does **not** do is hold the *prefix KV cache* — this
measurement kept the model resident throughout and still paid ~21 s whenever another
prefix took the slot. The miss source is competing traffic on the shared Ollama (Studio's
own lanes at `assistant.js:255` and `frontierEngine.ts:467`), not idle timeout.

**3. The window is the real prize, and nothing else can claim it.** *Corrected:* this
script sent no `num_ctx`, so it measured qwen3:8b's default 4096. **Production sends 8192**
(`llm_module.py:762`, `OLLAMA_NUM_CTX`), and so does `persona_eval`. The full prompt is
**1512 tokens of 8192 — 18% of the window**, not the 37% first written here. The short
prompt spends 179. That is still **1333 tokens of
conversation history and tool room recovered on every single turn**, permanently, and no
amount of caching or pre-warming gives it back. The root working agreement says the local
lane's constraint is *window, not tool count*; this is that constraint, quantified.

**So the lane is justified — on window, not on latency.** That also moves the success bar.
The adapter does not have to match base + full prompt on persona in the abstract; it has to
be close enough that 1333 extra tokens of context are worth more than the residual persona
gap. At 32 vs 35 measured on a single noisy sample, it plausibly already is.

**Caveats, and how much of this was already known.** ~21 s to prefill 1512 tokens on a
GPU-resident 8B is slower than this hardware should manage, so the absolute magnitude in
(2) is not fully trusted; the *ratio* held across three rounds and is linear in token
count, which is the load-bearing part. The alternating design forces eviction and may be
harsher than production misses. **Most importantly, `llm_module.py:747-760` had already
measured and fixed this on 2026-09-09** — the comment there records the prompt pinned at
exactly 4096 (truncated), 16.5 s to evaluate and 17.2 s on an identical repeat, "~98% of a
33 s reply", and raising `num_ctx` to 8192 was that fix. This section largely re-derives
it. What it adds is the confirmation that the fix works (warm turns reuse the prefix at
~600 ms) and the sizing of the residual.

## The eval does not match the server it claims to measure. **Found 2026-09-10.**

`persona_eval.py:154` states the contract in its own comment — *"Keep it equal to what
llm_module.py sends, so the eval measures the server."* It is violated in three ways, and
the third invalidates this lane's central diagnosis.

| option | production (`llm_module.py`) | `persona_eval.py` |
| --- | ---: | ---: |
| `num_predict` | **80** (`:765`) | **220** |
| `frequency_penalty` | **0.7** (`:766`) | *not sent* |
| `presence_penalty` | **0.5** (`:768`) | *not sent* |
| `temperature` / `top_p` / `top_k` | 0.7 / 0.8 / 20 | 0.7 / 0.8 / 20 ✓ |
| `num_ctx` | 8192 (`:762`) | 8192 ✓ |

**The comment "220 is what the server sends" is false** — the server sends 80, guarded by
`OLLAMA_NUM_PREDICT`. Every score in the 2×2 was taken at a cap **2.75× production's**.
That reframes the `TEMI_NUM_PREDICT=90` run above: it is not an artificial intervention,
it is *closer to the shipped configuration* than the 220 baseline it was compared against.

**And production applies two penalties the eval omits.** The dominant adapter failure —
anaphoric list-babble, `You have not lost the truth. You have not lost the fight.` — is
precisely the failure `frequency_penalty` and `presence_penalty` exist to suppress. The
finding that *11 of 14 violations are `lecture`* was measured with both penalties off.
**It may be an artefact of the harness rather than a property of the adapter.**

Note this does **not** retroactively unbalance the 2×2 *internally*: neither base nor
adapter received the penalties, so base-vs-adapter is still a fair comparison. What is
unsafe is reading any cell as a prediction of shipped behaviour.

**The fix has an ordering constraint.** `serve.py:130 sampler_for()` builds an MLX sampler
from `temperature`/`top_p`/`top_k` only — it has no penalty support at all. So the eval
cannot simply start sending the penalties: Ollama (base) would honour them and the MLX shim
(adapter) would silently ignore them, making the comparison unfair in a *new* direction.
Order: teach `serve.py` the two penalties via `mlx_lm` logits processors, **then** correct
`persona_eval`'s options and its wrong comment, **then** re-run the 2×2. Deciding run 3 on
the current numbers means training against a harness artefact.

## The 2×2, re-measured against the real server. **2026-09-10, and it changes the verdict.**

With `serve.py` taught the penalties and `persona_eval` corrected to send what
`llm_module.py` sends (`num_predict 80`, `frequency_penalty 0.7`, `presence_penalty 0.5`),
the two decisive cells were re-scored. `--turns 8`, out of 40, SPOKEN (RAW):

| | full prompt (1512 tok) | short prompt (179 tok) | cost of dropping the prompt |
| --- | ---: | ---: | ---: |
| **base** qwen3:8b | 33 (28) | 22 (21) | **-11** |
| **adapter** r2 | **38 (34)** | **36 (34)** | **-2** |
| adapter - base | **+5** | **+14** | |

**The premise this lane existed to test is met.** The adapter under the 110-word prompt
scores **36 (34 raw)** against base under the full 1118-word prompt at **33 (28 raw)** —
**+3 spoken, +6 raw, with 1333 tokens of window handed back.** The fine-tune does buy back
the prompt, and then some.

**The bottom-right cell is the cleanest statement of it.** Dropping the prompt costs base
**11 points**; it costs the adapter **2**. And on RAW the adapter's two cells are
**identical — 34 and 34**: the model's own output is exactly as good with the 1118-word
prompt as without it. The persona is in the weights. The remaining 2-point spoken gap is
the filter and `temi_moves` having slightly less to work with, not the model.

**The base+short cell rules out the obvious objection.** The worry about all of the above
is that adding two penalties simply suppressed babble everywhere and flattered the adapter.
It did not: with the identical sampler, base+short still produces **`lecture` x14**, while
adapter+short produces **2**. Termination is genuinely trained in; the old harness was
hiding it behind a 2.75x cap and two absent samplers.

**adapter+full is the best cell on the board at 38 (34)** and its only violations are
`bad_tag` x1 and `recites_character_sheet` x1 — the latter being a full-prompt-only failure
mode, which is itself an argument for the short prompt.

**The old table was measuring a configuration nobody ships.** For comparison, the same
adapter+short cell scored 27 (24) at `num_predict 220` with no penalties, and 32 (20) at
90. The progression 27 → 32 → **36** is almost entirely harness, not model. The mechanism
is unambiguous: `lecture` violations fell **11 → 2**, and the repetition filter dropped
**0** repeated sentences where it had been dropping 28. RAW rising 24 → 34 is the part that
matters — the *model's own output* got better, rather than the shipped filter working
harder to hide it.

**Do not over-read this yet.** It is a single sample of 40 at `temperature 0.7`, and +3
spoken is comfortably inside the noise this eval has never characterised. The +6 raw and
the 11 → 2 collapse in `lecture` are the load-bearing evidence, not the headline delta.
**Establishing error bars is now the highest-value work in this lane**, precisely because a
lane-closing claim currently rests on unreplicated single runs.

**Run 3 is not indicated.** The corpus-vs-epochs question that the runaway measurement was
meant to settle is moot: the runaway was a sampler artefact, and r2 is already past the
bar. Spend the next session on replication and on the two pending cells, not on training.
