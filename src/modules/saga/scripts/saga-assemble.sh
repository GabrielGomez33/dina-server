#!/usr/bin/env bash
# saga-assemble.sh — Mirror video ASSEMBLER (the ffmpeg pipeline that ships a post).
# ============================================================================
# The reusable last stage of the self-hosted Mirror content pipeline:
#     image -> video -> audio -> ASSEMBLE (here).
# Takes per-scene visuals + narration + optional music + burned captions + the
# shared end-card, and produces ONE vertical 1080x1920 mp4 ready to post.
# No ElevenLabs, no GUI timeline — a script, driven by a plain-text manifest.
#
# MANIFEST (-m): one scene per line, pipe-delimited:
#     visual | seconds | caption text
#   visual  : a clip (.mp4/.mov/.webm) OR a still (.png/.jpg/.webp). Stills are
#             held for the duration; clips are looped/trimmed to it. Either is
#             scaled to COVER 1080x1920. So you can assemble from stills now and
#             swap in animated clips later — same manifest.
#   seconds : how long the scene shows.
#   caption : on-screen text, burned bottom-center (leave empty for none).
#   Blank lines and lines starting with # are ignored.
#
# USAGE:
#   saga-assemble.sh -m vid1.man -a vid1_vo.wav -e endcard.png -o vid1.mp4 \
#       [-b music.mp3] [--music-db -18] [-W 1080 -H 1920] \
#       [--font /path/to.ttf] [--endcard-sec 2] [--xfade 0.7]
#
#   --xfade SEC : dissolve between scenes instead of hard cuts → one CONTINUOUS film
#     (the calm-brand look: no hard cuts). Each scene keeps its caption; captions
#     cross-dissolve with their shot. Final length shrinks by (scenes-1)*SEC. 0 = hard cuts.
#
# VERIFY-LIVE: shake out on the pod with real assets; tune caption placement/size
# and the music duck (-18 dB default) to taste.
# ============================================================================
set -uo pipefail

W=1080; H=1920; MUSIC=""; MUSIC_DB=-18; ENDCARD=""; ENDCARD_SEC=2; XF=0
FONT="${SAGA_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"
MAN=""; VO=""; OUT=""
die(){ echo "❌ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do case "$1" in
  -m) MAN="$2"; shift 2;;  -a) VO="$2"; shift 2;;  -b) MUSIC="$2"; shift 2;;
  -e) ENDCARD="$2"; shift 2;;  -o) OUT="$2"; shift 2;;
  -W) W="$2"; shift 2;;  -H) H="$2"; shift 2;;
  --music-db) MUSIC_DB="$2"; shift 2;;  --font) FONT="$2"; shift 2;;
  --endcard-sec) ENDCARD_SEC="$2"; shift 2;;  --xfade) XF="$2"; shift 2;;
  -h|--help) sed -n '2,40p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$MAN" ] && [ -f "$MAN" ] || die "need -m <manifest>"
[ -n "$OUT" ] || die "need -o <output.mp4>"
command -v ffmpeg  >/dev/null || die "ffmpeg required (apt-get install -y ffmpeg)"
command -v ffprobe >/dev/null || die "ffprobe required"
[ -f "$FONT" ] || die "font not found: $FONT — apt-get install -y fonts-dejavu-core, or pass --font"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
COVER="scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1"
FS=$((W/18))          # caption font size ~ frame width / 18
BB=$((W/45))          # caption box padding
LIST="$WORK/list.txt"; : > "$LIST"; SCENES=(); DURS=()

norm(){ # <visual> <seconds> <caption> <outfile>
  local vis="$1" secs="$2" cap="$3" out="$4" vf="$COVER" ins=()
  case "${vis,,}" in
    *.png|*.jpg|*.jpeg|*.webp|*.bmp) ins=(-loop 1 -i "$vis");;
    *)                               ins=(-stream_loop -1 -i "$vis");;
  esac
  if [ -n "$cap" ]; then
    local cf="$WORK/cap_$(basename "$out").txt"; printf '%s' "$cap" > "$cf"
    vf="$vf,drawtext=fontfile=${FONT}:textfile=${cf}:fontcolor=white:fontsize=${FS}:x=(w-tw)/2:y=h*0.80:box=1:boxcolor=black@0.35:boxborderw=${BB}:line_spacing=10"
  fi
  ffmpeg -y "${ins[@]}" -t "$secs" -an -vf "$vf" -r 30 -pix_fmt yuv420p \
    -c:v libx264 -preset veryfast -crf 18 "$out" >/dev/null 2>&1 || die "scene render failed: $vis"
}

i=0
while IFS='|' read -r vis secs cap || [ -n "$vis" ]; do
  vis="$(echo "${vis:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  secs="$(echo "${secs:-}" | tr -dc '0-9.')"
  cap="$(echo "${cap:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$vis" ] && continue; case "$vis" in \#*) continue;; esac
  [ -f "$vis" ] || die "visual not found: $vis"
  [ -n "$secs" ] || die "missing seconds for: $vis"
  out="$WORK/scene_$(printf '%03d' "$i").mp4"
  norm "$vis" "$secs" "$cap" "$out"
  echo "file '$out'" >> "$LIST"; SCENES+=("$out"); DURS+=("$secs")
  echo "  scene $i: $(basename "$vis")  ${secs}s${cap:+  \"$cap\"}"
  i=$((i+1))
done < "$MAN"
[ "$i" -gt 0 ] || die "no scenes parsed from manifest"

if [ -n "$ENDCARD" ]; then
  [ -f "$ENDCARD" ] || die "endcard not found: $ENDCARD"
  ec="$WORK/scene_zzz.mp4"; norm "$ENDCARD" "$ENDCARD_SEC" "" "$ec"
  echo "file '$ec'" >> "$LIST"; SCENES+=("$ec"); DURS+=("$ENDCARD_SEC")
  echo "  end-card: $(basename "$ENDCARD")  ${ENDCARD_SEC}s"
fi

BODY="$WORK/body.mp4"
XF_ON=$(awk -v x="$XF" 'BEGIN{print (x+0>0)?1:0}')
if [ "$XF_ON" = "1" ] && [ "${#SCENES[@]}" -ge 2 ]; then
  # Continuous film: dissolve each scene into the next (xfade) instead of hard-cutting.
  # xfade offset for the k-th dissolve = sum(durations before scene k) - k*XF. Every scene keeps
  # its own burned caption, so captions cross-dissolve with their shot. Final duration shrinks by
  # (n-1)*XF (each dissolve overlaps two scenes) — the muxed audio is trimmed to the real length.
  n=${#SCENES[@]}; args=(); for f in "${SCENES[@]}"; do args+=(-i "$f"); done
  running="[0:v]"; sumd="${DURS[0]}"; fc=""
  for ((k=1;k<n;k++)); do
    off=$(awk -v s="$sumd" -v x="$XF" -v kk="$k" 'BEGIN{printf "%.3f", s-kk*x}')
    lbl="[x${k}]"; [ "$k" -eq $((n-1)) ] && lbl="[vout]"
    fc+="${running}[${k}:v]xfade=transition=fade:duration=${XF}:offset=${off}${lbl};"
    running="$lbl"; sumd=$(awk -v a="$sumd" -v b="${DURS[k]}" 'BEGIN{printf "%.3f", a+b}')
  done
  fc="${fc%;}"
  ffmpeg -y "${args[@]}" -filter_complex "$fc" -map "[vout]" -r 30 -pix_fmt yuv420p \
    -c:v libx264 -preset veryfast -crf 18 "$BODY" >/dev/null 2>&1 \
    || die "xfade assembly failed (check scene sizes/fps are uniform)"
  echo "  transition: xfade ${XF}s dissolves (continuous)"
else
  ffmpeg -y -f concat -safe 0 -i "$LIST" -c copy "$BODY" >/dev/null 2>&1 \
    || ffmpeg -y -f concat -safe 0 -i "$LIST" -c:v libx264 -crf 18 -pix_fmt yuv420p "$BODY" >/dev/null 2>&1 \
    || die "concat failed"
fi
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BODY")"

if [ -n "$VO" ] && [ -f "$VO" ]; then
  if [ -n "$MUSIC" ] && [ -f "$MUSIC" ]; then
    ffmpeg -y -i "$BODY" -i "$VO" -stream_loop -1 -i "$MUSIC" \
      -filter_complex "[2:a]volume=${MUSIC_DB}dB[m];[1:a][m]amix=inputs=2:duration=longest:dropout_transition=0[a]" \
      -map 0:v -map "[a]" -t "$DUR" -c:v copy -c:a aac -b:a 192k "$OUT" >/dev/null 2>&1 || die "mux (video+VO+music) failed"
  else
    ffmpeg -y -i "$BODY" -i "$VO" -map 0:v -map 1:a -t "$DUR" -c:v copy -c:a aac -b:a 192k "$OUT" >/dev/null 2>&1 || die "mux (video+VO) failed"
  fi
else
  cp "$BODY" "$OUT"
fi

echo "✅ assembled → $OUT  (${W}x${H}, ${i} scenes$([ -n "$ENDCARD" ] && echo ' + end-card'), ${DUR}s)"
