# Provenance

This directory is a fork of **[KoljaB/RealtimeVoiceChat](https://github.com/KoljaB/RealtimeVoiceChat)**,
vendored into Teminali OS on 2026-09-09.

Until then it lived beside the repository as an independent clone, excluded by
`.gitignore` and pointing its `origin` at the upstream project. That meant every
change made to it here — the ASR guard, the delivery and timing work, the
repetition filter, the half-duplex fix — existed on exactly one disk and in
nobody's history. It is vendored so that the voice assistant is part of the
product rather than a checkout somebody has to reproduce.

The fork's own history (upstream commits plus the work done before vendoring)
is preserved outside the repository at
`my_projects/teminali/realtime-voice-upstream.git`. Nothing was discarded.

## Licence

Upstream states in its README that the core codebase is released under the
**MIT Licence**. The fork we cloned carries no `LICENSE` file in its working
tree or its history, so the upstream text is not reproduced here yet.

**Open action:** copy the `LICENSE` file from
`https://github.com/KoljaB/RealtimeVoiceChat` into this directory, unmodified,
before Teminali OS is distributed. Vendoring MIT code obliges us to carry the
copyright notice with it, and inventing the copyright line rather than copying
it would be worse than the omission.

The pipeline also depends on components with their own terms — Kokoro and Coqui
XTTSv2 for synthesis, Whisper for recognition, and whichever model Ollama is
serving. Those are not covered by the licence above.

## What is not in git

The `.gitignore` excludes the 2 GB virtualenv, the vendored wheels, the
`experiments/` directory, and ~95 MB of rendered voice takes under
`resources/bella/`. The measurements those takes produced are written down in
code comments and `LOCKED_PIPELINE_SPEC.md`, which is the part worth versioning.
The Kokoro voice embeddings (`*.pt`) *are* committed: they are small, they are
the voice itself, and they cannot be regenerated without repeating the tuning.
