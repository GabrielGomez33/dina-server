#!/usr/bin/env bash
# ============================================================================
# saga-flux-lora-train.sh — train a FLUX.1-dev character LoRA (ai-toolkit)
# ----------------------------------------------------------------------------
# The IMAGE-model sibling of saga-video-lora-train.sh: bakes ONE character's
# identity into Flux.1-dev so saga-flux.sh renders them on-model from a plain
# text prompt (pose/framing driven by the prompt, not locked by Redux).
# Fills training/lora_flux.yaml.tmpl and launches ai-toolkit's run.py.
#
#   saga-flux-lora-train.sh --dataset DIR --name little_one --trigger l1ttl3one
#     [--rank 16] [--steps 2200] [--lr 1e-4] [--save-every 250]
#     [--resolutions 768,1024] [--quantize true|false] [--model-path REPO_OR_DIR]
#     [--dry-run]
#
# --dataset : a FLAT folder of image + same-stem .txt caption pairs
#             (build it with saga-flux-lora-dataset.sh). NOT the kohya
#             "<repeats>_<trigger>/" layout — that's the SDXL trainer.
# --dry-run : write the filled config + print the command, train nothing.
#
# Requires: FLUX.1-dev license accepted on the HF account and HF_TOKEN exported
#   (ai-toolkit pulls the full dev weights on first run). 24 GB → keep
#   --quantize true (default). 32 GB (5090) → --quantize false for a quality bump.
#
# Env: SAGA_ROOT (required)   AIT_ROOT=$SAGA_ROOT/engine/ai-toolkit
# VERIFY-LIVE: confirm the ai-toolkit run.py path + venv on the pod once; the
#   config schema tracks ostris/ai-toolkit's 24 GB Flux example.
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMPL="$(cd "$HERE/../training" && pwd)"
AIT_ROOT="${AIT_ROOT:-$SAGA_ROOT/engine/ai-toolkit}"

DATASET=""; NAME=""; TRIGGER=""; RANK=16; STEPS=2200; LR="1e-4"; SAVE_EVERY=250
RESOLUTIONS="768,1024"; QUANTIZE="true"; MODEL_PATH="black-forest-labs/FLUX.1-dev"; DRY=0
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --dataset) DATASET="$2"; shift 2;; --name) NAME="$2"; shift 2;;
  --trigger) TRIGGER="$2"; shift 2;; --rank) RANK="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;; --lr) LR="$2"; shift 2;;
  --save-every) SAVE_EVERY="$2"; shift 2;; --resolutions) RESOLUTIONS="$2"; shift 2;;
  --quantize) QUANTIZE="$2"; shift 2;; --model-path) MODEL_PATH="$2"; shift 2;;
  --dry-run) DRY=1; shift;; -h|--help) sed -n '2,30p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

# --- validation -------------------------------------------------------------
[ -n "$DATASET" ] && [ -d "$DATASET" ] || die "need --dataset <flat dir of image+txt pairs>"
[ -n "$NAME" ] || die "need --name (output LoRA name)"
[ -n "$TRIGGER" ] || die "need --trigger (identity token, e.g. l1ttl3one)"
TMPL_FLUX="$TMPL/lora_flux.yaml.tmpl"
[ -f "$TMPL_FLUX" ] || die "template missing: $TMPL_FLUX"
for n in "$RANK" "$STEPS" "$SAVE_EVERY"; do case "$n" in ''|*[!0-9]*) die "numeric arg expected, got '$n'";; esac; done
case "$QUANTIZE" in true|false) ;; *) die "--quantize must be true|false (got '$QUANTIZE')";; esac
NAMESTEM=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
[ -n "$NAMESTEM" ] || die "name reduced to empty after sanitizing"

# dataset must be the FLAT ai-toolkit layout: image + same-stem .txt pairs.
# Refuse the kohya "<repeats>_<trigger>/" layout early — it trains silently wrong.
if find "$DATASET" -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]+_.+' | grep -q .; then
  die "this looks like the kohya SDXL layout (<repeats>_<trigger>/). ai-toolkit wants a FLAT
     folder of image+txt pairs — build it with saga-flux-lora-dataset.sh."
fi
mapfile -t IMGS < <(find "$DATASET" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) | sort)
NIMG="${#IMGS[@]}"
[ "$NIMG" -ge 8 ] || die "only $NIMG images in $DATASET — a character LoRA needs >=8 (15-30 recommended)"
NOCAP=0; for f in "${IMGS[@]}"; do stem="${f%.*}"; [ -f "${stem}.txt" ] || NOCAP=$((NOCAP+1)); done
[ "$NOCAP" -eq 0 ] || echo "⚠️  $NOCAP/$NIMG images have no .txt caption (trigger_word still applies, but captions help separate pose/bg from identity)"
RES_YAML=$(echo "$RESOLUTIONS" | sed 's/,/, /g')          # 768,1024 → 768, 1024

OUT_DIR="$SAGA_ROOT/models/loras"          # ai-toolkit writes <OUT_DIR>/<name>/<name>.safetensors
CFG_DIR="$SAGA_ROOT/tmp/lora/${NAMESTEM}_flux"; mkdir -p "$CFG_DIR" "$OUT_DIR" || die "cannot create output/config dirs"
CFG_OUT="$CFG_DIR/lora_flux.yaml"

fill(){ sed -e "s#@NAME@#$NAMESTEM#g" -e "s#@TRIGGER@#$TRIGGER#g" -e "s#@DATASET@#$DATASET#g" \
            -e "s#@OUTPUT_DIR@#$OUT_DIR#g" -e "s#@RANK@#$RANK#g" -e "s#@STEPS@#$STEPS#g" \
            -e "s#@LR@#$LR#g" -e "s#@SAVE_EVERY@#$SAVE_EVERY#g" -e "s#@RESOLUTIONS@#$RES_YAML#g" \
            -e "s#@QUANTIZE@#$QUANTIZE#g" -e "s#@MODEL_PATH@#$MODEL_PATH#g" "$1"; }
fill "$TMPL_FLUX" > "$CFG_OUT" || die "failed to write $CFG_OUT"
if grep -q '@[A-Z_]*@' "$CFG_OUT"; then grep -Hn '@[A-Z_]*@' "$CFG_OUT" >&2; die "unfilled placeholder(s) remain"; fi

echo "▶ flux-LoRA config ready:"
echo "   name=$NAMESTEM  trigger=$TRIGGER  rank=$RANK  steps=$STEPS  lr=$LR  quantize=$QUANTIZE"
echo "   dataset=$DATASET ($NIMG images)   resolutions=[$RES_YAML]"
echo "   base=$MODEL_PATH"
echo "   config=$CFG_OUT"
echo "   output=$OUT_DIR/$NAMESTEM/${NAMESTEM}.safetensors (ai-toolkit naming)"

# ai-toolkit runner + its own venv python (never reuse ComfyUI's env).
RUNPY="$AIT_ROOT/run.py"
for p in "$AIT_ROOT/venv/bin/python" "$AIT_ROOT/venv-ait/bin/python" "$SAGA_ROOT/engine/venv-ait/bin/python"; do
  [ -x "$p" ] && { AITPY="$p"; break; }
done
CMD="${AITPY:-python} $RUNPY $CFG_OUT"
if [ "$DRY" -eq 1 ]; then
  echo "(--dry-run) would run:"; echo "  cd $AIT_ROOT && $CMD"; exit 0
fi
[ -f "$RUNPY" ] || die "ai-toolkit run.py not found at $RUNPY (clone ostris/ai-toolkit there, or set AIT_ROOT), or use --dry-run"
[ -n "${AITPY:-}" ] || die "ai-toolkit venv python not found under $AIT_ROOT (venv/ or venv-ait/) — create it, or use --dry-run"
[ -n "${HF_TOKEN:-}" ] || echo "⚠️  HF_TOKEN not exported — the FLUX.1-dev pull will fail if the model isn't already cached. export HF_TOKEN=hf_… first."

# fragmentation guard for the 24 GB fit (same lesson as the video trainer).
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-1}"

echo "▶ launching ai-toolkit (one GPU: pause ComfyUI-heavy work while it runs)…"
( cd "$AIT_ROOT" && $CMD ) || die "training failed (see log above)"

RESULT="$OUT_DIR/$NAMESTEM/${NAMESTEM}.safetensors"
[ -f "$RESULT" ] || RESULT=$(find "$OUT_DIR/$NAMESTEM" -maxdepth 1 -name '*.safetensors' 2>/dev/null | sort | tail -1)
[ -n "$RESULT" ] && [ -f "$RESULT" ] || die "training finished but no .safetensors under $OUT_DIR/$NAMESTEM"
echo
echo "✅ LoRA trained → $RESULT"
echo "   trigger: $TRIGGER"
echo "   test it: saga-flux.sh --lora $(basename "$RESULT") -p \"$TRIGGER running, full body, charcoal pencil drawing, plain background\" -o l1_posetest"
echo "   (wire --lora into saga-flux.sh if not already present — LoraLoaderModelOnly on node 1)"
