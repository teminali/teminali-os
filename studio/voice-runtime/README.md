# Voice runtime

A loopback speech sidecar. It implements the three routes in
[`../docs/VOICE_SIDECAR.md`](../docs/VOICE_SIDECAR.md) so the gateway needs no
knowledge of which models sit behind them:

| Route | Model | Notes |
| --- | --- | --- |
| `GET /status` | — | Advertises only the capabilities that are already warm. |
| `POST /transcribe` | Whisper (`onnx-community/whisper-base`) | multipart `audio` + `language`. |
| `POST /speak` | Kokoro-82M (`onnx-community/Kokoro-82M-v1.0-ONNX`) | JSON in, `audio/wav` out. |

Both run on CPU through `onnxruntime-node`. Nothing leaves the machine.

## Why it is a separate package

Every other `*-runtime` in `studio/` is a plain directory sharing the studio's
`node_modules`. This one carries its own `package.json` because its
dependencies are 857 MB on disk — `onnxruntime-node` ships native binaries for
every platform, and `@huggingface/transformers` pulls in `sharp`. Keeping them
here keeps them out of the application's dependency tree and out of the
packaged app until that is a deliberate decision.

It is therefore **not installed by `npm install` in `studio/`**. Install it
explicitly:

```bash
npm run voice:install    # from studio/
npm run voice:serve      # starts the sidecar on 127.0.0.1:8321
```

The gateway picks it up with no configuration: `TEMINALI_VOICE_URL` already
defaults to `http://127.0.0.1:8321`, and it refuses any non-loopback URL.

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

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMINALI_VOICE_PORT` | `8321` | Loopback port. |
| `TEMINALI_ASR_MODEL` | `onnx-community/whisper-base` | Any Whisper ONNX repo. `whisper-small` is more accurate and slower. |
| `TEMINALI_TTS_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX` | |
| `TEMINALI_TTS_VOICE` | `af_heart` | One of the 28 voices `/status` lists. |
| `TEMINALI_ASR_DTYPE` / `TEMINALI_TTS_DTYPE` | `q8` | Quantisation. |
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
| Model weights, both models | 137 MB |
| `node_modules` | 857 MB |

Long text is split on clause boundaries before synthesis (`splitClauses`).
Kokoro's own splitter breaks on sentences only, so a single long sentence would
render as one block and give up the latency win entirely.

## Known limits

- **Neither route streams.** `/speak` returns one complete WAV and `/transcribe`
  takes one complete clip; `/status` says `"streaming": false` for both, which
  is honest rather than aspirational. Streaming synthesis is the obvious next
  step and is what would make a long reply start speaking in ~0.5 s instead of
  after the whole render.
- **No speaker embedding.** `/status` reports `"embedding": false`, so the
  "only respond to my voice" gate falls back to the studio's own MFCC matcher.
- **`confidence` is derived from voiced fraction**, not from the model — the
  pipeline exposes no per-utterance score. Saying so beats inventing a number.

## Tests

```bash
node --test tests/*.test.mjs     # 12 tests, no model required
```

They cover the guards, the WAV header and clause splitting — everything that
runs without loading a model. The end-to-end paths are exercised by hand
against a running sidecar.
