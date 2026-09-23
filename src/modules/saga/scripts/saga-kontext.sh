#!/usr/bin/env bash
# saga-kontext.sh — FLUX.1 Kontext [dev] reference-conditioned image edit (the SOTA-aligned path).
# ============================================================================
# WHY THIS EXISTS: state-of-the-art generators (Nano-Banana, Veo, Seedream-Edit) hold a character
# by feeding the reference IMAGE straight into the model as in-context conditioning — no per-character
# LoRA, no 3D rig. Kontext-dev is the open analog: it VAE-encodes a reference and injects it via a
# ReferenceLatent node, then an INSTRUCTION prompt edits from there ("same character, now …"). This
# is the identity-preserving path we test BEFORE committing to the 3D-proxy pipeline (CHARACTER_3D.md).
#
# HONEST SCOPE (read before judging the test): Kontext PRESERVES identity, it does not freely RE-POSE.
# Text alone will hold the build across new lighting / framing / small gestures. It will NOT reliably
# hit big athletic poses (jump / run / reach) from words — that still needs a structural signal
# (depth/lineart ControlNet from a rough posed silhouette; NOT OpenPose — the blob has no human
# skeleton). So the go/no-go here is specifically: (a) does the round build stay LOCKED across new
# scenes, and (b) how much pose change do we get from the instruction alone. Answer that, then decide.
#
# Models (download once on the pod — see docs/VIDEO_PIPELINE.md):
#   models/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors  (KONTEXT_UNET) ~11.9 GB
#   models/text_encoders/clip_l.safetensors        (CLIP_L)   — may already exist
#   models/text_encoders/t5xxl_fp16.safetensors    (T5XXL)    — may already exist
#   models/vae/ae.safetensors                       (FLUX_VAE) — already have
#   models/loras/little_one_v2.safetensors          (optional --lora, composes with the reference)
#
# LICENSE: Kontext-dev is NON-COMMERCIAL (same box as our Flux-dev LoRA — R&D only). If the technique
# proves out, port to Qwen-Image-Edit-2511 (Apache-2.0) for anything that ships. (see COMPETITIVE_RESEARCH.md)
#
# Usage:
#   saga-kontext.sh --ref hero.png -p "the same small round creature, now sitting up, gazing gently upward" -o k_up
#   saga-kontext.sh --ref hero.png -p "…" --lora little_one_v2.safetensors --lora-strength 0.7 -o k_lora
#   saga-kontext.sh --ref hero.png --check          # preflight: are ReferenceLatent/FluxKontextImageScale present?
#   saga-kontext.sh --ref hero.png -p "…" --dump-graph | jq
#
# The instruction should NAME the subject as a continuation ("the same … creature, now …"); Kontext
# edits the reference rather than generating fresh, so describe the CHANGE, not the whole character.
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
KONTEXT_UNET="${KONTEXT_UNET:-flux1-dev-kontext_fp8_scaled.safetensors}"
CLIP_L="${CLIP_L:-clip_l.safetensors}"
T5XXL="${T5XXL:-t5xxl_fp16.safetensors}"
FLUX_VAE="${FLUX_VAE:-ae.safetensors}"

OUT="saga_kontext"; SEED=0; STEPS=20; GUIDANCE=2.5; CFG=1.0; BATCH=1
PROMPT=""; REF=""; REF2=""
LORA=""; LORA_STR="0.7"
DUMP=0; CHECK=0
die(){ echo "❌ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;  -s|--seed) SEED="$2"; shift 2;;
  -p|--prompt) PROMPT="$2"; shift 2;;
  --ref) REF="$2"; shift 2;;  --ref2) REF2="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;;  --lora-strength) LORA_STR="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;;  --guidance) GUIDANCE="$2"; shift 2;;  --cfg) CFG="$2"; shift 2;;
  --batch) BATCH="$2"; shift 2;;  --unet) KONTEXT_UNET="$2"; shift 2;;
  --dump-graph) DUMP=1; shift;;  --check) CHECK=1; shift;;
  -h|--help) sed -n '2,40p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
command -v jq >/dev/null || die "jq required"
[ -n "$REF" ] || die "need --ref IMG (the character reference to hold)"
[ -n "$PROMPT" ] || [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ] || die "need -p/--prompt (the edit instruction)"

upload(){ local f="$1"; [ -f "$f" ] || die "file not found: $f"; curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name'; }

NODES='["UNETLoader","DualCLIPLoader","VAELoader","CLIPTextEncode","FluxGuidance","ConditioningZeroOut","LoadImage","FluxKontextImageScale","VAEEncode","ReferenceLatent","KSampler","VAEDecode","SaveImage"]'
[ -n "$LORA" ] && NODES=$(echo "$NODES" | jq -c '. + ["LoraLoaderModelOnly"]')
preflight(){
  local info miss=0 n; info=$(curl -sf "$COMFY/object_info") || die "ComfyUI unreachable at $COMFY"
  for n in $(echo "$NODES" | jq -r '.[]' | sort -u); do
    echo "$info" | jq -e --arg n "$n" 'has($n)' >/dev/null || { echo "  ✗ missing node: $n" >&2; miss=1; }
  done
  if [ "$miss" -ne 0 ]; then
    echo "  → Kontext nodes ship with current ComfyUI. If ReferenceLatent/FluxKontextImageScale are" >&2
    echo "    missing, UPDATE ComfyUI (git pull in engine/ComfyUI; strip torch from any custom-node reqs" >&2
    echo "    before pip install so the Blackwell torch 2.8+cu128 build is not downgraded)." >&2
    return 1
  fi
  echo "✔ preflight ok — all Kontext node classes present$([ -n "$LORA" ] && echo ' (+lora)')"
}

# ---- LoRA (character identity) chain: model-only, between UNETLoader and KSampler ----
# Composes with the reference: the reference carries the exact hero, the LoRA reinforces the learned
# build/style. Keep strength modest (~0.7) so it supports rather than fights the reference conditioning.
LORAJSON=""; MODEL_SRC='["1",0]'
if [ -n "$LORA" ]; then
  MODEL_SRC='["30",0]'
  LORAJSON=',
 "30":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["1",0],"lora_name":"'"$LORA"'","strength_model":'"$LORA_STR"'}}'
fi

# ---- reference chain: LoadImage → FluxKontextImageScale (snap to a supported res) → VAEEncode ----
# The encoded reference latent is BOTH the in-context reference (via ReferenceLatent) and the KSampler
# start latent at denoise 1.0 — so the output inherits the reference's aspect/size and the model edits
# the reference in place. A second reference (--ref2, e.g. a back view) chains a 2nd ReferenceLatent.
if [ "$CHECK" -eq 0 ] && [ "$DUMP" -eq 0 ]; then RZ=$(upload "$REF"); else RZ="${REF##*/}"; fi
REF2JSON=""; REFLAT_SRC='["5",0]'   # conditioning feeding ReferenceLatent = FluxGuidance output
if [ -n "$REF2" ]; then
  if [ "$CHECK" -eq 0 ] && [ "$DUMP" -eq 0 ]; then RZ2=$(upload "$REF2"); else RZ2="${REF2##*/}"; fi
  REF2JSON=',
 "40":{"class_type":"LoadImage","inputs":{"image":"'"$RZ2"'"}},
 "41":{"class_type":"FluxKontextImageScale","inputs":{"image":["40",0]}},
 "42":{"class_type":"VAEEncode","inputs":{"pixels":["41",0],"vae":["3",0]}},
 "43":{"class_type":"ReferenceLatent","inputs":{"conditioning":["5",0],"latent":["42",0]}}'
  REFLAT_SRC='["43",0]'
fi

# Kontext-dev is guidance-distilled → at cfg 1.0 the negative is inert (zeroed), same as Flux-dev.
GRAPH='{
 "1":{"class_type":"UNETLoader","inputs":{"unet_name":"'"$KONTEXT_UNET"'","weight_dtype":"fp8_e4m3fn"}},
 "2":{"class_type":"DualCLIPLoader","inputs":{"clip_name1":"'"$CLIP_L"'","clip_name2":"'"$T5XXL"'","type":"flux"}},
 "3":{"class_type":"VAELoader","inputs":{"vae_name":"'"$FLUX_VAE"'"}},
 "4":{"class_type":"CLIPTextEncode","inputs":{"text":'"$(jq -Rn --arg s "$PROMPT" '$s')"',"clip":["2",0]}},
 "5":{"class_type":"FluxGuidance","inputs":{"guidance":'"$GUIDANCE"',"conditioning":["4",0]}},
 "6":{"class_type":"LoadImage","inputs":{"image":"'"$RZ"'"}},
 "7":{"class_type":"FluxKontextImageScale","inputs":{"image":["6",0]}},
 "8":{"class_type":"VAEEncode","inputs":{"pixels":["7",0],"vae":["3",0]}},
 "9":{"class_type":"ReferenceLatent","inputs":{"conditioning":'"$REFLAT_SRC"',"latent":["8",0]}},
 "10":{"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
 "11":{"class_type":"KSampler","inputs":{"model":'"$MODEL_SRC"',"positive":["9",0],"negative":["10",0],"latent_image":["8",0],"seed":'"$SEED"',"steps":'"$STEPS"',"cfg":'"$CFG"',"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
 "12":{"class_type":"VAEDecode","inputs":{"samples":["11",0],"vae":["3",0]}},
 "13":{"class_type":"SaveImage","inputs":{"images":["12",0],"filename_prefix":"'"$OUT"'"}}'"$LORAJSON$REF2JSON"'
}'

[ "$DUMP" -eq 1 ] && { echo "$GRAPH"; exit 0; }
preflight || die "preflight failed (see above)"
[ "$CHECK" -eq 1 ] && exit 0
echo "$GRAPH" | jq -e . >/dev/null || die "internal: malformed graph JSON"

echo "▶ kontext${LORA:+ +lora}${REF2:+ +ref2}: '$OUT'  g=$GUIDANCE  steps=$STEPS  seed=$SEED  ref=$(basename "$REF")${LORA:+  lora=$(basename "$LORA")@${LORA_STR}}"
echo "  instruction: $PROMPT"
PID=$(curl -sf -X POST "$COMFY/prompt" -d "$(jq -n --argjson p "$GRAPH" '{prompt:$p}')" | jq -r '.prompt_id // empty')
[ -n "$PID" ] || die "graph rejected (run --dump-graph | jq and diff vs /object_info)"
echo "  submitted: $PID"
for _ in $(seq 1 900); do
  done=$(curl -sf "$COMFY/history/$PID" | jq -r --arg p "$PID" '.[$p].status.completed // false' 2>/dev/null)
  [ "$done" = "true" ] && break; sleep 2
done
OUTDIR="${COMFY_OUT:-$SAGA_ROOT/engine/ComfyUI/output}"
mapfile -t IMGS < <(curl -sf "$COMFY/history/$PID" | jq -r --arg p "$PID" '.[$p].outputs[].images[]?.filename' 2>/dev/null)
[ "${#IMGS[@]}" -gt 0 ] || die "no images produced (check ComfyUI logs / execution_error)"
for f in "${IMGS[@]}"; do echo "✅ still → $OUTDIR/$f"; done
