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
dependencies are 943 MB on disk (`du -sh node_modules`; 251 MB of that is the
model cache transformers.js keeps inside its own package) — `onnxruntime-node`
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
with `du -sh`: whisper-base 76 MB, Kokoro 88 MB, the AudioSet classifier
87 MB — 251 MB in all.

What ships is decided in `electron-builder.yml`: the source, and
`node_modules` minus the `.cache`, source maps, `.d.ts`, `.md`, `.bin`, every
onnxruntime binary but the one for the platform and architecture being built,
and this package's own top-level `onnxruntime-node`, which nothing imports —
`@huggingface/transformers` pins `1.21.0` and nests its own copy. On the macOS
arm64 build that is 184 MB under `Contents/Resources/voice-runtime`. The
release workflow installs these before it packages (`npm run voice:install`,
`.github/workflows/release.yml`); without that step an artifact would carry the
source alone, and the packaged sidecar would exit at its first import while the
app kept the built-in engine. That step has not yet run in CI.

## Warm-up is not an error

The models load in the background and `/status` reports only what is ready. A
cold sidecar answers `{}`, which the gateway reads as "no speech models here"
and falls back to the local tier, so the operator keeps a voice while ~137 MB
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
| `TEMINALI_ASR_MODEL` | `onnx-community/whisper-base` | Any Whisper ONNX repo. `whisper-small` is more accurate and slower. |
| `TEMINALI_TTS_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX` | |
| `TEMINALI_SOUND_MODEL` | `Xenova/ast-finetuned-audioset-10-10-0.4593` | AudioSet classifier behind `sounds=1`. |
| `TEMINALI_SOUND_THRESHOLD` | `0.35` | Confidence a label needs before it is reported. |
| `TEMINALI_TTS_VOICE` | `af_heart` | One of the 28 voices `/status` lists. |
| `TEMINALI_ASR_DTYPE` / `TEMINALI_TTS_DTYPE` / `TEMINALI_SOUND_DTYPE` | `q8` | Quantisation. |
| `TEMINALI_FFMPEG` | first of `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `PATH` | Decodes the recorder's webm/opus to 16 kHz mono. |

`ffmpeg` is a hard requirement for recognition: Node cannot decode Opus and the
studio's `MediaRecorder` produces `audio/webm;codecs=opus`.

## Measured on this machine

An M4 Pro, int8, warm, over loopback:

| | |
| --- | --- |
| `Running the tests.` -> 1.55 s of audio | **0.51 s** |
| `Two edits were made, and the tests passed.` -> 3.10 s of audio | **1.12 s** |
| Recognition of a 2.5 s utterance | accurate, confidence 0.92 |
| Naming a sound in a wordless clip | **0.22 s** |
| Sound classifier, cold (first download) | 123 s; 0.09 s from cache thereafter |
| Model weights, all three models | 137 MB plus the classifier |
| `node_modules` | 943 MB, of which 251 MB is the model cache |
| Shipped in the macOS arm64 app (`Contents/Resources/voice-runtime`) | 184 MB |

Long text is split on clause boundaries before synthesis (`splitClauses`).
Kokoro's own splitter breaks on sentences only, so a single long sentence would
render as one block and give up the latency win entirely. A conjunction opens
the next clause rather than being the break: until 2026-09-05 the split
consumed it, and "I tried, but it failed" was spoken as "I tried, it failed".

With `"stream": true` each clause is written as a frame (`stream.js`, format in
[`../docs/VOICE_SIDECAR.md`](../docs/VOICE_SIDECAR.md)) the moment Kokoro
returns it, and `/status` says `"streaming": true` under `tts`. Measured on this
machine for a 36-word reply (13.4 s of speech): the first clause is on the wire
at 1.1 s, where the whole file arrived at 6.2 s; the total render is the same.
Each frame carries the clause's character offsets, so the studio can say how
much of a reply was heard when the operator cuts in. The render stops when the
client hangs up, at a clause boundary: inference holds the event loop, so the
closed socket is noticed between clauses and the clause rendered in between is
discarded. Measured through the gateway from the app on 2026-09-05: the studio
cut in during the second clause and the sidecar stopped after writing its
fourth, and a reply requested in that window got its first clause at 3.2 s
instead of 1.2 s.

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
node --test tests/*.test.mjs     # 24 tests, no model required
```

They cover the guards, the WAV header, clause splitting and offsets, the stream
framing, and every rule about which sounds are worth reporting — everything that runs without loading a model.
`selectSounds` is separated from `classifySounds` for exactly this reason: the
judgement is testable without the classifier. The end-to-end paths are exercised
by hand against a running sidecar.
