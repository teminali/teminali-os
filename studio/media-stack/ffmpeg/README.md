# `<Resources>/ffmpeg`

Empty in the repository. `npm run build:media-stack` fills it with an LGPL
ffmpeg — `ffmpeg`, `ffprobe`, their shared-library closure, the licence texts
and `manifest.json` — and `electron-builder.yml` copies the whole directory to
`<Resources>/ffmpeg`, which is where `findFfmpeg` looks before anything
installed on the machine.

This file exists so the directory does. Git does not track empty directories,
and an `extraResources` entry whose `from:` does not resolve fails the build.

See `../README.md` and `../../docs/MEDIA_LICENSING.md`.
