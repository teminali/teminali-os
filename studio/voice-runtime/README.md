# Voice runtime

A loopback speech sidecar. It implements the three routes in
[`../docs/VOICE_SIDECAR.md`](../docs/VOICE_SIDECAR.md) so the gateway needs no
knowledge of which models sit behind them:

| Route | Model | Notes |
| --- | --- | --- |
| `GET /status` | — | Advertises only the capabilities that are already warm. |
| `POST /transcribe` | Whisper (`onnx-community/whisper-base`) | multipart `audio` + `language`. |
| `POST /speak` | Kokoro-82M (`onnx-community/Kokoro-82M-v1.0-ONNX`) | JSON in, `audio/wav` out; with `"stream": true`, one frame per clause as it renders. |

Both run on CPU through `onnxruntime-node`. Nothing leaves the machine.

## Why it is a separate package

Every other `*-runtime` in `studio/` is a plain directory sharing the studio's
`node_modules`. This one carries its own `package.json` because its
dependencies are 692 MB on disk, plus another 474 MB of model cache that
transformers.js keeps inside its own package — 1.2 GB in all (`du -sk`,
2026-09-07) — because `onnxruntime-node`
ships native binaries for every platform, and `@huggingface/transformers`
pulls in `sharp`. Keeping them here keeps them out of the application's
dependency tree. The packaged app ships them pruned to one platform and
architecture — see [In the packaged app](#in-the-packaged-app).

It is therefore **not installed by `npm install` in `studio/`**. Install it
explicitly:

```bash
npm run voice:install    # from studio/
npm run voice:serve      # starts the sidecar on 127.0.0.1:8321
```

The gateway picks it up with no configuration: `TEMINALI_VOICE_URL` already
defaults to `http://127.0.0.1:8321`, and it refuses any non-loopback URL.

## In the packaged app

Nothing to start: `electron/main.cjs` spawns `cli.js` from
`<Resources>/voice-runtime` under the app's own Electron binary with
`ELECTRON_RUN_AS_NODE=1`, packaged builds only. The port is taken from
`TEMINALI_VOICE_URL`, else `TEMINALI_VOICE_PORT`, else 8321; if it is already
held (a development sidecar, usually) the app starts no second one. Stderr is
relayed into the app's `studio-main.log` as `Voice sidecar: …`, and quitting
the app sends SIGTERM.

The app hands it `TEMINALI_VOICE_CACHE=<userData>/voice-models`, and `cli.js`
sets transformers.js's `env.cacheDir` from it before warm-up. Without it
transformers.js caches inside its own package — inside the signed bundle when
packaged. The weights are a first-run download; `/status` reports each model
as it becomes ready and nothing else does. Measured on this machine's cache
with `du -sh`: whisper-base 76 MB, Kokoro 311 MB, the AudioSet classifier
87 MB — 474 MB in all. Kokoro was 88 MB and the total 251 MB until 2026-09-07,
when synthesis stopped being quantised; see *Synthesis is not quantised*.

What ships is decided in `electron-builder.yml`: the source, and
`node_modules` minus the `.cache`, source maps, `.d.ts`, `.md`, `.bin`, every
onnxruntime binary but the one for the platform and architecture being built,
this package's own top-level `onnxruntime-node`, which nothing imports —
`@huggingface/transformers` pins `1.21.0` and nests its own copy — and the web
half of transformers.js: `onnxruntime-web`, the `transformers.web` bundles and
`ort-wasm-simd-threaded.jsep.wasm`. Nothing here can reach that half. The
sidecar is a Node process, so `exports` resolve to `dist/transformers.node.mjs`
and its only ONNX requires are `onnxruntime-node` and `onnxruntime-common`;
deleting all 91 MB and running a real Whisper transcription and a real Kokoro
generation against the cached weights is how that was established, because
import resolution alone does not prove it — the backend is chosen when a
session is created, not when the module is imported. On the macOS arm64 build
that leaves 97 MB under `Contents/Resources/voice-runtime`, down from 195 MB. The
release workflow installs these before it packages (`npm run voice:install`,
`.github/workflows/release.yml`); without that step an artifact would carry the
source alone, and the packaged sidecar would exit at its first import while the
app kept the built-in engine. It has run in CI since v0.0.2: the v0.0.3
artifacts are 188 MB (macOS arm64 `.zip`), 196 MB (macOS x64) and 397 MB
(the Linux AppImage), all of which carried the unpruned 195 MB.

## Warm-up is not an error

The models load in the background and `/status` reports only what is ready. A
cold sidecar answers `{}`, which the gateway reads as "no speech models here"
and falls back to the local tier, so the operator keeps a voice while ~474 MB
of weights download on first run. A sidecar serving only one capability is also
legal: `server/voice.js` routes each of synthesis and recognition
independently.

## Not answering the room

Whisper is generative. Handed silence, hiss, a cough or a passing car it does
not return nothing — it returns its best guess at what a human would have said,
and with no language pinned it guesses in whatever language the noise resembles.
That is the failure this runtime exists to stop: a live session on 2026-09-05
produced Devanagari, then `Hanna, hanna, hanna, hanna, hanna, hanna`, then a
line of Arabic that is not a sentence.

`transcript-guard.js` holds the countermeasures, all pure functions:

| Guard | Rejects |
| --- | --- |
| `assessAudio` | clips under 250 ms, or under 8% voiced frames |
| `isDegenerate` | looping n-grams — the `hanna, hanna, hanna` case |
| `isSilenceArtefact` | Whisper's subtitle fillers (`thank you`, `please subscribe`, `amara.org`) |
| `isScriptMismatch` | Devanagari or Arabic returned for a request pinned to a Latin-script language |

`voicedFraction` in `audio.js` measures energy against the **clip's own** noise
floor rather than a fixed threshold, so it works in a noisy room as well as a
quiet one. A steady tone at any volume reads as unvoiced: what makes the model
hallucinate is featureless audio, not quiet audio.

A rejected clip returns `{"text": ""}`. To the studio it is indistinguishable
from silence, which is the point — the alternative is an assistant that argues
with the room.

## Choosing a recogniser, and putting the vocabulary back

A live session asked for a folder by name and the recogniser returned a name no
folder has; the agent then acted on it. Whisper has never read this repository,
so the words this operator says most often are the words it is least able to
spell.

The usual fix — Whisper's `initial_prompt`, a list of proper nouns handed to the
decoder — **is not available**. `@huggingface/transformers` 3.8.1 declares
`prompt_ids` on `WhisperGenerationConfig` but `generate()` leaves it commented
out (`src/models.js`), and the tokenizer has no `get_prompt_ids`. Nothing in the
options object biases the decoder toward a vocabulary.

So the bias is applied afterwards, in `lexicon.js`: a phrase is rewritten only
when its consonant skeleton is *exactly* the skeleton of a known term. No edit
distance — "terminal" and "Teminali" are one consonant apart, and a repair that
overwrites a word the operator really said is worse than the misrecognition.
Spellings that do not collide are named as aliases, each one observed rather
than imagined. `TEMINALI_ASR_VOCABULARY` adds the names that belong to this
machine and no other. `/status` reports the size of the list as
`asr.vocabulary`.

Measured on 32 synthesised utterances — paths, folder names, shell commands,
technical identifiers, ordinary requests, and clips in de/fr/es/pt — scored as
word error rate against the spoken text (harness in the scratchpad, not in the
repo). **Synthesised speech is far cleaner than a microphone in a room, so the
absolute rates are optimistic; only the comparison between rows means anything.**
Latency is per utterance, warm, M4 Pro, int8, CPU.

| Configuration | WER | median | p95 | download |
| --- | --- | --- | --- | --- |
| `whisper-base`, language auto | 31.5% | 411 ms | 483 ms | 76 MB |
| `whisper-base`, language pinned — **previous default** | 14.2% | 385 ms | 489 ms | 76 MB |
| `whisper-base` + `temperature: 0` | 14.2% | 377 ms | 446 ms | 76 MB |
| `whisper-base` + `no_repeat_ngram_size: 3` | 14.2% | 386 ms | 432 ms | 76 MB |
| `whisper-base` + `num_beams: 4` | 14.2% | 478 ms | 613 ms | 76 MB |
| `whisper-base` + vocabulary repair — **current default** | **11.6%** | **385 ms** | **489 ms** | **76 MB** |
| `whisper-small`, language pinned | 12.3% | 896 ms | 1133 ms | 240 MB |
| `whisper-small` + vocabulary repair | 10.3% | 896 ms | 1133 ms | 240 MB |

Three things that measurement settled:

- **The decoding options are free and worthless here.** `temperature`,
  `no_repeat_ngram_size` and beam search moved the word error rate by exactly
  zero across all 32 clips; transformers.js already decodes greedily, and beam
  search bought nothing for +93 ms at the median and +124 ms at p95.
- **A bigger model is a poor trade in a live conversation.** `whisper-small`
  removes a seventh of the errors for 2.3x the wait and another 164 MB of
  first-run download. The repair removes more, for 0.03 ms and no download.
- **Pinning the language is the largest single lever** — it halves the error
  rate, entirely on the non-English clips. Recognition of English is unchanged
  (14.9% either way); what auto-detect gets wrong is *which* language.

`whisper-small` remains one `TEMINALI_ASR_MODEL` away for an operator who would
rather wait than repeat themselves, and it stacks with the repair (10.3%).

## Naming the room instead of transcribing it

The guards above throw away a passing car. That is right for the transcript and
wrong for the operator, who asked to be able to say *"did you hear that?"*.
`sounds.js` names what the words were not: AudioSet AST over 527 classes, on the
same 16 kHz float32 the recogniser already holds.

Ask for it with a `sounds=1` field on `/transcribe`; it is off by default so the
repair and re-scoring passes do not pay for labels they discard. `/status`
advertises `asr.sounds` once the model is warm.

```
$ curl -s -F "audio=@beep.wav" -F "sounds=1" localhost:8321/transcribe
{"text":"","language":"en-GB","confidence":0,
 "sounds":[{"label":"Beep, bleep","sound":"a beep","confidence":0.771}]}
```

`selectSounds` decides what is worth saying, and its three rules are the whole
design:

| Dropped | Because |
| --- | --- |
| `Speech`, `Conversation`, `Narration`, `Speech synthesizer` | the transcript owns words; a log carrying both answers "what did she say?" with "a person speaking" |
| `Silence`, `Static`, `White noise`, `Inside, small room`, `Mains hum` | the noise floor and the shape of the room are not events — and they score high enough to clear any useful threshold, so they go by name, not by score |
| anything under `TEMINALI_SOUND_THRESHOLD` | `[]` is a real answer; it is what lets the studio say no instead of inventing a door |

What survives is rendered into words a person would use — `Vehicle horn, car
horn, honking` is read back as "a car horn" — because the studio speaks the
`sound` field verbatim. An unmapped label falls back to an article plus the text
before the first comma, which is plain but never wrong.

**Only clips with no words are classified.** Recognition of a 2.5 s utterance
takes ~250 ms and classification takes ~220 ms, and they do not overlap: ONNX
runs inference synchronously, so the costs add. Spending it on spoken clips
would put a quarter-second in front of every reply and return almost nothing —
speech dominates the classifier at 0.85, and a car underneath a talking person
does not clear the threshold. The clip where a car *is* the loudest thing is the
clip with no words in it. The cost of the rule: a car that passes mid-sentence
goes unlogged.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMINALI_VOICE_PORT` | `8321` | Loopback port. |
| `TEMINALI_VOICE_CACHE` | transformers.js's own `.cache` | Where model weights are cached. The packaged app sets it to `<userData>/voice-models`. |
| `TEMINALI_ASR_MODEL` | `onnx-community/whisper-base` | Any Whisper ONNX repo. `onnx-community/whisper-small` is 2.0 points more accurate and 2.3x slower (see *Choosing a recogniser*). |
| `TEMINALI_ASR_VOCABULARY` | *(empty)* | Extra domain terms, comma or newline separated — the project and folder names on this machine. Added to the built-in list in `lexicon.js`. |
| `TEMINALI_TTS_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX` | |
| `TEMINALI_SOUND_MODEL` | `Xenova/ast-finetuned-audioset-10-10-0.4593` | AudioSet classifier behind `sounds=1`. |
| `TEMINALI_SOUND_THRESHOLD` | `0.35` | Confidence a label needs before it is reported. |
| `TEMINALI_TTS_VOICE` | `af_heart` | One of the 28 voices `/status` lists. |
| `TEMINALI_ASR_DTYPE` / `TEMINALI_SOUND_DTYPE` | `q8` | Quantisation. |
| `TEMINALI_TTS_DTYPE` | `fp32` | Synthesis is **not** quantised, since 2026-09-07: `q8` measured slower here, not faster (see *Measured on this machine*). `q4` measures level with `fp32` if download size ever matters more than the margin. |
| `TEMINALI_FFMPEG` | first of `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `PATH` | Decodes the recorder's webm/opus to 16 kHz mono. |

`ffmpeg` is a hard requirement for recognition: Node cannot decode Opus and the
studio's `MediaRecorder` produces `audio/webm;codecs=opus`.

## Measured on this machine

An M4 Pro, warm, over loopback. Synthesis runs at `fp32`; recognition and the
sound classifier are int8:

| | |
| --- | --- |
| `Running the tests.` -> 0.96 s of audio | **0.24 s** |
| `Two edits were made, and the tests passed.` -> 2.07 s of audio | **0.48 s** |
| Recognition of a 2.5 s utterance | accurate, confidence 0.92 |
| Naming a sound in a wordless clip | **0.22 s** |
| Sound classifier, cold (first download) | 123 s; 0.09 s from cache thereafter |
| Model weights, all three models | 474 MB (whisper-base 76, Kokoro `fp32` 311, AudioSet 87) |
| `node_modules` | 1.2 GB, of which 474 MB is the model cache |
| Shipped in the macOS arm64 app (`Contents/Resources/voice-runtime`) | 97 MB (195 MB before the web half was excluded) |

### Synthesis is not quantised (2026-09-07)

`TEMINALI_TTS_DTYPE` defaulted to `q8` until 2026-09-07 on the assumption that a
smaller model is a faster one. Measured through this sidecar, on the same texts,
warm, three runs each, it is the opposite:

| | `q8` | `fp32` |
| --- | ---: | ---: |
| `Running the tests.` | 530 ms | **245 ms** |
| `Two edits were made, and the tests passed.` | 1130 ms | **478 ms** |
| 35-word reply, first clause on the wire | 666 ms | **286 ms** |
| 35-word reply, whole file | 4527 ms | **1972 ms** |

Int8 Kokoro is roughly 2.3x slower here and no cheaper: it costs more CPU per
second of audio, and it grades marginally worse (UTMOS 4.410 against 4.440 over
a six-sentence corpus). The download is the only thing quantisation buys — 88 MB
against 311 MB — so `q8` remains available through the variable, and `q4`
(291 MB) measures level with `fp32` if that trade ever matters.

Recognition and the sound classifier are untouched and stay int8; this was
measured for Kokoro only.

Long text is split on clause boundaries before synthesis (`splitClauses`).
Kokoro's own splitter breaks on sentences only, so a single long sentence would
render as one block and give up the latency win entirely. A conjunction opens
the next clause rather than being the break: until 2026-09-05 the split
consumed it, and "I tried, but it failed" was spoken as "I tried, it failed".

**The first clause is capped shorter than the rest** (`FIRST_CLAUSE_WORDS`, 6
words, against `MAX_CLAUSE_WORDS`'s 18; `splitClauses` takes both as
parameters). Only the first clause decides when anything is heard — every later
one renders while an earlier one plays, and at this speed they never catch up to
the ear — so shortening only the opening buys latency without flattening the
prosody of the whole utterance the way a smaller `MAX_CLAUSE_WORDS` would. It
does nothing when punctuation already breaks early, and a great deal when it does
not. Measured at `fp32`, p50 of five runs, time to render the first clause:

| opening | 18-word cap | 6-word cap |
| --- | ---: | ---: |
| "The build finished cleanly and every test..." — breaks at *and*, so both caps yield the same four words | 287 ms | 261 ms (noise) |
| "Open the file at studio slash server slash voice dot js and check..." | 640 ms | **308 ms** |
| A 24-word sentence with no punctuation before its full stop | 928 ms | **332 ms** |

The split is on whitespace only, so every piece stays a literal substring of the
input and `clauseOffsets` can still locate it.

With `"stream": true` each clause is written as a frame (`stream.js`, format in
[`../docs/VOICE_SIDECAR.md`](../docs/VOICE_SIDECAR.md)) the moment Kokoro
returns it, and `/status` says `"streaming": true` under `tts`. Measured on this
machine for a 35-word reply (10.4 s of speech): the first clause is on the wire
at 0.29 s, where the whole file arrived at 1.97 s; the total render is the same.
Each frame carries the clause's character offsets, so the studio can say how
much of a reply was heard when the operator cuts in. The render stops when the
client hangs up, at a clause boundary: inference holds the event loop, so the
closed socket is noticed between clauses and the clause rendered in between is
discarded. Measured through the gateway from the app on 2026-09-05, at the
then-default `q8`: the studio cut in during the second clause and the sidecar
stopped after writing its fourth, and a reply requested in that window got its
first clause at 3.2 s instead of 1.2 s.

## Known limits

- **`/transcribe` does not stream.** It takes one complete clip, and `/status`
  says `"streaming": false` under `asr`. `/speak` streams since 2026-09-05.
- **No speaker embedding.** `/status` reports `"embedding": false`, so the
  "only respond to my voice" gate falls back to the studio's own MFCC matcher.
- **`confidence` is derived from voiced fraction**, not from the model — the
  pipeline exposes no per-utterance score. Saying so beats inventing a number.
- **A sound under speech is not named**, by the deliberate rule above: only
  wordless clips are classified.

## Tests

```bash
node --test tests/*.test.mjs     # 40 tests, no model required
```

They cover the guards, the WAV header, clause splitting and offsets, the stream
framing, the phonetic keys and windowing of the vocabulary repair, and every
rule about which sounds are worth reporting — everything that runs without loading a model.
`selectSounds` is separated from `classifySounds` for exactly this reason: the
judgement is testable without the classifier. The end-to-end paths are exercised
by hand against a running sidecar.
