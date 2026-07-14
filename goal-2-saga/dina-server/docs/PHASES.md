# DINA / SAGA — Phase Plan

**SAGA** — *Synchronized Audio-visual Generation Architecture* (a saga is a long story; this is the
machine that tells yours). Storage root: `/mnt/nvme_tugrrstorage2/Dina/SAGA` — configured via
`SAGA_ROOT`; no code change required (StoragePaths is root-agnostic and traversal-proofed).

| Phase | Name | Delivers | Gate to next |
|---|---|---|---|
| **0** | Environment pre-flight | storage tree, GPU hygiene, ComfyUI service, starter models, first manual image | checklist below all ✅ |
| **1** | Backend integration | GPU arbiter wired, migration 003, saga module + routes live | `/dina/saga/status` green, 97+29 proofs green in-tree |
| **2** | Render engine | generation worker + calibration + progress WS; first image through the API | end-to-end image job w/ live progress |
| **3** | Video & assembly | Wan templates, draft/final tiers, upscale + RIFE, hold/chained shot types | first 1080p/30 clip delivered |
| **4** | Audio & story | audio analysis, TTS voices (Maya1/Orpheus), script breakdown, preprod tables, animatic | first animatic of a real scene |
| **5** | Workstation UI | mirror-server frontend on the locked design system; janitor/backup hardening | first music-video draft end-to-end |

---

## PHASE 0 — Environment pre-flight (no dina-server code changes)

Everything here is host setup; nothing touches the running Dina ecosystem. Order matters.

### 0.1 — Storage tree on the 4TB NVMe

```bash
sudo mkdir -p /mnt/nvme_tugrrstorage2/Dina/SAGA/{models/{checkpoints,vae,clip,upscale,interpolation,lipsync,audio,loras},tenants,tmp,engine,backups}
sudo chown -R dina:dina /mnt/nvme_tugrrstorage2/Dina/SAGA
# Sanity: the volume is the big one and writable
df -h /mnt/nvme_tugrrstorage2 && touch /mnt/nvme_tugrrstorage2/Dina/SAGA/tmp/.writetest && rm /mnt/nvme_tugrrstorage2/Dina/SAGA/tmp/.writetest
```

Add to the PM2 env block (ecosystem.config.js) for later phases:
`SAGA_ROOT: '/mnt/nvme_tugrrstorage2/Dina/SAGA'`

### 0.2 — GPU hygiene (one-time, prevents the documented outage class)

```bash
bash ops/verify-gpu.sh                      # must report healthy + models 100% GPU
sudo bash ops/pin-nvidia-driver.sh          # freeze driver against silent apt skew
sudo systemctl enable --now nvidia-persistenced && sudo nvidia-smi -pm 1
sudo nvidia-smi -pl 380                     # ~85% power limit for multi-hour render duty
# Confirm the Ollama override is applied (keep_alive/max-loaded/parallel/flash-attn):
systemctl cat ollama | grep -E "OLLAMA_(KEEP_ALIVE|MAX_LOADED_MODELS|NUM_PARALLEL|FLASH_ATTENTION|KV_CACHE_TYPE)"
```

### 0.3 — ComfyUI as a pinned, localhost-only service

```bash
cd /mnt/nvme_tugrrstorage2/Dina/SAGA/engine
git clone https://github.com/comfyanonymous/ComfyUI && cd ComfyUI
git checkout <latest-release-tag>           # PIN the tag — record it in ops notes
python3 -m venv venv && source venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
pip freeze > /var/www/dina-server/ops/comfyui-requirements.lock   # supply-chain snapshot
```

Point ComfyUI at SAGA's model tree — `extra_model_paths.yaml` in the ComfyUI dir:

```yaml
saga:
  base_path: /mnt/nvme_tugrrstorage2/Dina/SAGA/models
  checkpoints: checkpoints
  vae: vae
  clip: clip
  loras: loras
  upscale_models: upscale
```

Run under PM2, **bound to localhost only** (never exposed):

```bash
pm2 start "venv/bin/python main.py --listen 127.0.0.1 --port 8188" --name saga-comfyui
pm2 save
curl -s http://127.0.0.1:8188/system_stats | head -c 300   # liveness + GPU detected
```

Custom nodes: NONE in Phase 0. Additions go through the allowlist review (READINESS GAP 2).

### 0.4 — Starter model set (images first; video models land in Phase 3)

Keep Phase 0 small — ~20 GB, all commercial-safe licenses:

| Model | Purpose | License | Dir |
|---|---|---|---|
| FLUX.1 **schnell** (fp8) | fast general images | Apache 2.0 | checkpoints/ |
| One anime SDXL (e.g. Animagine/Illustrious class) | the anime workhorse | check per-model | checkpoints/ |
| 4x-UltraSharp or RealESRGAN-anime | upscale | free | upscale/ |
| RIFE | interpolation (Phase 3, cheap to stage now) | MIT | interpolation/ |

For EVERY download record into `/mnt/nvme_tugrrstorage2/Dina/SAGA/models/MANIFEST.txt`:
`sha256sum <file>` + source URL + license. (This file seeds the saga_models registry in Phase 2.)
Deliberately deferred: FLUX dev (non-commercial license — decide with eyes open), Wan/Hunyuan
(Phase 3, ~80 GB), TTS models (Phase 4).

### 0.5 — First manual image + coexistence check (the Phase-0 exit test)

```bash
# 1. Generate one image via the ComfyUI UI (http://127.0.0.1:8188 over SSH tunnel)
#    with the anime checkpoint — confirms the whole engine path.
# 2. THE CRITICAL CHECK — coexistence behaviour on the shared card:
ollama ps          # BEFORE: warm set 100% GPU
#    ...run the ComfyUI generation...
ollama ps          # AFTER: confirm Ollama models were NOT silently pushed to CPU
nvidia-smi         # VRAM picture with both stacks up
# 3. Note wall-clock time of the generation — the first calibration datapoint.
```

Expected: an SDXL-class image fits beside the warm set; if `ollama ps` shows a split/CPU model,
that is the exact contention the GPU arbiter eliminates in Phase 1-2 (drain → render → re-warm) —
observing it once, deliberately, validates the whole design.

### Phase 0 exit checklist

- [ ] SAGA tree exists on the 4TB NVMe, owned by the dina user, `SAGA_ROOT` staged in PM2 env
- [ ] `verify-gpu.sh` healthy; driver pinned; persistence on; power limit set
- [ ] ComfyUI pinned + venv locked + PM2-managed + localhost-only; `/system_stats` sees the 3090 Ti
- [ ] Starter models downloaded, hashed, licensed in MANIFEST.txt
- [ ] One anime image generated manually; `ollama ps` coexistence behaviour recorded
- [ ] First timing datapoint noted (seeds Phase 2 calibration)

**Then Phase 1** = the two INTEGRATION.md guides on this branch, in order: goal-1 (arbiter) then
goal-2 (module + migration 003), each with its verification section.
