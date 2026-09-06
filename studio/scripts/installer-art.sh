#!/bin/sh
# Draws the installer art from build/icon.png, so it can be redrawn rather than
# re-found when the mark changes. Needs ImageMagick 7 (`magick`) and the macOS
# system fonts it names; run from studio/.
#
#   build/installerSidebar.bmp   164×314, 24-bit — NSIS welcome and finish pages
#   build/installerHeader.bmp    150×57,  24-bit — NSIS header on every other page
#   build/dmg-background.png     660×400 (+@2x)  — the macOS disk image window
#
# NSIS reads only uncompressed 24-bit BMP3; an alpha channel or a BMP4 header
# renders as a black rectangle, hence `-type TrueColor` and the `BMP3:` prefix.
set -eu
cd "$(dirname "$0")/.."

BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REGULAR="/System/Library/Fonts/Supplemental/Arial.ttf"
# From src/styles/tokens.css: the app's sunken surface, its inline-code ink, and
# the brand green. The wizard is the first surface a person sees, so it wears
# the same palette as the window that opens after it.
INK="#f0f0f0"
MUTED="#a3a3a3"
ACCENT="#00bf63"
SURFACE="#151515"

# ── NSIS sidebar ────────────────────────────────────────────────────────────
magick -size 164x314 gradient:"#1c1c1c-#0d0d0d" \
  \( build/icon.png -resize 84x84 \) -gravity North -geometry +0+40 -composite \
  -gravity North -font "$BOLD" -pointsize 17 -fill "$INK" -annotate +0+142 "Teminali OS" \
  -font "$REGULAR" -pointsize 10 -fill "$MUTED" -annotate +0+166 "Autonomous AI Studio" \
  -fill "$ACCENT" -draw "line 70,198 94,198" \
  -font "$REGULAR" -pointsize 9 -fill "$MUTED" -interline-spacing 3 \
  -annotate +0+214 "Plan · edit · run · verify\nRecord · cut · ship" \
  -alpha off -type TrueColor BMP3:build/installerSidebar.bmp

# ── NSIS header ─────────────────────────────────────────────────────────────
magick -size 150x57 xc:"$SURFACE" \
  \( build/icon.png -resize 30x30 \) -gravity West -geometry +12+0 -composite \
  -gravity West -font "$BOLD" -pointsize 13 -fill "$INK" -annotate +50+0 "Teminali OS" \
  -alpha off -type TrueColor BMP3:build/installerHeader.bmp

# ── DMG background ──────────────────────────────────────────────────────────
# Light, because Finder draws icon labels in black on a disk image and a dark
# ground would swallow them. The two icons sit at (180,190) and (480,190) —
# the `dmg.contents` coordinates in electron-builder.yml — with the arrow
# between them.
draw_dmg() { # $1 = scale
  s=$1
  magick -size $((660*s))x$((400*s)) xc:"#F5F6FA" \
    \( build/icon.png -resize $((28*s))x$((28*s)) \) -gravity NorthWest -geometry +$((28*s))+$((26*s)) -composite \
    -gravity NorthWest -font "$BOLD" -pointsize $((15*s)) -fill "#1c1c1c" -annotate +$((64*s))+$((30*s)) "Teminali OS" \
    -font "$REGULAR" -pointsize $((10*s)) -fill "#6f6f6f" -annotate +$((64*s))+$((49*s)) "Autonomous AI Studio" \
    -stroke "$ACCENT" -strokewidth $((3*s)) -fill none -draw "line $((276*s)),$((190*s)) $((368*s)),$((190*s))" \
    -stroke none -fill "$ACCENT" -draw "polygon $((366*s)),$((176*s)) $((390*s)),$((190*s)) $((366*s)),$((204*s))" \
    -gravity North -font "$BOLD" -pointsize $((15*s)) -fill "#1c1c1c" \
    -annotate +0+$((300*s)) "Drag Teminali OS into Applications" \
    -font "$REGULAR" -pointsize $((11*s)) -fill "#6f6f6f" \
    -annotate +0+$((324*s)) "The first launch asks macOS to trust the app. The download page shows the two clicks." \
    "$2"
}
draw_dmg 1 build/dmg-background.png
draw_dmg 2 build/dmg-background@2x.png

for f in build/installerSidebar.bmp build/installerHeader.bmp build/dmg-background.png build/dmg-background@2x.png; do
  printf '%s  ' "$f"; magick identify -format "%wx%h %[bit-depth]-bit %m\n" "$f"
done
