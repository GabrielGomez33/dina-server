# SAGA — Cloud Architecture (two-layer: control plane ↔ compute plane)

> **Status:** LIVE — **cloud parity CONFIRMED 2026-08-12** (see §Parity milestone). SAGA runs on
> **rented GPU compute**, not the local 24 GB 3090 Ti — this removes the Dina `mirror`/`digim`
> contention entirely (SAGA is no longer on the same card) and turns capital cost into ~cents/clip.

## Environments — naming convention (use these names everywhere)

| Name | What | Role |
|---|---|---|
| **TUGRRPORTAL** | the SAGA server — local box, RTX 3090 Ti, hostname `tugrr-portal` | holds `SAGA_ROOT` with all trained models + the video LoRA; runs Dina/`mirror`/`digim`; repo checkout `/var/www/dina-server`. Control plane + asset origin. |
| **HOME PORTAL** | the user's local machine — Windows, the one browsing the web | drives the RunPod console; SSH origin into RUNPOD. |
| **RUNPOD** | the rented RunPod GPU pod — RTX 4090, EUR-IS-1 | compute plane: ComfyUI + renders. Ephemeral; `/workspace` (volume) persists. |

Cross-environment flows: assets move **TUGRRPORTAL → RUNPOD** (rsync the LoRA/start frames over the
exposed-TCP SSH endpoint); you operate RUNPOD **from HOME PORTAL** via SSH; finished renders come
**RUNPOD → HOME PORTAL** (scp/download).

## Current deployment (live as of 2026-08-12)

The compute plane is up on RunPod. Details in `HANDOFF.md` (living state); the operational essentials:

- **Volume:** `saga-models`, 100 GB, **EUR-IS-1** (stocks both 4090 + 5090 → GPU-upgradeable on the
  same volume, no re-download). Mounts `/workspace`, persists across pod stop/start. ~$7/mo idle.
- **Pod:** `SAGA` / `ia86bj27djuhn8`, 1× RTX 4090 (24 GB · 62 GB RAM · 9 vCPU), PyTorch 2.8.0, CUDA
  13.0, Ubuntu 24.04. ~$0.74/hr on-demand. **Stop when idle.**
- **File transfer gotcha:** the `ssh.runpod.io` proxy does **not** support SCP/SFTP. For
  `rsync`/`scp` (uploading the LoRA), use the **SSH-over-exposed-TCP** endpoint
  (`root@<ip> -p <port>`). That `<ip>:<port>` is **ephemeral** — re-read it from the Connect tab
  each session; never hardcode it in a script (pass it as an arg/env).
- **Install target:** everything reusable (ComfyUI, venv, custom nodes, models) goes under
  `/workspace` (the volume), NOT the container disk (wiped on stop).

## The shape

Two layers, deliberately separated so the expensive thing (GPU) runs **only while rendering** and the
cheap thing (orchestration) is the only always-on component.

```
  ┌─────────────────────────────────────────────┐
  │  CONTROL PLANE  (cheap, always-on)           │
  │  Dina / mirror / digim  ·  a $5–10/mo VPS    │
  │  or even a serverless fn — NEAR-ZERO compute │
  │                                              │
  │  • holds the job queue + request auth        │
  │  • calls the compute plane's API             │
  │  • stores finished outputs + metadata        │
  │  • serves the UI                             │
  └───────────────────┬─────────────────────────┘
                      │  API call (launch render / submit job)
                      ▼
  ┌─────────────────────────────────────────────┐
  │  COMPUTE PLANE  (on-demand, per-second)      │
  │  a rented GPU that does ALL the actual work  │
  │                                              │
  │  • runs the SAGA pipeline (ComfyUI + LoRA)   │
  │  • spins up on demand, renders, shuts down   │
  │  • persistent model storage stays parked     │
  └─────────────────────────────────────────────┘
```

**Rule of thumb:** the control plane makes API calls and holds a queue — a Raspberry Pi could run it.
Never provision it as "high compute." The GPU is rented by the hour *precisely so it is not run 24/7*.
You do **not** need a high-compute VPS: a rented GPU pod is already a full machine (CPU + RAM + disk
+ GPU) — everything (ComfyUI, the saga-*.sh scripts, ffmpeg polish) runs on the pod itself.

## Two ways to build the compute plane

Both expose "render a jutsu" as an API to the control plane. They differ in *how much of SAGA you
port* and *when*.

| | **RunPod pod (SSH)** | **fal.ai (managed endpoint)** |
|---|---|---|
| What it is | Rent a full Linux box + GPU; run the existing scripts | Deploy SAGA as a serverless function/ComfyUI app |
| Runs current pipeline | **Yes, as-is** — `saga-*.sh` run unchanged | **No** — must containerize + port the graph, the FramePack custom node, the LoRA, and the multi-stage orchestration first |
| Time to first render | ~1–2 h | days (deployment + debugging) |
| Per-session ops | spin up / SSH / stop | none (call the API) |
| Scales to zero | yes (stop the pod) | yes (serverless) |
| Best as | **R&D + content-now environment** | **productionized endpoint Dina calls** |
| Cost | ~$0.30/hr GPU + ~$7/mo storage | per-run (higher/run, zero ops) |

### Sequencing (decided)
1. **RunPod first.** Unblock content immediately and *learn exactly what the endpoint must do* by
   running SAGA in the cloud for real. This is the R&D + production-content environment.
2. **fal.ai second.** Deploy the **now-proven** pipeline as the managed API the control plane calls.
   Deploying a known-good pipeline ≫ deploying one never run in the cloud (debugging the serverless
   wrapper AND the pipeline blind at the same time is the trap to avoid).

Same API destination either way — RunPod just reaches it without blocking on a big upfront port.

## RunPod compute-plane setup (concrete)

1. **Credit:** $15–25 to start.
2. **Network Volume FIRST:** 100 GB (~$7/mo), in a region that stocks the target GPU. Holds the
   HunyuanVideo training/inference weights + LoRAs so they persist across pods (never re-download).
3. **Pod (on-demand, attached to the volume):**
   - Start **RTX 4090 (24 GB)** (~$0.34–0.69/hr) — fp8 FramePack fits 24 GB, current pipeline runs
     unchanged. Community Cloud = cheapest.
   - Upgrade **RTX 5090 (32 GB)** (~$0.30–0.90/hr) — native fp8, kills the offload tax → single-digit
     minute renders + headroom.
   - Template: official **ComfyUI** or **PyTorch 2.x / CUDA 12**; mount volume at `/workspace`; expose
     `8188` (ComfyUI) + SSH; run `saga-install.sh` / `saga-dp-setup.sh` against it.
4. **Never buy:** reserved/committed instances, a separate VPS, anything always-on. Spin up → render
   → **stop** (billing halts; the volume persists).

**Standing cost ≈ $7/mo storage.** Everything else is per-second, only while a pod runs.

## Cost model (why this beats both ElevenLabs and buying)

- ElevenLabs Creative: reseller credit markup on video → non-viable at volume (130k-token trial gone
  in ~20 min).
- Buy a 5090: ~$2,000–3,500 capital **and** it re-introduces Dina contention on the local box.
- **Rent + run SAGA:** ~$0.10–0.30/clip compute + ~$7/mo storage, **no** local contention, and it
  *uses* the banked SAGA pipeline (the `saga-install`/`saga-dp-setup`/`saga-hunyuan-fetch` scripts are
  already an automated provisioner — exactly what a fresh pod needs).
- Direct model APIs (Kling/Luma/Veo, **not** via ElevenLabs) at ~$2/20 s (Kling) or cents (Luma) are
  the complement for shots that are **not** the user's character (environments, effects, b-roll).

## Proven bring-up (verified live 2026-08-12 — the recipe to codify into `saga-cloud.sh`)

Everything reusable installs under `/workspace` so it survives pod stop. New container ⇒ fresh
`~/.bashrc`, so `source /workspace/SAGA/saga.env` each session.

1. **Volume first**, pod attached to it. `apt: jq ffmpeg git tmux`.
2. **Dir tree:** `SAGA_ROOT/{engine,tmp}` + `models/{checkpoints,diffusion_models,vae,clip_vision,text_encoders,controlnet,ipadapter,loras,upscale_models,ultralytics/bbox,loras_video/framepack}`.
3. **ComfyUI:** clone to `engine/ComfyUI`; `python3 -m venv --system-site-packages venv` (reuse the
   pod's torch 2.8 cu128 — no multi-GB re-download); `pip install -r requirements.txt`;
   `rm -rf models && ln -s $SAGA_ROOT/models models`.
4. **Nodes:** `ComfyUI-FramePackWrapper` + `ComfyUI-VideoHelperSuite` (+ their `requirements.txt`)
   **+ `pip install peft`** (FramePackLoraSelect needs it to load the LoRA — the #1 render-time
   failure if missing).
5. **Models (fp8 set — the proven 24 GB config):** FramePackI2V_HY_fp8_e4m3fn
   (`Kijai/HunyuanVideo_comfy`→diffusion_models), hunyuan_video_vae_bf16 (Kijai→vae),
   sigclip_vision_patch14_384 (**`Comfy-Org/sigclip_vision_384`**→clip_vision), clip_l +
   llava_llama3_fp8_scaled (`Comfy-Org/HunyuanVideo_repackaged/split_files/text_encoders/`→
   text_encoders, flatten out of `split_files/`). **Verify sizes** (16.3G / 471M / 817M / 235M / 8.5G).
6. **LoRA** (not on HF): rsync from TUGRRPORTAL `models/loras/animegabriel_hy_e10.safetensors`.
   **Scripts** (if repo not cloned on the pod): rsync `/var/www/dina-server/src/modules/saga/scripts/`
   → `/workspace/SAGA/scripts/`.
7. **Launch** ComfyUI (`nohup venv/bin/python main.py --listen 127.0.0.1 --port 8188 &`, ~30–40 s to
   bind — a 30 s health-check false-negatives), then `saga-framepack.sh --check`, then render.

## Operational lessons (hard-won 2026-08-12 — don't relearn them)

- **HuggingFace 429 from RunPod IPs** is IP-level (shared datacenter IP), bursty, and hits *auth*
  endpoints too — a token can't fix an edge-throttled IP. Fixes: an `until hf download …; sleep 15`
  **retry-loop**; a **fresh pod IP** (stop/start); or **rsync from TUGRRPORTAL** (slow, ~2 MB/s home
  upload, but guaranteed). `HF_TOKEN` must be **`export`ed** and a valid token is `hf_…` format.
  **404 ≠ 429** — a 404 means wrong repo (the loop spins uselessly); e.g. sigclip is in
  `Comfy-Org/sigclip_vision_384`, not Kijai's.
- **EUR-IS-1 had a network outage** that made the volume "unavailable" and **truncated a completed
  16 GB download to 2 GB** — always **verify file sizes** after transfer on a flaky DC; stop/move
  rather than fight a degraded DC (a fresh IP often clears both the outage and the HF throttle).
- **rsync `chown … Operation not permitted`** on the network volume is cosmetic (data transfers; only
  ownership fails) — add `--no-owner --no-group`.
- **scp on Windows:** `cd` to the destination folder and copy to `.` (a `Z:\path` is misread as a
  host); use `-P` for the port and the exposed-TCP IP (not the container hostname).
- **`cu130` ComfyUI warning** is non-fatal — the optional comfy_kitchen CUDA backends disable on
  cu128 and it falls back to pytorch attention (sdpa), which is exactly what the FramePack graph uses.

## Parity milestone — 2026-08-12 ✅

First cloud render: `saga-framepack.sh -a wired_ronin_e10_00001.png -L 90 --fps 30 -W 640 -H 640
--lora animegabriel_hy_e10.safetensors --lora-weight 0.9 --gpu-keep 8` → `cloud_first.mp4`
(teacache 0.05). **User confirmed: motion smooth, identity locked.** Cloud reproduces the box exactly.
Infra chapter closed; SAGA is back in the creative testing/tuning phase, on rented GPU that never
touches Dina's card.

## Flux image-LoRA on the pod (ai-toolkit) — bring-up + the gauntlet (2026-08-18)

Training a Flux.1-dev **character** LoRA on the pod (Little One) via ostris/**ai-toolkit** (venv-ait,
separate from ComfyUI's venv). `saga-flux-lora-dataset.sh` builds the flat image+txt set;
`saga-flux-lora-train.sh` fills `training/lora_flux.yaml.tmpl` and launches `run.py`. Every failure
below was hit for real and is now guarded by the script — don't relearn them:

- **Free the GPU first.** ai-toolkit needs ~22 GB; a running **ComfyUI holds ~20 GB** and the run OOMs
  at the *quantize* step (`transformer.to(...)`). Kill ComfyUI before training. `pkill -f
  "ComfyUI/main.py"` **misses** — the real cmdline is `…/venv/bin/python main.py --listen`, so kill by
  PID: `nvidia-smi` → `kill -9 <pid>`. The trainer now refuses to launch below 20 GB free.
- **torchaudio import wall.** ai-toolkit's `config_modules.py` does `import torchaudio` unconditionally.
  The pod's bleeding-edge **torch `2.13.0+cu130` has NO matching torchaudio wheel** (cu130 index tops out
  at 2.11) → `ModuleNotFoundError`. Image-LoRA never uses audio, so **stub it**: write a fake
  `torchaudio/__init__.py` in venv-ait's site-packages (module `__getattr__` → `MagicMock`, plus
  `sys.modules.setdefault("torchaudio.<sub>", MagicMock())` for submodule imports). The trainer detects
  the missing module and prints the exact stub command.
- **HF Xet backend drops.** The new Xet transfer fails mid-download on RunPod IPs
  (`File reconstruction error: Internal Writer Error: Failed to send data: receiver dropped`, in
  `xet_get`). Fix: `export HF_HUB_DISABLE_XET=1` → plain resumable HTTPS. Do **not** set
  `HF_HUB_ENABLE_HF_TRANSFER=1` (errors if the package is absent). The trainer exports the disable.
- **Disk: cache goes to the container disk by default → EDQUOT.** HF caches to `/root/.cache/huggingface`
  on the **~30 GB container overlay** (quota'd); the FLUX.1-dev training set is **~34 GB** (transformer
  23.8 G bf16 + T5-XXL 9.5 G + CLIP 246 M + VAE 168 M) → `[Errno 122] Disk quota exceeded`. Set
  `HF_HOME=/workspace/hf_home/huggingface` to park it on the volume. **The volume has a quota too**:
  MooseFS `df` shows the *cluster* (petabytes) but EDQUOT fires at *your* volume's limit — a **100 GB
  volume is too tight** with ~70 GB of models already present; **bumped to 200 GB** (non-destructive
  resize; may need a pod stop/start to apply on a live pod). The trainer sets `HF_HOME` to the volume.
- **Valid HF token required even with the license accepted.** ai-toolkit pulls gated FLUX.1-dev; a real
  token is `hf_…` (~37 chars). Verify before the 24 GB pull: `HfApi().whoami(token=…)['name']`. A
  malformed token 401s at `whoami-v2`.

**First successful train (2026-08-18):** rank 16, 494 U-Net modules (TE frozen), 28-image dataset
bucketed at 704×832 + 928×1120, quantize=true, ~2.87 s/step, ~2 h for 2500 steps on the 4090. Samples
every 250 steps → `tmp/lora/little_one/samples/` (prompts request unseen poses = the generalization
read for the v1→v2 bootstrap).

## Next build step
`saga-cloud.sh` — codify the §"Proven bring-up" recipe so a fresh pod goes zero-to-render in one
command (with the HF-vs-rsync model fetch and the size-verify built in). Builds on the existing suite.
Fold in the Flux-LoRA env (`HF_HOME` on the volume, `HF_HUB_DISABLE_XET=1`, the torchaudio stub) so
`saga.env` carries them and a fresh pod trains without re-hitting the gauntlet above.
