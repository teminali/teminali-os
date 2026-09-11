# `<Resources>/mpv`

Empty in the repository, and — unlike `../ffmpeg` — still empty after a build.
mpv 0.39 hard-requires libplacebo and libass, `scripts/build-media-stack.sh`
builds neither, and the script refuses to stage a binary linking libraries it
did not build from a pinned source. So the player falls back to a system mpv,
exactly as every release up to v0.0.6 did.

On macOS it is not even built. The default build is universal — `arm64` and
`x86_64`, fused with `lipo` — and the libplacebo and libass mpv would link come
from the build machine, which has them for one architecture only. There is
nothing to fuse the second half against, and a universal bundle cannot carry a
thin binary, so building it would only spend minutes on something the staging
step must then discard. `MEDIA_STACK_ARCHS=<native arch>` builds it anyway, for
anyone finishing the work below.

This file exists so the directory does. Git does not track empty directories,
and an `extraResources` entry whose `from:` does not resolve fails the build.

See `../../docs/MEDIA_LICENSING.md`, "Status", for what finishing mpv needs.
