# Voice sidecar — VibeVoice

Teminali OS has two voice tiers. The built-in tier uses the browser's own
speech engine and needs no installation. The premium tier runs
[VibeVoice](https://github.com/microsoft/VibeVoice) (MIT) locally and is what
this document is about.

## Why VibeVoice

| Requirement | Built-in | VibeVoice |
| --- | --- | --- |
| Kiswahili, Amharic, Yoruba, Hausa, Zulu | patchy to absent | native, 50+ languages |
| Language detection per utterance | no — you must pick one | yes |
| Audio stays on the machine | no (Chrome sends audio to Google) | yes |
| First audible reply | ~500ms+ | ~300ms (Realtime-0.5B) |
| Runs without a GPU | n/a | yes (ASR-BitNet, 3+ CPU threads) |
| Licence | browser-dependent | MIT |

Models used:

- **VibeVoice-ASR-7B** — recognition, when there is GPU or unified memory to spare.
- **VibeVoice-ASR-BitNet** — recognition on CPU only. The right default on a
  laptop that is already hosting the code model.
- **VibeVoice-Realtime-0.5B** — synthesis from streaming text.

## The implementation in this repo

`studio/voice-runtime/` implements this contract with Whisper for recognition
and Kokoro-82M for synthesis, on CPU, loopback-only. `npm run voice:install`
then `npm run voice:serve`. See [`../voice-runtime/README.md`](../voice-runtime/README.md).
The VibeVoice models below remain the specified premium tier; nothing about the
contract changes for a different backend, which is the point of having one.

## What the studio expects

The studio never loads model weights itself. It calls the gateway, the gateway
calls a loopback sidecar, and the sidecar owns the models. Three routes:

### `GET /status`

```json
{
  "asr": { "model": "VibeVoice-ASR-BitNet", "languages": ["en-US", "sw-TZ", "..."],
           "streaming": true, "embedding": false, "sounds": false, "vocabulary": 27 },
  "tts": { "model": "VibeVoice-Realtime-0.5B", "voices": ["default"], "streaming": true }
}
```

`model` must name the weights actually loaded, not the weights configured — an
operator reading `/status` is asking what is answering them right now.
`vocabulary` is optional and advisory: the number of domain terms the sidecar
will repair in a transcript (see *Domain vocabulary* below). Omit it if your
build does no such repair.

Omit `asr` or `tts` for a capability you do not serve. The studio degrades to the
built-in tier for whatever is missing rather than losing voice altogether, and
`server/voice.js` routes the two independently — until 2026-09-05 it did not,
and a sidecar advertising only `tts` was still sent audio to transcribe.

`asr.model` is also **compared** against whatever whisper.cpp has locally, and
the better model gets the audio: a sidecar on `whisper-base` will not be asked
to transcribe on a machine holding `large-v3-turbo`, though it keeps synthesis.
Name the model honestly — `rankLocalModel` in `server/speech-local.js` reads the
family out of the string — and see `DESIGN.md` §6.10. The operator can pin
either side with `TEMINALI_ASR_ENGINE`.

`tts.streaming` means `/speak` accepts `"stream": true` and answers in clause
frames (below). A backend that renders whole files says `false` and is only
ever asked for whole files.

Advertising a capability only once its model is warm is the recommended way to
start: a cold `{}` is read as "no models here" and costs the operator nothing,
whereas a `/status` that blocks on a model load will exceed the gateway's 2.5 s
probe timeout.

### `POST /transcribe`

`multipart/form-data` with an `audio` part (webm/opus or wav) and a `language`
field (a BCP-47 tag, or `auto`).

An optional `hints` field carries a JSON array of strings — the open project's
own folder and file names, at most 64 of them. A backend whose decoder takes an
initial prompt should use them as one; the words the operator says most often
are precisely the words a general recogniser has never seen. Ignore the field if
yours does not, and repair after the fact instead (see *Domain vocabulary*).

```json
{ "text": "open the settings panel", "language": "en-US", "confidence": 0.94 }
```

`confidence` is not decoration: the studio now uses it to decide whether an
utterance was speech at all before letting it become a prompt (DESIGN.md
§6.12–§6.13). Report a real 0–1 number or **omit the field**, which reads as
"not reported" and makes the studio fall back to text-only evidence. A
fabricated constant is worse than nothing — a hard-coded `1.0` tells the gate
that an empty room was certainly speech. If your build separates them, you may
also send `"languageConfidence"` (how sure it was of the language it picked —
the signal that actually distinguishes speech from a room) and
`"acousticConfidence"` (mean per-word probability); the studio's own
whisper-server path sends both, `whisper-cli` sends only the second.

Add `"embedding": [ ... ]` — a speaker embedding — if your build has a verifier
head. The studio uses it for the "only respond to my voice" gate and falls back
to its own on-device matcher when absent. See *Speaker verification* below.

#### Domain vocabulary

A recogniser has never read the operator's repository, so the words they say
most often — project names, folder names, tool names — are the words it spells
worst. A build that can bias its decoder toward a supplied vocabulary should;
one that cannot may repair the transcript instead, and should say how large its
list is in `asr.vocabulary`.

The reference sidecar cannot bias its decoder: `@huggingface/transformers` 3.8.1
declares `prompt_ids` on `WhisperGenerationConfig` but never consumes it, and
the tokenizer exposes no `get_prompt_ids`, so Whisper's `initial_prompt` is
unavailable through this library. It repairs afterwards, matching only on an
exact consonant skeleton so that a word the operator really said is never
overwritten. `TEMINALI_ASR_VOCABULARY` extends the list per machine.

Measured over 32 synthesised utterances (paths, folder names, shell commands,
identifiers, ordinary requests, and de/fr/es/pt clips), the repair took
`whisper-base` from 14.2% to 11.6% word error at an unchanged 385 ms median —
better than `whisper-small`'s 12.3% at 896 ms. Synthesised speech is cleaner
than a real microphone, so those rates are optimistic; the ordering is the
finding, not the absolute numbers.

#### Naming sounds

Set `"sounds": true` on the `asr` block of `/status` if your build can name
non-speech audio. The studio then sends a `sounds=1` form field on the clips it
wants labelled, and you answer with a `sounds` array — **including an empty one**,
which is a real answer and not the same as omitting the field:

```json
{ "text": "", "language": "en-US", "confidence": 0,
  "sounds": [{ "label": "Car passing by", "sound": "a car going past", "confidence": 0.62 }] }
```

`label` is the raw class from whatever taxonomy you use; `sound` is how to say
it out loud, because the studio reads it back verbatim. Three rules the studio
relies on, and the reference implementation enforces in `sounds.js`:

1. **Never report speech.** "Speech", "Conversation", "Narration" and the rest
   belong to the transcript. An ambient log that carried both would answer
   "what did she say?" with "a person speaking".
2. **Never report the room.** "Silence", "Static", "Inside, small room" and
   mains hum are the noise floor, not events — and they score high enough to
   pass any useful threshold, so drop them by name rather than by score.
3. **Never guess.** Below your threshold, return `[]`. That is what lets the
   studio say no to "did you hear that?" instead of inventing a door.

The field is opt-in per request because classification is a second model pass:
in this repo's sidecar it costs ~220 ms and does not overlap recognition, so it
is spent only on clips that produced no words. See `voice-runtime/asr.js` for
why that is where the labels are worth anything anyway.

### `POST /speak`

```json
{ "text": "Three edits were made.", "language": "en-US", "voice": null, "rate": 1.0, "stream": false }
```

Responds with audio bytes (`audio/wav` or `audio/mpeg`).

#### Streaming

When `"stream": true` is sent and `/status` advertised `"streaming": true` under
`tts`, respond `200` with `content-type: application/vnd.teminali.speech-stream`
and write one frame per rendered clause the moment it is rendered, so the studio
starts playing after the first clause instead of after the whole reply. The
status line and headers are written before rendering starts, but Node holds
them until the first `write`, so on the wire they arrive with the first clause
frame: a relay that waits for headers is waiting for the first clause, and its
timeout bounds exactly that.

```
u32be headerLength | header JSON (UTF-8) | u32be bodyLength | body
```

- **Audio frame.** Header `{ "clause", "start", "end", "sampleRate", "samples" }`,
  body `samples` × 16-bit little-endian mono PCM. `start`/`end` are character
  offsets of the clause in `text` as sent; the studio uses them to report how
  much of a reply was heard when the operator cuts in.
- **Last frame.** `{ "done": true }` with an empty body. A stream that ends
  without it was cut off; the studio plays what arrived and stops.
- **Failure after the headers went out.** `{ "error": "..." }` with an empty
  body, then end.

Stop rendering when the connection closes. The studio hangs up on a barge-in
and the gateway propagates it; a sidecar that keeps rendering is spending CPU on
a sentence nobody will hear. Inference holds the event loop, so the closed
socket is noticed at a clause boundary rather than instantly. Measured through
the gateway from the app on 2026-09-05: the studio cut in during the second
clause and the sidecar stopped after writing its fourth. Frames written in that
window are discarded, and a reply requested in it starts late by the abandoned
clause's render (its first clause came at 3.2 s instead of 1.2 s).

A request without `stream`, or to a backend that does not stream, is answered
with the whole file exactly as before. The gateway (`server/voice.js`) relays a
streamed reply without parsing it, and the studio's reader is
`src/services/voice/speechStream.ts`; each carries its own copy of the framing,
because the contract is this document, not a shared import.

## Running it

```bash
export TEMINALI_VOICE_URL=http://127.0.0.1:8321   # default
npm run server                                     # gateway picks it up
```

The gateway refuses any non-loopback URL: audio must not leave the machine
because someone mistyped a hostname.

A packaged app starts the sidecar itself: `electron/main.cjs` spawns
`<Resources>/voice-runtime/cli.js` under the app's Electron binary with
`ELECTRON_RUN_AS_NODE=1`, on the port `TEMINALI_VOICE_URL` names (8321 unless
moved), unless that port is already held — then it starts nothing and the
gateway talks to whatever is there. It passes `TEMINALI_VOICE_CACHE`, which the
sidecar reads to place the model weights under the app's userData instead of
inside its own package. See `studio/README.md`, "The speech sidecar in a
packaged app", and `voice-runtime/README.md`.

Other knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEMINALI_VOICE_URL` | `http://127.0.0.1:8321` | Sidecar origin (loopback only) |
| `TEMINALI_VOICE_TIMEOUT_MS` | `30000` | Per-request timeout |
| `TEMINALI_VOICE_MAX_AUDIO_BYTES` | `26214400` | Upload ceiling |
| `TEMINALI_VOICE_CACHE` | transformers.js's own `.cache` | Read by the sidecar: where model weights are cached. Set by the packaged app |
| `TEMINALI_ASR_MODEL` | `onnx-community/whisper-base` | Read by the sidecar: which Whisper to load. `onnx-community/whisper-small` trades 2.3x the latency for 2.0 points of word error |
| `TEMINALI_ASR_VOCABULARY` | *(empty)* | Read by the sidecar: extra domain terms, comma or newline separated |
| `TEMINALI_SOUND_MODEL` | `Xenova/ast-finetuned-audioset-10-10-0.4593` | Sound classifier |
| `TEMINALI_SOUND_THRESHOLD` | `0.35` | Confidence a label needs to be reported |

The gateway caches `/status` for 15 seconds, so an always-open microphone does
not poll a dead port.

## Speaker verification

The "only respond to my voice" switch works on either tier, but not equally
well:

- **Without a sidecar embedding**, the studio computes a mean-MFCC voiceprint in
  the browser (`src/services/voice/speakerProfile.ts`). This reliably separates
  the enrolled speaker from a clearly different voice on the same microphone. It
  does **not** reliably separate two similar voices, and it drifts across
  microphones. It is therefore weighted as one signal among several, and the UI
  says which mode is active.
- **With a sidecar embedding**, verification is as good as the model behind it.
  If you want the strong version, put a purpose-built verifier in the sidecar —
  an ECAPA-TDNN or WeSpeaker ONNX model is 7–20MB and far better at this than
  any general speech model — and return its embedding from `/transcribe`.

## Privacy

Audio is sent to the sidecar and nowhere else. The gateway's audit log records
that a transcription happened, its byte count and its detected language — never
the transcript itself. Voice profiles live in the renderer's `localStorage` and
are never uploaded.
