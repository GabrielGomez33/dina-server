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
DUR=(); MOTION=(); CAPTION=(); VO=(); VO_OFFSET=(); IMG_PROMPT=(); REVEAL=()
# shellcheck disable=SC1090
source "$CONFIG"

N=${#DUR[@]}
[ "$N" -gt 0 ] || die "manifest defines no shots (DUR is empty)"
for arr in MOTION CAPTION; do
  eval "len=\${#$arr[@]}"
  [ "$len" -eq "$N" ] || die "manifest array $arr has $len entries, expected $N (= #DUR)"
done
# VO is OPTIONAL (a video can be music+visuals only). If present it must match N.
{ [ "${#VO[@]}" -eq 0 ] || [ "${#VO[@]}" -eq "$N" ]; } || die "VO has ${#VO[@]} entries, expected 0 or $N"
HAS_VO=0; for _v in "${VO[@]:-}"; do [ -n "$_v" ] && HAS_VO=1; done; [ -n "${VO_ENDCARD:-}" ] && HAS_VO=1

WORKDIR="${WORKDIR:-$SAGA_ROOT/tmp/$(basename "${CONFIG%.*}")}"
SHOTS_DIR="$WORKDIR/shots"; CLIPS_DIR="$WORKDIR/clips"; POST_DIR="$WORKDIR/post"
mkdir -p "$SHOTS_DIR" "$CLIPS_DIR" "$POST_DIR"
# framepack/flf render to $SAGA_ROOT/tmp/<OUT>.mp4, so the driver passes -o as a path RELATIVE to
# that (WORKREL/clipK) to land clips directly in the workdir. Requires workdir under $SAGA_ROOT/tmp.
WORKREL="${WORKDIR#"$SAGA_ROOT"/tmp/}"
[ "$WORKREL" = "$WORKDIR" ] && die "workdir must live under \$SAGA_ROOT/tmp (animation renders there); got $WORKDIR"

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

run(){ # echo (always) + execute (unless --plan); fail LOUD so a broken stage stops the driver
  echo "  \$ $*"
  [ "$PLAN" -eq 1 ] && return 0
  "$@" || die "stage command failed (exit $?): $*"
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
  kind=move; { [ -n "${REVEAL[k]:-}" ] || [ -f "$SHOTS_DIR/shot$((k+1))_end.png" ]; } && kind=reveal
  vo=""; [ "$HAS_VO" -eq 1 ] && vo="  VO@${VO_AT[k]}s"
  printf "    shot%d  %ss  %-6s scene@%ss%s  cap=%q\n" $((k+1)) "${DUR[k]}" "$kind" "${SCENE_START[k]}" "$vo" "${CAPTION[k]}"
done
vo=""; [ "$HAS_VO" -eq 1 ] && vo="  VO@${VO_ENDCARD_AT}s ${VO_ENDCARD}"
printf "    endcard %ss  scene@%ss%s\n" "$ENDCARD_SEC" "$ENDCARD_START" "$vo"

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
    kf="$SHOTS_DIR/shot$((k+1)).png"; endkf="$SHOTS_DIR/shot$((k+1))_end.png"
    # A beat is a REVEAL (before→after) if the manifest marks it OR an end-keyframe is present:
    # then Wan (saga-flf) interpolates shotK → shotK_end (the transformation — smudge appears/clears,
    # a bloom, a turn). Otherwise it's a single moving take (FramePack). Output lands in the workdir.
    reveal=0; { [ -n "${REVEAL[k]:-}" ] || [ -f "$endkf" ]; } && reveal=1
    if [ "$reveal" -eq 1 ]; then
      [ "$PLAN" -eq 1 ] || [ -f "$endkf" ] || die "reveal beat shot$((k+1)) needs an end keyframe: $endkf (make it with saga-flux --init)"
      echo "  shot$((k+1)): REVEAL (FLF shot$((k+1)).png → shot$((k+1))_end.png)"
      run bash "$HERE/saga-flf.sh" -a "$kf" -b "$endkf" -o "$WORKREL/clip$((k+1))" \
          -d "${DUR[k]}" -W "$VID_W" -H "$VID_H" -p "${MOTION[k]}" -n "$NEG"
    else
      run bash "$HERE/saga-framepack.sh" -a "$kf" -o "$WORKREL/clip$((k+1))" \
          -d "${DUR[k]}" -W "$VID_W" -H "$VID_H" --gpu-keep "$GPU_KEEP" "${TC[@]}" \
          -p "${MOTION[k]}" -n "$NEG"
    fi
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

# ---- AUDIO (optional): build the beat-placed VO timeline, render with Kokoro -
# VO is optional — a music+visuals video has empty VO lines, and this stage no-ops (no vo.wav,
# so assemble runs with music only). Fill the manifest's VO=() to narrate.
if want audio; then
  TL="$WORKDIR/vo.timeline"; : > "$TL"
  for ((k=0;k<N;k++)); do [ -n "${VO[k]:-}" ] && printf '%s|%s\n' "${VO_AT[k]}" "${VO[k]}" >> "$TL"; done
  [ -n "$VO_ENDCARD" ] && printf '%s|%s\n' "$VO_ENDCARD_AT" "$VO_ENDCARD" >> "$TL"
  if [ ! -s "$TL" ]; then
    echo "── audio: none (no VO lines — music+visuals video) ──"; rm -f "$WORKDIR/vo.wav"
  else
    echo "── audio (Kokoro $VOICE @${VOICE_SPEED}) ──"
    echo "  timeline → $TL:"; sed 's/^/    /' "$TL"
    run python "$HERE/saga-vo.py" --timeline -i "$TL" -o "$WORKDIR/vo.wav" --voice "$VOICE" --speed "$VOICE_SPEED" --total "$TOTAL"
  fi
fi

# ---- ASSEMBLE: scenes + captions + VO + music + end-card --------------------
if want assemble; then
  echo "── assemble ──"
  MAN="$WORKDIR/assemble.manifest"; : > "$MAN"
  for ((k=0;k<N;k++)); do printf '%s | %s | %s\n' "$POST_DIR/clip$((k+1))_post.mp4" "${DUR[k]}" "${CAPTION[k]}" >> "$MAN"; done
  echo "  manifest → $MAN:"; sed 's/^/    /' "$MAN"
  A=(); { [ -f "$WORKDIR/vo.wav" ] || { [ "$PLAN" -eq 1 ] && [ "$HAS_VO" -eq 1 ]; }; } && A=(-a "$WORKDIR/vo.wav")
  B=(); [ -n "$MUSIC" ] && { [ -f "$WORKDIR/$MUSIC" ] || [ "$PLAN" -eq 1 ]; } && B=(-b "$WORKDIR/$MUSIC" --music-db "$MUSIC_DB")
  run bash "$HERE/saga-assemble.sh" -m "$MAN" "${A[@]}" "${B[@]}" \
      -e "$WORKDIR/endcard.mp4" --endcard-sec "$ENDCARD_SEC" --xfade "$XFADE" -o "$WORKDIR/final.mp4"
  [ "$PLAN" -eq 0 ] && echo "✅ $WORKDIR/final.mp4"
fi

[ "$PLAN" -eq 1 ] && echo "（--plan: nothing executed）"
