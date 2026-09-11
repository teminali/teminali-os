# `<Resources>/ffmpeg`

Empty in the repository. `npm run build:media-stack` fills it with an LGPL
ffmpeg — `ffmpeg`, `ffprobe`, their shared-library closure, the licence texts
and `manifest.json` — and `electron-builder.yml` copies the whole directory to
`<Resources>/ffmpeg`, which is where `findFfmpeg` looks before anything
installed on the machine.

On macOS every Mach-O here carries both an `arm64` and an `x86_64` slice. One
arm64 runner builds both app bundles and copies this same directory into each,
and `findFfmpeg` picks the bundled binary by existence — so a thin one would be
selected by an Intel Mac and then fail to exec, with the working system ffmpeg
never getting a turn.

This file exists so the directory does. Git does not track empty directories,
and an `extraResources` entry whose `from:` does not resolve fails the build.

See `../README.md` and `../../docs/MEDIA_LICENSING.md`.
