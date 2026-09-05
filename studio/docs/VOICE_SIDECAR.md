# Voice sidecar — VibeVoice

Teminali Code has two voice tiers. The built-in tier uses the browser's own
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
           "streaming": true, "embedding": false },
  "tts": { "model": "VibeVoice-Realtime-0.5B", "voices": ["default"], "streaming": true }
}
```

Omit `asr` or `tts` for a capability you do not serve. The studio degrades to the
built-in tier for whatever is missing rather than losing voice altogether, and
`server/voice.js` routes the two independently — until 2026-09-05 it did not,
and a sidecar advertising only `tts` was still sent audio to transcribe.

Advertising a capability only once its model is warm is the recommended way to
start: a cold `{}` is read as "no models here" and costs the operator nothing,
whereas a `/status` that blocks on a model load will exceed the gateway's 2.5 s
probe timeout.

### `POST /transcribe`

`multipart/form-data` with an `audio` part (webm/opus or wav) and a `language`
field (a BCP-47 tag, or `auto`).

```json
{ "text": "open the settings panel", "language": "en-US", "confidence": 0.94 }
```

Add `"embedding": [ ... ]` — a speaker embedding — if your build has a verifier
head. The studio uses it for the "only respond to my voice" gate and falls back
to its own on-device matcher when absent. See *Speaker verification* below.

### `POST /speak`

```json
{ "text": "Three edits were made.", "language": "en-US", "voice": null, "rate": 1.0 }
```

Responds with audio bytes (`audio/wav` or `audio/mpeg`).

## Running it

```bash
export TEMINALI_VOICE_URL=http://127.0.0.1:8321   # default
npm run server                                     # gateway picks it up
```

The gateway refuses any non-loopback URL: audio must not leave the machine
because someone mistyped a hostname.

Other knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEMINALI_VOICE_URL` | `http://127.0.0.1:8321` | Sidecar origin (loopback only) |
| `TEMINALI_VOICE_TIMEOUT_MS` | `30000` | Per-request timeout |
| `TEMINALI_VOICE_MAX_AUDIO_BYTES` | `26214400` | Upload ceiling |

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
