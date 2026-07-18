# SAGA box scripts

Operational scripts that drive the ComfyUI engine on the box over its HTTP API.
They carry **no secrets** — every path/model is an env var or a public model
filename; the engine is localhost-only. Deploy: `scp` to `$SAGA_ROOT/` (or run
from anywhere with `SAGA_ROOT` set) and `chmod +x`.

| Script | Does | Key args (shared: `-o -s -W -H -p -n`) |
|---|---|---|
| `saga-keyframe.sh` | Pose ONE keyframe still: Animagine + IP-Adapter identity + ControlNet Union Promax pose-forcing | `-r ref` `-c control` `--control-pre dwpose\|openpose\|none` `--control-strength` `--ip-weight` |
| `saga-flf.sh` | Render ONE first-last-frame clip (Wan 2.2 FLF2V-A14B lightning) | `-a first` `-b last` `-d durationS`\|`-L frames` `--fps` `--shift` |
| `saga-jutsu-flf.sh` | The 20s jutsu A–Z orchestrator: preflight checks → 8 keyframes → 7 FLF + 3 holds (320f/20s) → concat → polish, with a timestamped log + idempotent resume | env: `REF`, `SEAL1..5`, `SEED`; flags: `--check` (preflight only), `--force` (redo artifacts), `--no-polish` |
| `saga-lora-setup.sh` | One-time: install kohya sd-scripts (headless trainer) in its own venv (torch cu121 + reqs + bitsandbytes/xformers + accelerate config) | `--check` to report install state |
| `saga-lora-dataset.sh` | Prep a raw image folder → kohya `<repeats>_<trigger>/` layout (resize/RGB + trigger captions). Mirrors `core/loraDataset.ts` | `--raw DIR --trigger TOKEN [--repeats 10] [--maxres 1536] [--out DIR] [--caption "tags"]` |

### LoRA training flow
1. `saga-lora-setup.sh` (once) — install the trainer. GPU not needed.
2. Gather 15–30 varied on-model images → `saga-lora-dataset.sh --raw … --trigger …`.
3. `saga-lora-train.sh` (built after setup is confirmed) — **drains the GPU** (stops
   Ollama/ComfyUI; SDXL LoRA needs ~12–16 GB) then runs sd-scripts.
4. Register the resulting `.safetensors` in `models/loras/` + `modelRegistry`.

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
