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
**MIT Licence**, and links to a `LICENSE` file for the text. **That file does
not exist.** Measured 2026-09-10: the raw URL for `LICENSE` on `main` returns
**404**, and GitHub's own licence endpoint for the repository
(`/repos/KoljaB/RealtimeVoiceChat/license`) returns **404** as well, which is
what GitHub reports when it detects no licence file at all. The fork we cloned
carries none either, in its working tree or its history. The omission is
upstream's, and there is nothing to copy.

What upstream does say, quoted verbatim from its README:

> The core codebase of this project is released under the **MIT License** (see
> the [LICENSE](./LICENSE) file for details).

**Open action:** the grant is MIT, but the copyright line that MIT obliges a
redistributor to carry has never been published. Before Teminali OS is
distributed, ask upstream to publish the file — or obtain the copyright holder
and year in writing — and reproduce it here unmodified. Inventing the copyright
line rather than copying it would be worse than the omission, which is why this
directory still ships without a `LICENSE`.

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
Their `resources/bella/audio_samples/_backup_20260909/` copies are **not**: five
files, 2.5 MB, byte-identical duplicates of the live embeddings beside them. They
remain on disk and untracked. A backup taken against a working tree does not
belong in a history that already has every earlier version.
