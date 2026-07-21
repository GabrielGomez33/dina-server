#!/usr/bin/env bash
# ============================================================================
# saga-face-restore.sh — lock character identity across a VIDEO (fix Wan/FLF drift)
# ----------------------------------------------------------------------------
# Wan (FLF/I2V) does NOT use the LoRA, so the frames it invents drift the face into a
# stranger — "the random guy at the end". This re-renders the FACE region on each frame
# with the LoRA + trigger (composing saga-detail's FaceDetailer), so every frame carries
# YOUR identity. Single concern: per-frame face identity restoration. Frames with no
# detectable face (hands covering it) pass through untouched.
#
#   saga-face-restore.sh <in.mp4> --lora F --trigger T [--denoise 0.45] [--every 1]
#                        [-n NEG] [-o out.mp4]
#     --denoise  how hard to repaint the face (0.4–0.5 replaces a drifted face; lower = gentler)
#     --every    process every Nth frame (1 = all; 2 = half, faster but can flicker)
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
HERE="$(cd "$(dirname "$0")" && pwd)"; DTL="$HERE/saga-detail.sh"
IN=""; LORA=""; TRIGGER=""; DENOISE=0.45; EVERY=1; OUT=""; NEG=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --lora) LORA="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --denoise) DENOISE="$2"; shift 2;; --every) EVERY="$2"; shift 2;;
  -n|--neg) NEG="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,20p' "$0"; exit 0;;
  -*) die "unknown arg: $1";; *) IN="$1"; shift;;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need <input.mp4>"
[ -n "$LORA" ] || die "need --lora <file in models/loras>"
[ -n "$TRIGGER" ] || die "need --trigger <token>"
[ -x "$DTL" ] || die "not executable: $DTL"
command -v ffmpeg >/dev/null || die "ffmpeg required"; command -v ffprobe >/dev/null || die "ffprobe required"
case "$DENOISE" in ''|*[!0-9.]*) die "--denoise must be a number";; esac
case "$EVERY" in ''|*[!0-9]*) die "--every must be an integer";; esac; [ "$EVERY" -ge 1 ] || die "--every must be >= 1"
OUT="${OUT:-${IN%.*}_face.mp4}"

FR=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nk=1:nw=1 "$IN" 2>/dev/null | head -1)
FPS=$(awk -F/ 'NF==2 && $2>0{printf "%.4f",$1/$2} NF==1{print $1}' <<<"$FR"); [ -n "$FPS" ] || FPS=16
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/in" "$WORK/out"
ffmpeg -y -i "$IN" "$WORK/in/f%05d.png" >/dev/null 2>&1 || die "frame extract failed"
mapfile -t FRAMES < <(ls "$WORK/in"/*.png 2>/dev/null | sort)
[ "${#FRAMES[@]}" -gt 0 ] || die "no frames extracted from $IN"

echo "▶ face-restore ${#FRAMES[@]} frames @ ${FPS}fps  (every=$EVERY, denoise=$DENOISE, lora=$LORA)" >&2
i=0; fixed=0; kept=0
for f in "${FRAMES[@]}"; do
  i=$((i+1)); dst="$WORK/out/$(basename "$f")"
  if [ $(( (i-1) % EVERY )) -eq 0 ]; then
    nm="facerst_$$_$i"; a=(--image "$f" --detect face --lora "$LORA" --trigger "$TRIGGER" --denoise "$DENOISE" -o "$nm")
    [ -n "$NEG" ] && a+=(-n "$NEG")
    if "$DTL" "${a[@]}" >/dev/null 2>&1 && [ -s "$SAGA_ROOT/tmp/$nm.png" ]; then
      mv -f "$SAGA_ROOT/tmp/$nm.png" "$dst"; fixed=$((fixed+1))
    else
      cp -f "$f" "$dst"; kept=$((kept+1))   # detail failed / no face → keep original (no gap)
    fi
  else
    cp -f "$f" "$dst"; kept=$((kept+1))
  fi
  [ $(( i % 20 )) -eq 0 ] && echo "  …$i/${#FRAMES[@]}" >&2
done
ffmpeg -y -framerate "$FPS" -i "$WORK/out/f%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 || die "reassemble failed"
echo "✅ $OUT  (face re-rendered on $fixed frames, $kept passed through)" >&2
echo "$OUT"
