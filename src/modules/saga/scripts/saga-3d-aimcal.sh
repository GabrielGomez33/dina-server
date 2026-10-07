#!/usr/bin/env bash
# ============================================================================
# saga-3d-aimcal.sh — AIM CALIBRATION. Shows exactly how a bone responds when its
# head→tail is aimed at each of the 6 world directions, so pose vectors can be
# AUTHORED from measurement instead of guessed. Also dumps the rig hierarchy.
#
# World frame used by _aim(): +X=char-right, -Y=forward/face, +Z=up.
# For each bone it renders rest+aim(bone,dir) for Xr,Xl,Yf,Yb,Zu,Zd (front+side)
# and montages into ALL_aimcal_<bone>.png.
#
# Usage (on the pod):
#   bash $SAGA_ROOT/scripts/saga-3d-aimcal.sh                 # bone_6 (R shoulder) + bone_20 (R hip)
#   bash $SAGA_ROOT/scripts/saga-3d-aimcal.sh bone_6 bone_7 bone_20 bone_21
# ============================================================================
set -uo pipefail
export SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
if [ -f "$SAGA_ROOT/scripts/saga-pod-init.sh" ]; then source "$SAGA_ROOT/scripts/saga-pod-init.sh"; fi

GLB="$(find "$SAGA_ROOT" -maxdepth 4 \( -iname '*reskinned*.glb' -o -iname '*rigged*.glb' \) -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
PR="$SAGA_ROOT/scripts/saga-3d-pose-render.py"
RI="$SAGA_ROOT/scripts/saga-3d-rig-inspect.py"
BONES="${*:-bone_6 bone_20}"
OUT="$SAGA_ROOT/aimcal"; rm -rf "$OUT"; mkdir -p "$OUT"

if [ -z "$GLB" ] || [ ! -f "$GLB" ]; then echo "❌ no rigged/reskinned glb found under $SAGA_ROOT" >&2; exit 1; fi
echo "GLB=$GLB"; echo "bones=$BONES"

echo; echo "### RIG INSPECT (bone hierarchy + rest axes) ###"
[ -f "$RI" ] && blender -b -P "$RI" -- --in "$GLB" 2>&1 | grep -iE 'bone|root|spine|head|arm|leg|hip|knee|hand|->' | head -80 || echo "(rig-inspect script missing)"

# direction label -> world vector
dirs="Xr:1,0,0 Xl:-1,0,0 Yf:0,-1,0 Yb:0,1,0 Zu:0,0,1 Zd:0,0,-1"
HAVE_MONTAGE=0; command -v montage >/dev/null 2>&1 && HAVE_MONTAGE=1

for b in $BONES; do
  echo; echo "### CALIBRATING $b ###"
  for pair in $dirs; do
    name="${pair%%:*}"; v="${pair#*:}"
    blender -b -P "$PR" -- --in "$GLB" --out "$OUT" --pose rest --aim "$b:$v" \
      --label "${b}_${name}_" --cams front,side_l --passes clay --res 640 --samples 12 \
      --smooth-deform 0.65 2>&1 | tail -1
    if [ "$HAVE_MONTAGE" = 1 ]; then
      f="$OUT/${b}_${name}_rest_front_clay.png"; s="$OUT/${b}_${name}_rest_side_l_clay.png"
      [ -f "$f" ] && [ -f "$s" ] && montage "$f" "$s" -tile 2x1 -geometry +2+2 \
        -background '#3a3a3f' -fill white -title "$b aim $name ($v)" "$OUT/C_${b}_${name}.png" 2>/dev/null
    fi
  done
  if [ "$HAVE_MONTAGE" = 1 ] && ls "$OUT"/C_${b}_*.png >/dev/null 2>&1; then
    montage "$OUT/C_${b}_Xr.png" "$OUT/C_${b}_Xl.png" "$OUT/C_${b}_Yf.png" \
            "$OUT/C_${b}_Yb.png" "$OUT/C_${b}_Zu.png" "$OUT/C_${b}_Zd.png" \
            -tile 2x3 -geometry +4+4 -background '#2a2a2e' "$OUT/ALL_aimcal_${b}.png" 2>/dev/null
    echo "→ $OUT/ALL_aimcal_${b}.png"
  fi
done
echo; echo "✅ DONE — paste the ALL_aimcal_*.png (each = one bone aimed at all 6 world dirs, front|side)."
ls -1 "$OUT"/ALL_aimcal_*.png 2>/dev/null || ls -1 "$OUT"/*.png
