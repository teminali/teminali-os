# The bundled media stack

`ffmpeg/` and `mpv/` are **empty in the repository and filled by the build**:
`npm run build:media-stack` puts an LGPL ffmpeg in one, and `electron-builder.yml`
copies each directory to `<Resources>/ffmpeg` and `<Resources>/mpv`, where
`findFfmpeg` and `findMpv` look first.

**`mpv/` stays empty even after a build**, for now — the script will not stage
a binary that links libraries it did not build from a pinned source, and mpv
hard-requires two it does not build yet. `docs/MEDIA_LICENSING.md` has the
detail; the player falls back to a system mpv exactly as it always has.

Nothing here is committed but the three READMEs, which exist so their
directories do — git does not track an empty directory, and an `extraResources`
entry whose `from:` does not resolve fails the build. `media-stack/ffmpeg`
measures 48 MB built (macOS, universal — an `arm64` and an `x86_64` slice in
every Mach-O), it is platform-specific, and it is reproducible from
`scripts/build-media-stack.sh` — which is also what the LGPL source offer
points at.

A build made without running the script ships no bundle and warns about
nothing. That is what every release up to and including v0.0.7 did: the app
falls back to whatever ffmpeg is installed, and says so when there is none.
From the next tagged release it is what Linux and Windows still do — the
workflow installs the assembler on macOS only.

Why LGPL and what it costs: `docs/MEDIA_LICENSING.md`.
