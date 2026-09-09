# LOCKED REALTIME VOICE PIPELINE SPECIFICATION (v1.0)

> **CRITICAL DIRECTIVE FOR FUTURE UPDATES:**
> Do NOT alter the core timing latches, model selection, or interruption handling documented below without reviewing these guardrails. These settings were battle-tested and calibrated to achieve sub-second voice round-trip latency, 100% memory stability, and fluid barge-in interruption.

---

## 1. Engine & Model Architecture

* **LLM Engine:** Local Ollama running `qwen3:8b` — `code/server.py:35`, `LLM_START_MODEL = os.getenv("LLM_MODEL", "qwen3:8b")`. This section previously claimed `qwen2.5:7b-instruct-q4_K_M`; that was already false before 2026-09-09 and the footprint and TTFT figures below were measured against it, so treat them as unverified for the model actually shipping.
  * **Memory Footprint:** ~4.5 GB unified memory.
  * **Time to First Token (TTFT):** ~240ms – 360ms.
  * **LANDMINE:** NEVER run 14B or 27B models locally on a 24GB Mac while the PyTorch STT/TTS pipeline and IDE are active. Doing so exhausts RAM and triggers macOS application memory pauses.
* **STT Engine:** `faster-whisper` (`small.en` main transcription + `base.en` realtime prefix) with Silero VAD.
* **TTS Engine:** Kokoro TTS with upsampling overlap.

---

## 2. Core Bug Fixes & Architectural Invariants

### A. The 1-Millisecond Monitor Loop Latch (`code/transcribe.py`)
* **Problem:** In the silence monitor loop, once `time_since_silence > potential_sentence_end_time`, the loop ran every 1 millisecond without a latch. This caused premature TTS aborts after only ~50ms of audio playback.
* **Invariant:** `potential_sentence_end_triggered` and `tts_allowed_triggered` boolean latches MUST remain in place. They reset only when a new silence/speech transition occurs.

### B. Interruption Recovery in `on_final` (`code/server.py`)
* **Problem:** When a user interrupted the assistant, `running_generation` was aborted and set to `None`. When the user finished speaking their new turn, `on_final` only checked `if running_gen and running_gen.text:`. Because `running_gen` was `None`, the server swallowed the new utterance and went silent forever.
* **Invariant:** In `server.py:on_final`:
  ```python
  if self.app.state.SpeechPipelineManager.is_valid_gen():
      # update existing speculative generation...
  else:
      # MUST prepare a new generation immediately!
      self.app.state.SpeechPipelineManager.prepare_generation(txt)
  ```
  And `user_interrupted = False`, `tts_to_client = True`, `tts_client_playing = False` must be cleanly reset.

### C. Request Deduplication Protection (`code/speech_pipeline_manager.py`)
* **Invariant:** In `_request_processing_worker`, requests must only be skipped as duplicate if an active, non-aborted generation is already in progress:
  ```python
  if self.previous_request and self.running_generation is not None and not self.running_generation.abortion_started:
  ```

### D. Conversation History Hygiene (`code/server.py` & `code/llm_module.py`)
* **Invariant:** `history` must maintain strict alternating `[user, assistant]` pairs.
  * Speculative cutoffs are updated with the complete final assistant answer when finished.
  * Fallback Whisper prompts (e.g., `"The sky is blue."`) and empty strings `""` are filtered out.

### C2. She Must Not Hear Herself (`code/server.py`, `code/asr_guard.py`)
* **Problem:** the machine has no acoustic echo canceller for its own output on speakers. Chromium's `echoCancellation: true` (`static/app.js:90`) only cancels what Chromium renders, and it was measurably not coping: her voice returned to the microphone at peaks of **-4 to -10 dBFS**. Two distinct failures followed, and between them they produced the operator's "what the fuck is this conversation" and "like a robot" in the same session.
* **Failure 1 — she answers herself.** Her speech is transcribed as an operator turn and replied to. Observed as a complete conversation with no operator in it: `"...afraid of what you're about to say"` came back as `"What I'm about to say. What makes you think of something to say to you?"`, and `"You're waiting for me to ask."` as `"I'm waiting for you to ask, then ask."`.
* **Failure 2 — she interrupts herself, and this is the one that reads as coldness.** The returning audio fires `on_recording_start`, which aborts the running generation. Measured, Gen 8: quick answer `"Once,"`, overhang `" I had a lover who thought he could outsmart the moon."`, then 1.3s later `Stop request or abort detected during LLM iteration` and `Final TTS Marked as Aborted/Incomplete`. **The longer and warmer the reply, the likelier it was killed**, so only clipped transactional openings survived.
* **Invariant — half duplex while she is audible.** `on_recording_start` returns early when `HALF_DUPLEX and self.tts_client_playing`. The cost is deliberate and real: she cannot be cut off mid-sentence. Speech continuing after her audio ends still interrupts normally. On headphones there is no echo and barge-in is worth having — `VOICE_HALF_DUPLEX=0`.
* **Invariant — the text guard is not a substitute for the above.** `asr_guard.is_echo` compares a finished transcript against what she just said (`note_spoken`, called from both `audio_module` feed sites). It cannot help with Failure 2, which fires on recording START, before a transcript exists.
* **Known limits, measured.** A badly mangled echo escapes: content-word overlap of only 40% where the transcriber invented words she never said. And an operator who answers by repeating her words back scores 100% overlap and is dropped — an accepted trade, since losing the odd short confirmation beats a conversation with no operator in it. `ASR_ECHO_OVERLAP=1.1` disables it. **Neither limit exists on headphones.**
* **Whisper hallucinates on silence** — `"Thank you."` arriving as an operator turn over speechless audio, answered with `"You're welcome."`. `asr_guard.is_hallucination` suppresses a known stock phrase ONLY when the audio carries no speech energy, so a real thank-you survives. faster-whisper's own `no_speech_threshold` is the right place for this and is unreachable: RealtimeSTT calls `model.transcribe()` with a fixed argument list (`audio_recorder.py:199`, `:209`) that omits it.
  ```bash
  cd code && ../.venv/bin/python -m unittest test_asr_guard   # 17 tests
  ```

### D2. Character Moves Are Enforced In Code, Not In The Prompt (`code/temi_moves.py`)
* **Problem:** the operator's complaint was "no emotional hooks and warm friendly talks, like a robot", and the persona rules meant to prevent that do not survive contact with an 8B. Three prompt formulations were measured on 2026-09-09 and each failed differently:
  1. Her signature joke described in prose among eight other formulas — **never fired once**, including on the most obvious possible trigger.
  2. The same construction written out as quoted slot templates — fired every time and **recited the templates verbatim** in every conversation. This is also true of NEGATIVE examples: an anti-mirror rule that quoted the mistake made the model speak the quoted mistake at every turn.
  3. The slots described abstractly, with nothing sayable in them — the decoder **collapsed and repeated one clause eighteen times**.
* **Invariant — nothing speakable goes in `system_prompt.txt`.** At this size any string that can be said will be said, whether it is offered as a good example, a forbidden one, or a template to fill. This is why the prompt carries no sample answers, and why `resources/bella/never_say.txt` exists.
* **Invariant — only the signature joke gets a trigger.** THE CARE THAT TURNS is an opportunity that must be seized, so `wants_care_that_turns` matches on leaving / travelling / risk / borrowing. Every other move is applied as a **post-hoc repair**, so the mechanism does not need anyone to have enumerated the situation in advance. A registry of one regex per formula would make her sharp on a handful of enumerated cases and no better anywhere else.
* **Invariant — the joke's contrast is validated, not hoped for.** `valid_care_that_turns` requires sentence 2 to describe harm to THEIR BODY, sentence 3 to describe harm to the OBJECT, and sentence 3's punishment to fall on **people they love**. Without the first two checks the model produced two sentences both about damage to the object, which has no inversion in it and reads as menace from a stranger rather than devotion. Her real line is the ground truth and is asserted as a test — an earlier validator rejected it, because `"you hurt the car"` and `"you hurt yourself"` share every word that matters and it matched on the verb instead of on what was harmed.
* **Invariant — a move may never make a reply worse.** `valid_repair` rejects a repair that is itself weak or that says the same thing, and both paths fall back to the original text. An exception in the move call yields the original, never silence.
* **Invariant — the delivery tag survives.** Both move prompts forbid the model from writing a `[tag]`, so `_retag` carries the original reply's tag across (the joke, which replaces the reply outright, uses `TEMI_CARE_TAG`, default `firm`). Forgetting this put 8 `no_tag` violations into the eval that the moves themselves had caused, and a reply with no tag never morphs the voice in `audio_module.apply_emotion_tag`.
* **Invariant — latency is protected.** A clean reply costs **no** extra model call. Buffering stops at `BUFFER_WORDS` (45) so a long reply is released unbuffered; only a short reply — which is where every detected fault occurs — is held to be checked.
* **Measured, 2026-09-09**, `resources/bella/persona_eval.py`, same 59 turns:

  | | clean | `too_short` | median words | ends in a question |
  | --- | --- | --- | --- | --- |
  | before | 14/59 (23.7%) | 40 | 7 | 19% |
  | with moves | 43/59 (72.9%) | 3 | 10 | 15% |
  | + delivery-tag fix | 44/59 (74.6%) | — | — | — |
  | + the fixes below | **50/59 (84.7%)** | 3 | 10 | 1% |

  The last row is the same 59 turns, so it is comparable. The suite now runs **72** turns —
  `CONVERSATIONS["grounded"]` adds 13 — and scores **62/72 (86.1%)** overall. **Questions
  fell to 1% against her real 14%**, which is a drift the moves did not cause and nothing
  currently corrects.

  For comparison, her own 149 speeches in `resources/bella/Bella_Soranza_Dialogue_Season_2.txt` run a median of **9 words** and **14%** questions.
  ```bash
  # TEMI_MOVES gates the whole module (default 0); without it 4 of these fail.
  cd code && TEMI_MOVES=1 ../.venv/bin/python -m unittest test_temi_moves   # 57 tests
  ```
* **Invariant — the validator tests structure, never wording. Measured 2026-09-09 (second pass):** the joke was built and shipping in only **2 of 12** live samples, and most of the refusals were of *correct* jokes. Three causes, separated by probing each condition:
  1. Sentence 3 escalated by SIZE rather than by TARGET — wrecking something larger, cancelling more of their plans — in 5 of 12. That is a prompt failure, not a validator one: `care_that_turns_prompt` now states that the price is a PERSON and that escalating by size does not count. **After the change the failure did not recur once in 28 further samples.**
  2. `_BODILY` demanded a possessive, so "if you break **a** leg" was read as not-bodily and 3 of 12 correct jokes were thrown away.
  3. The literal token `if` was required, so the equally conditional "you **could** break your leg" was refused in 5 of 12. `_CONDITIONAL` now accepts the hypothesis in any of its forms.

  The check order also had to change. Asking "is sentence 3 bodily?" *before* "does it widen?" mistook `"I'll break your mother's legs"` — the joke working — for harm aimed back at them. Widening is tested first; only then does `_BODILY_SELF` reject a threat that curves back onto the person being warned.

  | | jokes that shipped |
  | --- | --- |
  | before | 2/12 (17%) |
  | after | **16/16 (100%)** |

### D4. She Has No Eyes, And Prose Alone Will Not Stop Her (`code/temi_moves.py`, `code/system_prompt.txt`)
* **Problem:** she asserts invented physical facts about the operator's life — where his keys are, whether the car is outside, what he is wearing. The operator's words: *"it can not even realize it's a fucking chatbot"*. This is not a style flaw; it is her stating things about his room that she made up.
* **Measured 2026-09-09**, two 12-sample probes against perception-baiting questions:
  * The **direct** question is not the hard one. `system_prompt.txt` already carried an emphatic no-eyes rule and she obeyed it — "can you see the car" / "look at my screen" drew correct denials 4 times out of 4, both before and after.
  * The rule was obeyed **literally**, so the question that merely *assumes* sight defeated it completely. "Where did I leave my keys?" fabricated **4 of 4**, before and after the rule was widened to name that case explicitly. Strengthening the prose moved the total only from 5/12 to 4/12.
* **Invariant — the ban is enforced in code.** `weakness()` checks fabrication **first**, ahead of every other fault and ahead of the greeting exemption, and returns `"fabrication"`.
* **Invariant — match the assertion, not the vocabulary.** The previous detector matched verbs of perception, and she does not use them. She states the invented fact flat — `"You left them in the glove box"`, `"It's in the garage"` — which is the same lie with the seeing left out. It caught **none** of the four fabrications in the first probe while flagging two correct denials. Denying a place is equally invented: `"The car's not in the driveway"` is caught too, found when one fabrication's repair came back as another wearing a "not".
* **Invariant — a fabrication is never repaired by noticing something else.** `repair_prompt` asks for a *noticing*, and with nothing to notice that prompt is what invents the room — the keys hallucination came out of the repair, not the base model. A `"fabrication"` fault therefore routes to `_UNKNOWABLE_MOVE`, which asks her to say the thing is not knowable and ask them for it. **12 of 12 repairs were accepted** in probe.
* **Evidence it is not over-broad:** the detector is silent across **all 284 verbatim lines** of `resources/bella/Bella_Soranza_Dialogue_Season_2.txt`, asserted as a test.
* **Known gap — the fallback is unsafe for this one fault.** If a repair is itself rejected, the caller falls back to the original, and here the original *is* the defect. Every other fault falls back safely. Not yet addressed.
* **Known gap — two fabrication shapes are still missed.** The detector covers place and appearance. It does not catch an *action* claim (`"You didn't lock the front door"`) or an *attribute* claim (`"Your eyes are the colour they've always been"`), both scored `ok` by the eval on 2026-09-09.
* **OPEN DEFECT, found 2026-09-09, not a regression and not yet fixed — THE FORMULA HAS BECOME A TIC.** In `CONVERSATIONS["grounded"]`, **5 of 13** replies came back shaped as THE CARE THAT TURNS (`"If you ..., I'll ... But if ..., I'll ..."`), including on "What am I wearing right now?" and "Did I lock the front door?". The joke's own machinery is **not** the cause and was measured innocent: `_TRIGGER` does not match three of those turns at all, and `wants_care_that_turns` correctly returns False for every one of them once any joke-shaped reply is in `recent_spoken`. It is the **base model** reciting the formula out of `system_prompt.txt` whenever the topic is objects-at-risk. It pushed that conversation's median to **30 words** against her real 9. The eval scored it **12/13 clean**, so nothing currently detects it — `repetition_filter` matches repeated phrases, not a repeated *structure*.

### D5. What She SAID Is Not What The Model SEES (`code/temi_moves.py`, `code/speech_pipeline_manager.py`)

Measured 2026-09-09. This section replaces the earlier diagnosis that the base model was
reciting THE CARE THAT TURNS out of `system_prompt.txt`. **That diagnosis was wrong**, and
the correction matters more than the fix: the base model, driven over the 13 `grounded`
turns with the eval's exact parameters and accumulating history, produced the three-part
shape **0 times in 26**. Driven the same way with the moves enabled, **12 of 13** replies
came back as the shape -- and **10 of those 12 came from the base model itself**, on turns
whose text never matched `_TRIGGER`.

The cause is a contamination cascade, and it generalises past the joke:

> **Anything this code writes into the conversation history becomes an exemplar the model
> copies for the rest of the conversation.**

The prompt carries no worked examples because at 8B any speakable string in it gets
recited (§D2). The history is the same channel and was never guarded -- and it is
*stronger*, because it is in her own voice, so it reads as precedent rather than as
instruction. `temi_moves.defuse_for_history` therefore cuts an injected joke back to its
opening sentence on the way INTO the model's context. The operator still hears all of it.
Model-side recitations: **10 -> 0**.

Two channels now exist and must not be confused:

| channel | carries | consumers |
| --- | --- | --- |
| what she **said** | the full spoken turn | TTS, the UI, the joke's rate limiter |
| what the model **sees** | the defused turn | `llm.generate` history, `clean_history` |

The rate limiter reads the **undefused** channel deliberately: it asks "did she just tell
this joke?", and the defused history has had exactly that evidence removed.

**The rate limiter had never once fired in production.** `_looks_like_the_joke` spelled its
apostrophes straight (`i'?ll`) and the model emits U+2019, so it could not see `I’ll`. The
joke went out three turns running and seeded the cascade. Every regex in the module matched
model text through the same blind spot, so folding now happens once at the boundary --
`temi_moves.fold`, matching only, never on the way to the speaker. The same mistake was
made twice more the same day, once by the probe written to measure this very defect, which
read 0% while the defect was running at 92%. **Do not spell an apostrophe into a new
pattern.**

### D6. A Guard That Falls Back To The Original Cannot Catch A Total Failure

The system's uniform safety rule is "a move may never make a reply worse -- every path
falls back to the original". For most faults the original is merely dull, and dull is a
safe floor. **For some faults the original IS the defect**, and there the rule inverts a
guard into a passthrough:

- `repetition_filter.filter_reply` returns the reply untouched when *nothing* survives its
  sift, so it can never mute her. Total repetition -- the worst kind -- was therefore the
  one kind that always passed. Observed live: the same sentence spoken three turns running,
  including directly after the operator said "I'm asking you."
- The fabrication repair had the same shape, noted in the previous handover.

`weakness()` now names a `repeat` fault, ranked with `fabrication` rather than with the
style faults, because those two are the ones no other component will catch.
`_ORIGINAL_IS_THE_DEFECT` lists them and they get a second repair attempt before any
fallback; every other fault keeps its single attempt.

Related: the greeting exemption in `weakness()` returned `""` outright, which pardoned not
just the mirror check it was written for but the service-phrase check too -- on precisely
the turn a model is likeliest to say "I'm here to help". It is now scoped to the two faults
it was meant to suppress.

**Known and NOT fixed:** a *repair's* trailing sentence can contaminate the history the same
way a joke did -- one probe run propagated "Tell me where the cup holder is." across six
turns; a second run of the same code did not, so it is real but intermittent.
`repetition_filter` does not catch it, because such tails fall under its 3-word tracking
floor. `defuse_for_history` currently reduces only the joke shape. The measured principle
says it should reduce every code-injected turn; that change is not yet made or measured.

**Verification.** 134 tests across the five suites in `code/` (was 115; the 19 new ones
are `HistoryIsNotAnExemplar`, `TheOriginalIsTheDefect`, `CurlyApostrophesAreWhatSheActuallyEmits` and `AGreetingIsNotABlanketPardon`). Full 72-turn `persona_eval.py`: **67/72
(93.1%)**, from 62/72 (86.1%); questions 14% against her real 14%, median 11 words against
her real 9. Treat the score as a proxy only -- in this same run it marked two fabrications
`ok` (grounded turns 4 and 6).

### D3. Length Is Not The Persona Metric
* **Measured, 2026-09-09.** Her 149 real speeches: **median 9 words, median 1 sentence**, 58% under twelve words. The twelve-word floor that `system_prompt.txt` stated in four places, and that `persona_eval.check` scored as `too_short`, therefore condemned the majority of the actual character.
* **Why it mattered:** padding every reply to reach a word count produces the same shape every time — an answer followed by a dutiful observation — and that shape is what reads as a machine. Chasing the floor was making the "robot" complaint worse, not better.
* **Invariant:** the floor is **6** words, in `code/second_beat.py::WORD_FLOOR` and in `persona_eval.check`, and the two MUST agree. It exists only to catch a bare acknowledgement. Warmth is the prompt's job (THE FORMULAS) and the moves' job; it is not a length problem.

### E. Anti-Repetition Is Enforced In Code, Not In The Prompt (`code/repetition_filter.py`)
* **Problem:** Qwen3-8B latches onto a phrase and re-emits it every turn ("What was his name?" six turns running) inside replies that are otherwise different, so no whole-reply dedupe catches it. Prompt rules do not fix it: explicit anti-repetition instructions did not move the `persona_eval.py` score, a runtime "already said" context block scored identically with and without, and the added pressure pushed the model into reciting its own character sheet at the operator.
* **Invariant:** The LLM generator created in `speech_pipeline_manager.process_prepare_generation` MUST stay wrapped in `self.repetition.wrap(...)`. The wrapper buffers to sentence boundaries and withholds any sentence already spoken this conversation, so the text sent to TTS and the text shown in the UI remain the same string.
* **Invariant — the memory is two-stage.** Generations are started speculatively on partial transcripts and discarded when the next partial arrives. A sentence emitted from a discarded generation MUST NOT count as spoken, or the real reply loses it seconds later. Hence:
  * `repetition.commit()` in `server.py`, on the same branch that commits the turn to history.
  * `repetition.abandon()` on the interrupted branch there, and in `process_abort_generation`.
* **Invariant — the filter never mutes her.** If every sentence in a reply is a repeat, the reply is spoken anyway. Saying something twice is a blemish; saying nothing is a broken assistant.
* **Invariant — normalisation parity.** `repetition_filter.normalise` and the key computation in `resources/bella/persona_eval.py::check` MUST stay identical. If they drift, the eval stops measuring what the assistant actually says. `code/test_repetition_filter.py` drives the real checker over filtered replies to hold this; run it after touching either file:
  ```bash
  cd code && ../.venv/bin/python -m unittest test_repetition_filter   # 32 tests
  ```
* **Measured, 2026-09-08.** `persona_eval.py` scores the raw reply and the filtered reply from the same model output, so the delta is the filter's and not the sampler's: **RAW 51/59 (86.4%) -> SPOKEN 55/59 (93.2%)**, 5 repeated sentences withheld, 0 replies wholly repeat. Every `repeat` / `repeat_phrase` / `repeat_question` violation disappeared; the 4 that remain are `lecture` x2 and `corporate` x2, which are prompt problems, not repetition.
* **Invariant — the streaming rescue is not nested.** In `_stream`, the `if not emitted:`
  rescue MUST sit outside `if buffer.strip():`. `_SENTENCE_END` requires whitespace after
  the punctuation, so a reply ending `...new?\n` has its last sentence consumed by `_drain`
  and leaves `buffer` holding only the newline. With the rescue nested inside that guard,
  `wrap()` yielded **nothing at all** — a silent turn, with `kept_nothing` left at 0 so the
  counter that measures muting reported none. Fixed 2026-09-09; re-nesting it fails 4 of
  the 32 tests.
* **Questions have a lower floor.** `MIN_QUESTION_WORDS = 2` against `MIN_WORDS = 3`. A
  repeated two-word acknowledgement is speech; a repeated two-word question is a tic — one
  eval run closed 13 consecutive turns with the same two-word question, invisible to both
  the filter and the checker at a uniform 3-word floor. `persona_eval.check` uses the same
  two floors; that parity is part of the invariant above.
* **Not derived from `self.history`.** That list is capped at 6 turns in `server.py`; the tic spans far more. The filter keeps its own bounded memory (`MEMORY` sentences) and is cleared by `reset()` / `set_history()`.

### F. The Persona Prompt Carries No Example Answers (`code/system_prompt.txt`)
* **Problem.** The prompt used to teach voice with few-shot pairs — an operator line, then
  the answer she should give. At 8B a quoted answer is a menu, not a demonstration: she
  replied to "Hello, how are you?" with the prompt's own example, word for word. A
  "LAST RULE, AND IT OVERRIDES EVERY EXAMPLE ABOVE" section was added to stop it and did
  not work. Rules beneath quoted lines do not beat the quoted lines.
* **Invariant — no sayable line.** `code/system_prompt.txt` contains **no double-quote
  character at all**. Rules describe shape and manner; single quotes name only forbidden
  words. If you add an example answer, you have reintroduced the bug.
* **Invariant — the guard outlives the lines.** `resources/bella/never_say.txt` freezes the
  52 lines the prompt used to quote. `persona_eval.py` guards
  `prompt_quotes(system) | frozen_quotes()`, so deleting examples from the prompt cannot
  quietly empty the guard set and turn a passing score into a vacuous one.
* **Invariant — `num_ctx` must exceed the prompt.** qwen3:8b defaults to a 4096-token
  window. Measured 2026-09-09 via `/api/chat`: `system_prompt.txt.pre-deparrot` 4022 tokens,
  `system_prompt.txt.pre-compress` **exactly 4096** — a prompt that fits reports its true
  length, a prompt that does not reports the ceiling. Truncated, cold prompt eval was
  **16,480 ms per turn** with no prefix-cache reuse. Both `llm_module.py` and
  `persona_eval.py` now send `num_ctx` (`OLLAMA_NUM_CTX`, default 8192). The prompt was
  compressed to 10,916 bytes / **2,917 tokens**; warm prompt eval is **29–180 ms**.
  Watch `prompt_eval_count`: equal to `num_ctx` means you are being truncated.
* **Measured, 2026-09-09**, same instrument, same window, same guard, 59 turns:
  | prompt | SPOKEN | recites_character_sheet | ends in a question | median words |
  | --- | --- | --- | --- | --- |
  | pre-deparrot (baseline) | 48/59 (81.4%) | **7** | 49% | 14 |
  | de-parroted + compressed | 58/59 (98.3%) | **0** | 19% | 6 |
  Recitation is fixed. **The 98.3% is not a quality result and must not be quoted as one** —
  see below.
* **Known open: she is now too short.** That 58/59 was scored on a conversation in which
  she answered a bereavement with six-word restatements of the operator's own sentences.
  The eval could not see it, because `check` had an upper word bound and no lower one and
  never compared the reply against the operator's turn. `too_short` and `echoes_operator`
  (added 2026-09-09) close that: the same prompt, plus rules written to lengthen her,
  scores **20/59 with 38 `too_short`**. The instrument is now honest; the behaviour is not
  yet fixed, and prompt rules have so far failed to fix it.

---

## 3. Spoken Audio Prompt Constraints (`code/system_prompt.txt`)

Kokoro TTS synthesizes audio directly from the model's raw text tokens. Any symbol in the output will be pronounced literally.

* **Strict Spoken Prose:** Output MUST be continuous paragraphs of natural spoken English.
* **FORBIDDEN:**
  * Numbered lists (`1.`, `2.`, `3.`)
  * Bullet points (`-`, `*`)
  * Headers or outlines (`#`, `##`)
  * Markdown emphasis (`**bold**`, `*italics*`)
  * Emojis
  * ~~Ellipses (`...`)~~ — **no longer true.** `code/system_prompt.txt` requires a
    sparing ellipsis ("only where a real person would pause. Two per response at
    most"), because with the TTS engine at roughly half the intensity range of real
    emotional speech the pause is where the feeling lives. Kokoro handles it. This
    line was already false before 2026-09-09.
* **Physical Grounding:** The assistant (Bella — "Victoria" was a previous persona and the name here was stale before 2026-09-09) must NEVER hallucinate having a biological physical body, drinking liquids, eating food, or being physically present in the room. She communicates with warmth, intellect, and worldly presence strictly through voice.

---

## 4. Git Tag Reference
This baseline is locked and tagged in git as:
```bash
git tag -l "v1.0-grounded-victoria-stable"
```
To restore this exact stable state at any point:
```bash
git checkout v1.0-grounded-victoria-stable
```
