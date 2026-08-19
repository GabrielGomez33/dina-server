#!/usr/bin/env bash
# ============================================================================
# saga-grade.sh — color/grain grade a clip (single concern: the "film look")
# ----------------------------------------------------------------------------
# Pushes a too-clean/"3D"-looking render toward hand-drawn analog anime by adding
# film grain and muting/contrasting the palette. Presets are reusable across the
# whole show's aesthetic — not specific to one clip.
#
#   saga-grade.sh <input.mp4|.png|.jpg> [--preset soft|lain|lain-bloom|bloom|grain|none] [-o out]
#     Accepts a VIDEO or a STILL (png/jpg/webp) — outputs the same kind (video grain is temporal).
#     soft = the SOFT look (Little One): gentle Orton glow + matte lifted-black haze + light grain
#            + soft vignette, palette PRESERVED (keeps rosy cheeks / soft grey). Softer, not dirtier.
#     lain-bloom = the cohesive analog look: sharpen→soft-glow (Orton) + muted + grain.
#                  The uniform glow layer masks per-segment seams → reads as one scene.
#     lain-heavy = DIRTY degrade: strong desaturation + gamma crush + soft bloom + analog
#                  chromatic aberration + heavy grain + vignette (max Lain, least "real").
#     bloom = sharpen→soft-glow only (Orton effect: crisp base + blurred screen layer)
#     lain  = desaturated, muted, contrasty + grain (Serial Experiments Lain vibe)
#     grain = grain only, palette untouched
#     none  = passthrough (copy)
#
# Validate any preset's ffmpeg filter on a synthetic clip before a long render:
#   ffmpeg -f lavfi -i testsrc=size=320x180:rate=16:duration=1 -vf "<VF>" -frames:v 4 /tmp/t.mp4
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
IN=""; PRESET="lain"; OUT=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --preset) PRESET="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,16p' "$0"; exit 0;;
  -*) die "unknown arg: $1";;
  *) IN="$1"; shift;;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need <input.mp4|.png|.jpg>"
command -v ffmpeg >/dev/null || die "ffmpeg required"
case "${IN,,}" in *.png|*.jpg|*.jpeg|*.webp|*.bmp) IMG=1;; *) IMG=0;; esac
OUT="${OUT:-${IN%.*}_${PRESET}.$([ "$IMG" -eq 1 ] && echo png || echo mp4)}"

BLOOM="split=2[a][b];[a]unsharp=5:5:1.0[s];[b]gblur=sigma=6[g];[s][g]blend=all_mode=screen:all_opacity=0.35"
# Softer, wider bloom for the heavy analog look (less crisp base, more glow).
BLOOM_SOFT="split=2[a][b];[a]unsharp=5:5:0.7[s];[b]gblur=sigma=9[g];[s][g]blend=all_mode=screen:all_opacity=0.42"
# Gentle glow: barely-there sharpen so an already-soft render isn't hardened, wide low-opacity screen.
BLOOM_GENTLE="split=2[a][b];[a]unsharp=3:3:0.3[s];[b]gblur=sigma=8[g];[s][g]blend=all_mode=screen:all_opacity=0.30"
case "$PRESET" in
  # soft = softness without the dirt: gentle glow, matte haze (lift blacks / pull highlights via curves),
  # saturation kept ~0.94 so the rosy cheeks survive, light grain, gentle vignette. The Little One look.
  soft)       VF="${BLOOM_GENTLE}[bl];[bl]eq=saturation=0.94:contrast=1.03:brightness=0.005,curves=all='0/0.03 0.5/0.52 1/0.98',noise=alls=8:allf=t+u,vignette=PI/6";;
  lain-bloom) VF="${BLOOM}[bl];[bl]eq=saturation=0.72:contrast=1.08:brightness=-0.01,noise=alls=12:allf=t+u";;
  # lain-heavy = the DIRTY analog degrade: strong desaturation + gamma crush + soft bloom
  # + analog chromatic aberration (rgbashift) + heavy film grain + vignette. Pushes hard
  # toward Serial Experiments Lain / degraded VHS anime, away from clean-real.
  lain-heavy) VF="${BLOOM_SOFT}[bl];[bl]eq=saturation=0.50:contrast=1.14:brightness=-0.03:gamma=0.92,rgbashift=rh=-2:bh=2,noise=alls=26:allf=t+u,vignette=PI/5";;
  # lain-warm = the Lain analog texture (soft bloom + heavy grain + vignette) but WARM-tinted and
  # far less desaturated, so warm/hopeful footage (glowing gold maps) keeps its warmth instead of
  # going cold-purple. The anthem/hopeful counterpart to lain-heavy.
  lain-warm)  VF="${BLOOM_SOFT}[bl];[bl]eq=saturation=0.86:contrast=1.10:brightness=-0.01:gamma=0.96,colorbalance=rs=0.05:gs=0.02:bs=-0.06:rm=0.04:bm=-0.05,noise=alls=20:allf=t+u,vignette=PI/5";;
  bloom)      VF="$BLOOM";;
  lain)       VF="eq=saturation=0.68:contrast=1.10:brightness=-0.015,noise=alls=14:allf=t+u";;
  grain)      VF="noise=alls=12:allf=t+u";;
  none)       cp -f "$IN" "$OUT"; echo "$OUT"; exit 0;;
  *) die "unknown --preset: $PRESET (soft|lain-bloom|lain-heavy|bloom|lain|grain|none)";;
esac

echo "▶ grade $(basename "$IN") [$PRESET]$([ "$IMG" -eq 1 ] && echo ' (still)')" >&2
if [ "$IMG" -eq 1 ]; then
  ffmpeg -y -i "$IN" -vf "$VF" -frames:v 1 "$OUT" >/dev/null 2>&1 || die "grade failed"
else
  ffmpeg -y -i "$IN" -vf "$VF" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 || die "grade failed"
fi
echo "✅ $OUT" >&2
echo "$OUT"
