#!/usr/bin/env bash
# ============================================================================
# saga-endcard.sh — the shared Mirror brand END-CARD as a flickering old-film clip.
# ----------------------------------------------------------------------------
# ONE reusable end-card appended to every Mirror video. TWO ways to make it:
#
#   1) FROM A DESIGNED STILL (preferred — use the real brand art):
#        saga-endcard.sh --image endcard_src.png -o endcard.mp4 [-d 2.5]
#      The still is scaled to COVER the frame and given the old-film MOTION —
#      brightness flicker + live moving grain + subtle gate weave + vignette —
#      so a static card becomes flickering aged film. The art itself is untouched.
#
#   2) GENERATED from the wordmark (fallback when there is no art):
#        saga-endcard.sh -o endcard.mp4 [--wordmark "M I Я Я O R"] [--url trymirror.world]
#      Draws the official wordmark (from mirror-sakura.svg — the two middle R's are
#      mirrored, the brand motif) over aged burgundy, same old-film finish.
#
#   Common: [-W 1080 -H 1920] [--fps 30] [--bg 0x2a0d15] [--ink 0xe8557c] [--sub 0xd9a7b0]
#
# Flicker is subtle by design — aged, not strobing. Output mp4 is appended by the
# assembler via -e (it accepts a video end-card and will dissolve into it with --xfade).
# Env: none required (pure ffmpeg). Fonts: DejaVu (mono for the wordmark).
# ============================================================================
set -uo pipefail
OUT="endcard.mp4"; DUR=2.5; URL="trymirror.world"; W=1080; H=1920; FPS=30; IMG=""
WORDMARK="M I Я Я O R"; BG="0x2a0d15"; INK="0xe8557c"; SUB="0xd9a7b0"
FONT_MONO="${SAGA_FONT_MONO:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf}"
FONT_SANS="${SAGA_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;  -d|--duration) DUR="$2"; shift 2;;
  --image) IMG="$2"; shift 2;;
  --url) URL="$2"; shift 2;;  -W|--width) W="$2"; shift 2;;  -H|--height) H="$2"; shift 2;;
  --fps) FPS="$2"; shift 2;;  --wordmark) WORDMARK="$2"; shift 2;;
  --bg) BG="$2"; shift 2;;  --ink) INK="$2"; shift 2;;  --sub) SUB="$2"; shift 2;;
  -h|--help) sed -n '2,26p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
command -v ffmpeg >/dev/null || die "ffmpeg required"

# ---- the shared old-film MOTION finish (applied in both modes) --------------
# gate weave: scale 3% over, then crop back with a slow per-frame sub-pixel offset (film gate wobble)
# noise:      live grain (allf=t → fresh each frame, so it MOVES)
# eq flicker: brightness wobble from summed sines, eval=frame (the "flicker")
COVER="scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1"
WEAVE="scale=iw*1.03:ih*1.03,crop=${W}:${H}:x='(iw-ow)/2+2.5*sin(2*PI*t*1.7)':y='(ih-oh)/2+3.5*sin(2*PI*t*1.1)'"
FILM_LIGHT="${WEAVE},vignette=PI/5,noise=alls=11:allf=t,eq=eval=frame:contrast=1.03:brightness='0.018*sin(2*PI*t*8)+0.011*sin(2*PI*t*21)+0.007*sin(2*PI*t*44)'"
FILM_HEAVY="vignette=PI/4,noise=alls=20:allf=t+u,eq=eval=frame:contrast=1.06:brightness='0.020*sin(2*PI*t*9)+0.012*sin(2*PI*t*23)+0.008*sin(2*PI*t*47)'"

if [ -n "$IMG" ]; then
  # --- mode 1: animate a designed still into flickering old film ---
  [ -f "$IMG" ] || die "end-card image not found: $IMG"
  VF="${COVER},format=yuv420p,${FILM_LIGHT}"
  echo "▶ endcard: $(basename "$IMG") → old-film flicker  ${W}x${H} ${DUR}s @ ${FPS}fps" >&2
  ffmpeg -y -loop 1 -t "$DUR" -i "$IMG" -vf "$VF" -r "$FPS" -pix_fmt yuv420p \
    -c:v libx264 -preset veryfast -crf 18 "$OUT" >/dev/null 2>&1 \
    || die "endcard render failed (check the image path / that ffmpeg supports eq eval=frame)"
else
  # --- mode 2: generate from the wordmark ---
  [ -f "$FONT_MONO" ] || FONT_MONO="$FONT_SANS"
  [ -f "$FONT_SANS" ] || die "font not found: $FONT_SANS (apt-get install -y fonts-dejavu-core)"
  URLSP=$(printf '%s' "$URL" | sed 's/./& /g; s/ $//')      # letter-space the URL
  WM_FS=$((W*100/720)); URL_FS=$((W*44/1080))
  VF="format=yuv420p,\
drawtext=fontfile=${FONT_MONO}:text='${WORDMARK}':fontcolor=${INK}:fontsize=${WM_FS}:x=(w-tw)/2:y=(h-th)/2-60,\
drawtext=fontfile=${FONT_MONO}:text='${URLSP}':fontcolor=${SUB}:fontsize=${URL_FS}:x=(w-tw)/2:y=(h/2)+130,\
${FILM_HEAVY}"
  echo "▶ endcard: '$WORDMARK' + $URL (generated)  ${W}x${H} ${DUR}s @ ${FPS}fps" >&2
  ffmpeg -y -f lavfi -i "color=c=${BG}:s=${W}x${H}:d=${DUR}:r=${FPS}" \
    -vf "$VF" -r "$FPS" -pix_fmt yuv420p -c:v libx264 -preset veryfast -crf 18 "$OUT" >/dev/null 2>&1 \
    || die "endcard render failed (check ffmpeg supports eq eval=frame; UTF-8 wordmark)"
fi
echo "✅ $OUT" >&2
echo "$OUT"
