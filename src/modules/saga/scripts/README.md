# SAGA box scripts

Operational scripts that drive the ComfyUI engine on the box over its HTTP API.
They carry **no secrets** — every path/model is an env var or a public model
filename; the engine is localhost-only.

**Deploy (once):** `saga-install.sh` publishes every tool to `$SAGA_ROOT/bin` (thin
wrappers that run the repo scripts in place — they track the repo, so `git pull`
updates the tools with no re-install). Then `export PATH="$SAGA_ROOT/bin:$PATH"`.
`saga-install.sh --check` reports state; `--copy` makes a frozen snapshot instead.

| Script | Does | Key args (shared: `-o -s -W -H -p -n`) |
|---|---|---|
| `saga-install.sh` | Publish all tools to a stable run dir (`$SAGA_ROOT/bin`) on PATH | `--bin DIR` `--copy` `--check` |
| `saga-keyframe.sh` | Pose ONE keyframe still: Animagine + IP-Adapter identity + ControlNet Union Promax pose-forcing | `-r ref` `-c control` `--control-pre dwpose\|openpose\|none` `--control-strength` `--ip-weight` |
| `saga-flf.sh` | Render ONE first-last-frame clip (Wan 2.2 FLF2V-A14B lightning) | `-a first` `-b last` `-d durationS`\|`-L frames` `--fps` `--shift` |
| `saga-framepack.sh` | Render ONE continuous take (FramePack/HunyuanVideo I2V, up to 120s); `--check`/`--dump-graph` | `-a first` `-L frames`\|`-d durationS` `--fps` `--lora` `--lora-weight` |
| `saga-ltx.sh` | Render ONE continuous take (LTX-Video I2V, native nodes, 8k+1 frames); `--check`/`--dump-graph` | `-a first` `-L frames`\|`-d durationS` `--fps` `--lora` `--lora-weight` |
| `saga-hunyuan-fetch.sh` | Provision HunyuanVideo TRAINING base weights (dit+vae+llava+clip) into `ckpt_path`; version-proof CPU llava extraction; idempotent/resumable | `[--dest DIR] [--check] [--skip-download] [--force]` |
| `saga-video-lora-train.sh` | Train a VIDEO-model LoRA (wan\|hunyuan\|ltx) via diffusion-pipe from the curated image set | `--user U --model M [--dry-run] [--rank] [--lr] [--epochs]` |
| `saga-jutsu-flf.sh` | The jutsu A–Z orchestrator: preflight → 8 keyframes → motion (Wan FLF stitch **or** single-take on framepack/ltx) → assemble → polish, timestamped log + idempotent resume | env: `VIDEO_BACKEND=wan\|framepack\|ltx`, `VIDEO_LORA`, `TAKE_SECONDS`, `REF`, `SEED`; flags: `--check`, `--force`, `--no-polish` |
| `saga-lora-setup.sh` | One-time: install kohya sd-scripts (headless trainer) in its own venv (torch cu121 + reqs + bitsandbytes/xformers + accelerate config) | `--check` to report install state |
| `saga-lora-dataset.sh` | Prep a raw image folder → kohya `<repeats>_<trigger>/` layout (resize/RGB + trigger captions). Mirrors `core/loraDataset.ts` | `--raw DIR --trigger TOKEN [--repeats 10] [--maxres 1536] [--out DIR] [--caption "tags"]` |

### LoRA training flow
1. `saga-lora-setup.sh` (once) — install the trainer. GPU not needed.
2. Gather 15–30 varied on-model images → `saga-lora-dataset.sh --raw … --trigger …`.
3. `saga-lora-train.sh --dataset <out> --name Exodia --trigger exodia_saga` —
   **drains the GPU** (stops Ollama/ComfyUI; needs ~12–16 GB, checks free VRAM
   before launching), runs sd-scripts (SDXL, UNet-only, AdamW8bit, bf16,
   `--no_half_vae`, min-SNR), copies the `.safetensors` into `models/loras/`,
   and restores ComfyUI on exit. Defaults mirror `core/loraTraining.ts`.
4. Register the resulting `.safetensors` in `modelRegistry` + wire `Exodia LoRA +
   IP-Adapter` into generation.

## Prereqs on the box
- `saga-comfyui` up (localhost:8188), `jq` + `ffmpeg` installed.
- Result retrieval tries ComfyUI's HTTP `/view`, then falls back to reading the
  output file straight off disk (the scripts run locally). If your ComfyUI output
  dir isn't `$SAGA_ROOT/engine/ComfyUI/output`, set `COMFY_OUT` to it (find it:
  `find "$SAGA_ROOT" -maxdepth 5 -type d -name output 2>/dev/null | grep -i comfy`).
- Model filenames default to the audited set (2026-07-18). Override via env if
  yours differ — **`FLF_T5` must be set to your umt5 text-encoder filename**
  (find it: `curl -sf http://127.0.0.1:8188/object_info/CLIPLoader | jq -r '.CLIPLoader.input.required.clip_name[0][]'`).

## Verify-live notes (per project discipline: template in repo → verify live → fix)
- **ControlNet Union Promax** may need a `SetUnionControlNetType` node on some
  builds — see the NOTE at node 23 in `saga-keyframe.sh` for the two-line fix.
- Shake out both risky links cheaply first: one `saga-keyframe.sh` (a single
  seal), then one `saga-flf.sh` between two stills, before the full driver.
