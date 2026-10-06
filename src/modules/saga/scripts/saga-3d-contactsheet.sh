#!/usr/bin/env bash
# ============================================================================
# saga-3d-contactsheet.sh — ONE command on the pod that produces a single image
# (or a few) showing every pose from multiple angles, so review is one paste.
#
# Does: source pod-init (sync scripts + GL) → find newest rigged/reskinned mesh →
# mesh-health check → render each pose at 1024 (clay, corrective-smooth on) from
# front/side/3q → montage each pose's 3 views into one row → tile all rows into
# ALL.png. Paste ALL.png (or the SHEET_*.png) back for review.
#
# Usage (on the pod):
#   bash $SAGA_ROOT/scripts/saga-3d-contactsheet.sh
#   bash $SAGA_ROOT/scripts/saga-3d-contactsheet.sh /path/to/mesh.glb "punch kick karate"
#   SMOOTH=0.65 SUBSURF=0 RES=1024 bash .../saga-3d-contactsheet.sh    # tune via env
# ============================================================================
set -uo pipefail

export SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
# always init first (restores GL libs, blender symlink, and git-syncs latest scripts)
if [ -f "$SAGA_ROOT/scripts/saga-pod-init.sh" ]; then
  # shellcheck disable=SC1091
  source "$SAGA_ROOT/scripts/saga-pod-init.sh"
fi

GLB="${1:-}"
[ -z "$GLB" ] && GLB="$(ls -t "$SAGA_ROOT"/*reskinned*.glb "$SAGA_ROOT"/*rigged*.glb 2>/dev/null | head -1)"
POSES="${2:-rest arms_down punch kick karate karate_stance meditate ninja_run jump}"
RES="${RES:-1024}"
SMOOTH="${SMOOTH:-0.65}"
SUBSURF="${SUBSURF:-0}"
OUT="$SAGA_ROOT/contact"
PR="$SAGA_ROOT/scripts/saga-3d-pose-render.py"
MC="$SAGA_ROOT/scripts/saga-3d-meshcheck.py"

if [ -z "$GLB" ] || [ ! -f "$GLB" ]; then
  echo "❌ no mesh found (looked for *reskinned*.glb / *rigged*.glb in $SAGA_ROOT). Pass one as arg 1." >&2
  exit 1
fi
command -v blender >/dev/null 2>&1 || { echo "❌ blender not on PATH (pod-init failed?)" >&2; exit 1; }

echo "====================================================================="
echo " mesh : $GLB"
echo " poses: $POSES"
echo " res=$RES  smooth-deform=$SMOOTH  subsurf=$SUBSURF"
echo "====================================================================="

echo; echo "### MESH HEALTH ###"
blender -b -P "$MC" -- --in "$GLB" 2>&1 | sed -n '/===/,$p'

rm -rf "$OUT"; mkdir -p "$OUT"
HAVE_MONTAGE=0; command -v montage >/dev/null 2>&1 && HAVE_MONTAGE=1
[ "$HAVE_MONTAGE" = 0 ] && echo "ℹ imagemagick 'montage' not found — will leave individual PNGs (no contact sheet)."

for p in $POSES; do
  echo; echo "### POSE: $p ###"
  blender -b -P "$PR" -- --in "$GLB" --out "$OUT" --pose "$p" \
      --cams front,side_l,3q_r --passes clay --res "$RES" \
      --smooth-deform "$SMOOTH" --subsurf "$SUBSURF" 2>&1 | tail -3
  if [ "$HAVE_MONTAGE" = 1 ]; then
    f="$OUT/${p}_front_clay.png"; s="$OUT/${p}_side_l_clay.png"; q="$OUT/${p}_3q_r_clay.png"
    [ -f "$f" ] && [ -f "$s" ] && [ -f "$q" ] && \
      montage "$f" "$s" "$q" -tile 3x1 -geometry +4+4 -background '#3a3a3f' \
        -title "$p" "$OUT/SHEET_${p}.png" 2>/dev/null
  fi
done

if [ "$HAVE_MONTAGE" = 1 ] && ls "$OUT"/SHEET_*.png >/dev/null 2>&1; then
  # tile every pose-row into one (or a couple) master sheets; 2 rows per image keeps it readable
  montage "$OUT"/SHEET_*.png -tile 1x -geometry +0+8 -background '#2a2a2e' "$OUT/ALL.png" 2>/dev/null
  echo; echo "✅ DONE — paste $OUT/ALL.png (one image, all poses). Per-pose rows: $OUT/SHEET_*.png"
else
  echo; echo "✅ DONE — individual renders in $OUT/*.png (install imagemagick for a single contact sheet: apt-get install -y imagemagick)"
fi
ls -1 "$OUT"/ALL.png "$OUT"/SHEET_*.png 2>/dev/null || ls -1 "$OUT"/*.png
