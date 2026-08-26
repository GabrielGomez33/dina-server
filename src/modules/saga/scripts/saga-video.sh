#!/usr/bin/env bash
# ============================================================================
# saga-video.sh — one-command video driver for the SAGA pipeline.
# ----------------------------------------------------------------------------
# Reads ONE manifest describing a whole video and runs the mechanical downstream
# stages in order, with review gates between them:
#
#     [you curate keyframes] -> ANIMATE -> POST -> END-CARD -> AUDIO -> ASSEMBLE
#
# Keyframe CURATION stays human (the taste checkpoint): you generate candidates,
# pick the on-model ones, and place them as <workdir>/shots/shot1..N.png. The driver
# validates they exist, then automates everything after. VO offsets are auto-computed
# from the shot durations + xfade (scene starts + a small lead) so you don't hand-calc.
#
# USAGE:
#   saga-video.sh -c vid3.video [--workdir DIR] [--stage animate|post|endcard|audio|assemble|all]
#                 [--from STAGE] [--plan] [--yes]
#     -c/--config   the video manifest (a sourced bash file — see vid3.video)
#     --workdir     where assets/outputs live (default: $SAGA_ROOT/tmp/<config-basename>)
#     --stage NAME  run only this stage (default: all)
#     --from STAGE  run this stage and everything after it (resume)
#     --plan        DRY RUN: print the computed plan + every command, run nothing
#     --yes         skip the review gates (unattended)
#
# Depends on the sibling stage scripts: saga-framepack.sh, saga-grade.sh,
# saga-endcard.sh, saga-vo.py, saga-assemble.sh. Env: SAGA_ROOT (+ ComfyUI up for animate).
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT (source saga-env.sh)}"
HERE="$(cd "$(dirname "$0")" && pwd)"

CONFIG=""; WORKDIR=""; STAGE="all"; FROM=""; PLAN=0; YES=0
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  -c|--config) CONFIG="$2"; shift 2;;  --workdir) WORKDIR="$2"; shift 2;;
  --stage) STAGE="$2"; shift 2;;  --from) FROM="$2"; shift 2;;
  --plan) PLAN=1; shift;;  --yes) YES=1; shift;;
  -h|--help) sed -n '2,32p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$CONFIG" ] && [ -f "$CONFIG" ] || die "need -c <manifest> (a .video file)"

# ---- manifest defaults, then source it (it sets the arrays + overrides) -----
TITLE="untitled"; LORA=""; LORA_STR=0.9; GUIDANCE=3.5; STEPS=28
VID_W=640; VID_H=1120; FPS=30; GPU_KEEP=8; TEACACHE=0
GRADE="soft-heavy"; UPSCALE=1920; XFADE=0.7
ENDCARD_IMG="endcard_src.png"; ENDCARD_SEC=2.5
MUSIC=""; MUSIC_DB=-18; VOICE="af_heart"; VOICE_SPEED=0.9; VO_LEAD=0.2; VO_ENDCARD=""
NEG="human, person, human legs, walking, articulated fingers, fast motion, camera pan, zoom, morphing, warping, text, watermark, extra limbs"
DUR=(); MOTION=(); CAPTION=(); VO=(); VO_OFFSET=(); IMG_PROMPT=()
# shellcheck disable=SC1090
source "$CONFIG"

N=${#DUR[@]}
[ "$N" -gt 0 ] || die "manifest defines no shots (DUR is empty)"
for arr in MOTION CAPTION VO; do
  eval "len=\${#$arr[@]}"
  [ "$len" -eq "$N" ] || die "manifest array $arr has $len entries, expected $N (= #DUR)"
done

WORKDIR="${WORKDIR:-$SAGA_ROOT/tmp/$(basename "${CONFIG%.*}")}"
SHOTS_DIR="$WORKDIR/shots"; CLIPS_DIR="$WORKDIR/clips"; POST_DIR="$WORKDIR/post"
mkdir -p "$SHOTS_DIR" "$CLIPS_DIR" "$POST_DIR"

# ---- compute the xfade timeline: scene starts + auto VO offsets -------------
# scene_start[k] = sum(DUR[0..k-1]) - k*XFADE ; endcard start = sum(all DUR) - N*XFADE
declare -a SCENE_START VO_AT
sumd=0
for ((k=0;k<N;k++)); do
  SCENE_START[k]=$(awk -v s="$sumd" -v x="$XFADE" -v k="$k" 'BEGIN{v=s-k*x; if(v<0)v=0; printf "%.2f", v}')
  sumd=$(awk -v a="$sumd" -v b="${DUR[k]}" 'BEGIN{printf "%.3f", a+b}')
done
ENDCARD_START=$(awk -v s="$sumd" -v x="$XFADE" -v n="$N" 'BEGIN{printf "%.2f", s-n*x}')
TOTAL=$(awk -v s="$ENDCARD_START" -v e="$ENDCARD_SEC" 'BEGIN{printf "%.2f", s+e}')
for ((k=0;k<N;k++)); do
  if [ -n "${VO_OFFSET[k]:-}" ]; then VO_AT[k]="${VO_OFFSET[k]}"
  else VO_AT[k]=$(awk -v s="${SCENE_START[k]}" -v l="$VO_LEAD" 'BEGIN{printf "%.2f", s+l}'); fi
done
VO_ENDCARD_AT=$(awk -v s="$ENDCARD_START" -v l="$VO_LEAD" 'BEGIN{printf "%.2f", s+l}')

run(){ # echo (always) + execute (unless --plan)
  echo "  \$ $*"
  [ "$PLAN" -eq 1 ] && return 0
  "$@"
}
gate(){ # review pause between stages
  [ "$PLAN" -eq 1 ] && return 0
  [ "$YES" -eq 1 ] && return 0
  printf "  ↳ review %s in %s, then Enter to continue (Ctrl-C to stop)… " "$1" "$WORKDIR" >&2
  read -r _
}
want(){ # should we run stage $1 ? honors --stage / --from
  local s="$1"
  if [ -n "$FROM" ]; then
    local order="animate post endcard audio assemble" seen=0 x
    for x in $order; do [ "$x" = "$FROM" ] && seen=1; [ "$x" = "$s" ] && { [ "$seen" -eq 1 ] && return 0 || return 1; }; done
    return 1
  fi
  [ "$STAGE" = "all" ] || [ "$STAGE" = "$s" ]
}

echo "▶ saga-video: $TITLE  ($N shots, xfade ${XFADE}s → ${TOTAL}s)  workdir=$WORKDIR"
echo "  timeline:"
for ((k=0;k<N;k++)); do
  printf "    shot%d  %ss  scene@%ss  VO@%ss  cap=%q\n" $((k+1)) "${DUR[k]}" "${SCENE_START[k]}" "${VO_AT[k]}" "${CAPTION[k]}"
done
printf "    endcard %ss  scene@%ss  VO@%ss %q\n" "$ENDCARD_SEC" "$ENDCARD_START" "$VO_ENDCARD_AT" "${VO_ENDCARD:-（none）}"

# ---- ANIMATE: curated keyframe -> FramePack clip ----------------------------
if want animate; then
  echo "── animate ──"
  miss=0; for ((k=1;k<=N;k++)); do [ -f "$SHOTS_DIR/shot$k.png" ] || { echo "  ✗ missing curated keyframe: $SHOTS_DIR/shot$k.png" >&2; miss=1; }; done
  if [ "$miss" -ne 0 ]; then
    [ "$PLAN" -eq 1 ] && echo "  (plan: place your picked keyframes as shots/shot1..$N.png before a real run)" >&2 \
      || die "place your picked keyframes as shots/shot1..$N.png first (curation is manual by design)"
  fi
  TC=(--no-teacache); awk -v t="$TEACACHE" 'BEGIN{exit !(t+0>0)}' && TC=(--teacache "$TEACACHE")
  for ((k=0;k<N;k++)); do
    run bash "$HERE/saga-framepack.sh" -a "$SHOTS_DIR/shot$((k+1)).png" -o "$WORKDIR/clip$((k+1))" \
        -d "${DUR[k]}" -W "$VID_W" -H "$VID_H" --gpu-keep "$GPU_KEEP" "${TC[@]}" \
        -p "${MOTION[k]}" -n "$NEG"
  done
  gate "the animated clips (clip1..$N.mp4)"
fi

# ---- POST: upscale + grade (one pass) ---------------------------------------
if want post; then
  echo "── post (upscale+grade $GRADE @ ${UPSCALE}px) ──"
  for ((k=1;k<=N;k++)); do
    run bash "$HERE/saga-grade.sh" "$WORKDIR/clip$k.mp4" --preset "$GRADE" --upscale "$UPSCALE" -o "$POST_DIR/clip${k}_post.mp4"
  done
  gate "the graded clips (post/clip*_post.mp4)"
fi

# ---- END-CARD: brand art -> flickering old film -----------------------------
if want endcard; then
  echo "── end-card ──"
  run bash "$HERE/saga-endcard.sh" --image "$WORKDIR/$ENDCARD_IMG" -d "$ENDCARD_SEC" -o "$WORKDIR/endcard.mp4"
fi

# ---- AUDIO: build the beat-placed VO timeline, render with Kokoro -----------
if want audio; then
  echo "── audio (Kokoro $VOICE @${VOICE_SPEED}) ──"
  TL="$WORKDIR/vo.timeline"; : > "$TL"
  for ((k=0;k<N;k++)); do [ -n "${VO[k]}" ] && printf '%s|%s\n' "${VO_AT[k]}" "${VO[k]}" >> "$TL"; done
  [ -n "$VO_ENDCARD" ] && printf '%s|%s\n' "$VO_ENDCARD_AT" "$VO_ENDCARD" >> "$TL"
  echo "  timeline → $TL:"; sed 's/^/    /' "$TL"
  run python "$HERE/saga-vo.py" --timeline -i "$TL" -o "$WORKDIR/vo.wav" --voice "$VOICE" --speed "$VOICE_SPEED" --total "$TOTAL"
fi

# ---- ASSEMBLE: scenes + captions + VO + music + end-card --------------------
if want assemble; then
  echo "── assemble ──"
  MAN="$WORKDIR/assemble.manifest"; : > "$MAN"
  for ((k=0;k<N;k++)); do printf '%s | %s | %s\n' "$POST_DIR/clip$((k+1))_post.mp4" "${DUR[k]}" "${CAPTION[k]}" >> "$MAN"; done
  echo "  manifest → $MAN:"; sed 's/^/    /' "$MAN"
  A=(); { [ -f "$WORKDIR/vo.wav" ] || [ "$PLAN" -eq 1 ]; } && A=(-a "$WORKDIR/vo.wav")
  B=(); [ -n "$MUSIC" ] && { [ -f "$WORKDIR/$MUSIC" ] || [ "$PLAN" -eq 1 ]; } && B=(-b "$WORKDIR/$MUSIC" --music-db "$MUSIC_DB")
  run bash "$HERE/saga-assemble.sh" -m "$MAN" "${A[@]}" "${B[@]}" \
      -e "$WORKDIR/endcard.mp4" --endcard-sec "$ENDCARD_SEC" --xfade "$XFADE" -o "$WORKDIR/final.mp4"
  [ "$PLAN" -eq 0 ] && echo "✅ $WORKDIR/final.mp4"
fi

[ "$PLAN" -eq 1 ] && echo "（--plan: nothing executed）"
