#!/usr/bin/env bash
# ============================================================================
# saga-user-init.sh — scaffold a user's SAGA storage tree (per USER_STORAGE.md)
# ----------------------------------------------------------------------------
# Creates the durable user-scope directories and (optionally) sorts a folder of
# photos into them: all images → uploads/images; hand-sign photos additionally
# copied (originals) to the character's control/ dir for DWPose seal refs.
#
#   saga-user-init.sh <userToken> [--from <srcDir>]
#
# Staging layout (maps to the production tenants/<t>/users/<uuid>/ once the
# DB-backed version lands; here we stage under users/<userToken>/):
#
#   users/<u>/
#     uploads/{images,audio}     # raw ingested media (immutable source)
#     datasets/                  # prepared kohya training sets
#     loras/                     # trained LoRAs (durable home; ComfyUI copy lives in models/loras)
#     characters/<u>/{refs,control}  # canonical refs + pose/seal control refs
#     voices/  models/  profile/
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"

TOKEN=""; SRC=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --from) SRC="$2"; shift 2;;
  -h|--help) sed -n '2,26p' "$0"; exit 0;;
  *) [ -z "$TOKEN" ] && { TOKEN="$1"; shift; } || die "unexpected arg: $1";;
esac; done
[ -n "$TOKEN" ] || die "usage: saga-user-init.sh <userToken> [--from <srcDir>]"

# sanitize to match the LoRA trigger convention (alnum + underscore, lowercase)
U=$(echo "$TOKEN" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
[ -n "$U" ] || die "token reduced to empty after sanitizing"

BASE="$SAGA_ROOT/users/$U"
CHAR="$BASE/characters/$U"
echo "▶ scaffolding user tree: $BASE  (token '$U')"
for d in uploads/images uploads/audio datasets loras "characters/$U/refs" "characters/$U/control" voices models profile; do
  mkdir -p "$BASE/$d"
done

# minimal character sheet (activeLora filled in after training)
SHEET="$CHAR/sheet.json"
if [ ! -f "$SHEET" ]; then
  printf '{\n  "characterId": "%s",\n  "trigger": "%s",\n  "activeLora": null,\n  "baseModel": "animagine-xl-4.0.safetensors",\n  "notes": "person LoRA; identity from LoRA, seal poses from control/ via DWPose"\n}\n' "$U" "$U" > "$SHEET"
  echo "  wrote $SHEET"
fi

IMG_FIND=( -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.tif' -o -iname '*.tiff' -o -iname '*.heic' \) )

if [ -n "$SRC" ]; then
  [ -d "$SRC" ] || die "--from dir not found: $SRC"
  echo "▶ sorting photos from $SRC"
  # all images → uploads/images (training source)
  find "$SRC" -maxdepth 1 "${IMG_FIND[@]}" -exec cp {} "$BASE/uploads/images/" \;
  # hand-sign photos ALSO → character control refs (keep originals for DWPose)
  find "$SRC" -maxdepth 1 -type f -iname '*handsign*' -exec cp {} "$CHAR/control/" \;
  NI=$(find "$BASE/uploads/images" -maxdepth 1 "${IMG_FIND[@]}" | wc -l)
  NC=$(find "$CHAR/control" -maxdepth 1 -type f | wc -l)
  echo "  uploads/images: $NI images"
  echo "  characters/$U/control: $NC hand-sign refs"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
echo "✅ user tree ready: $BASE"
echo
echo "next:"
echo "  # 1. prepare the training set from the identity + hand photos"
echo "  bash \"$HERE/saga-lora-dataset.sh\" --raw \"$BASE/uploads/images\" --trigger $U --out \"$BASE/datasets\""
echo "  # 2. train (person LoRA: rank 32, ~2800 steps)"
echo "  bash \"$HERE/saga-lora-train.sh\" --dataset \"$BASE/datasets\" --name $U --trigger $U --rank 32 --steps 2800"
