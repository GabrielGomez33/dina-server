# DINA GPU Runbook — "Dina is slow / running on CPU"

**Box:** `tugrr-portal` · **GPU:** NVIDIA GeForce RTX 3090 Ti (24 GB) · **Inference:** Ollama (separate process from `dina-server`)

This runbook covers the #1 latency regression: **Ollama silently running models on the
CPU instead of the GPU.** It is almost always an NVIDIA driver/library version skew
caused by an unattended `apt` upgrade that was not followed by a reboot.

---

## 0. TL;DR decision tree

```
Responses suddenly slow (≈ pre-GPU speeds)?
        │
        ▼
  run:  nvidia-smi
        │
        ├─ ERROR "Driver/library version mismatch"  ──►  Section 1  (REBOOT to fix)
        │
        └─ OK (lists the 3090 Ti)
                │
                ▼
          run:  ollama ps
                │
                ├─ shows "100% CPU"   ──►  Section 2  (RESTART OLLAMA to re-load on GPU)
                │
                ├─ shows "xx%/yy% CPU/GPU" (split) ──► Section 3 (model too big / VRAM full)
                │
                └─ shows "100% GPU"  ──►  GPU is fine. Look elsewhere (prompt size, queue depth).
```

---

## 1. Driver / library version mismatch  (the original outage)

### Symptom
```
$ nvidia-smi
Failed to initialize NVML: Driver/library version mismatch
NVML library version: 580.159
```
…and `ollama ps` shows every model at `100% CPU`.

### Why it happens
The NVIDIA **userspace libraries** were upgraded on disk, but the **kernel module still
loaded in memory** is the old version. Until they match, CUDA/NVML is dead and Ollama
falls back to CPU. Confirmed on this box:

| Component | Version (during outage) |
|---|---|
| Loaded kernel module (`cat /proc/driver/nvidia/version`) | `580.126.09` |
| Installed userspace libs (`dpkg -l \| grep nvidia`) | `580.159.03` |
| DKMS module built for kernels `6.8.0-110`, `6.8.0-124` | `580.159.03` |

The DKMS module for the new version is already built — the running kernel just needs to
load it.

### Fix
```bash
sudo reboot
```
A reboot loads the matching `580.159.03` module. (If a reboot is impossible right now, see
"Module reload without reboot" below — but reboot is the reliable fix.)

### Verify after reboot
```bash
nvidia-smi                       # must show Driver Version: 580.159.03, lists 3090 Ti, no error
cat /proc/driver/nvidia/version  # NVRM version must now read 580.159.03
```
✔ Confirmed working state looks like:
```
NVIDIA-SMI 580.159.03   Driver Version: 580.159.03   CUDA Version: 13.0
NVIDIA GeForce RTX 3090 Ti ... 1960MiB / 23028MiB
```

### Module reload without reboot (only if you truly cannot reboot)
```bash
sudo systemctl stop ollama
sudo rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia
sudo modprobe nvidia nvidia_uvm
nvidia-smi
sudo systemctl restart ollama
```
If `rmmod` reports "Module ... is in use", a process (Xorg, ollama, persistence daemon)
still holds the GPU → **reboot is required.**

---

## 2. GPU is healthy but `ollama ps` STILL says "100% CPU"

### Symptom (the state right after fixing the driver)
```
$ nvidia-smi        →  healthy, shows the 3090 Ti and ollama processes
$ ollama ps
NAME                        SIZE      PROCESSOR    UNTIL
mxbai-embed-large:latest    739 MB    100% CPU     24 hours from now
mistral:7b                  6.1 GB    100% CPU     24 hours from now
qwen2.5:3b                  2.6 GB    100% CPU     24 hours from now
```

### Why it happens
The models were loaded **onto the CPU during the broken window**, and Dina requests them
with **`keep_alive: 24h`**, so they stay resident for 24 hours. **Ollama never migrates an
already-loaded model from CPU to GPU** — it stays on whichever processor it was loaded
onto until it is unloaded and re-loaded. A plain `systemctl start ollama` is a no-op if
the service is already running, so it does **not** reload them.

### Fix — force a clean reload onto the now-working GPU
```bash
sudo systemctl restart ollama      # full RESTART (not start) — evicts all loaded models
```
Then trigger a fresh load (any one of these):
```bash
ollama run qwen2.5:3b "hi"         # manual load, or
# simply send one @Dina message in the app (dina-server warmup will also reload)
```

### Verify
```bash
ollama ps
# EXPECTED now:
# NAME            SIZE      PROCESSOR    UNTIL
# qwen2.5:3b      2.6 GB    100% GPU     ...
# mistral:7b      6.1 GB    100% GPU     ...

nvidia-smi                          # memory-usage should rise to ~7-10 GB with models loaded
```

### If it STILL loads on CPU after a clean restart
Ollama isn't detecting the GPU. Check its own startup log:
```bash
sudo systemctl restart ollama
journalctl -u ollama --no-pager -n 200 | grep -iE "gpu|cuda|nvidia|library|inference compute"
```
Look for a line like `inference compute ... library=cuda ... name="NVIDIA GeForce RTX 3090 Ti"`.
If it says `library=cpu` or reports no GPU:
- Ensure the Ollama service can see the driver (a host reboot usually resolves this after a driver change).
- Confirm the Ollama version supports the installed CUDA/driver: `ollama --version` and update if old (`curl -fsSL https://ollama.com/install.sh | sh`).
- Make sure `CUDA_VISIBLE_DEVICES` is not set to an empty/invalid value in the ollama service env.

---

## 3. Model loaded as a CPU/GPU split (`xx%/yy% CPU/GPU`)

### Why
The model + its KV cache exceed the 24 GB VRAM budget, so Ollama offloads the overflow
layers to CPU. Common triggers: a `codellama:34b` (~19 GB) or `llama2:70b` (~39 GB) was
requested, or several big models are resident at once, or `num_ctx` is very large.

### Fix
- Don't auto-route to oversized models. `dina-server` now enforces this (see
  `src/modules/llm/llmConfig.ts` + `resolveModel()` in `manager.ts`): oversized models are
  refused unless `DINA_ALLOW_OVERSIZED=true`.
- Keep `OLLAMA_MAX_LOADED_MODELS` small (1–2) so a big model can't co-reside and evict the
  workhorses (see `ops/ollama.service.d-override.conf`).
- Lower `DINA_NUM_CTX` if you pushed it high.
- Stop a stuck model: `ollama stop <model>`.

---

## 4. Prevent recurrence (do this once, after Section 1 is verified)

### 4a. Freeze the driver so apt can't silently skew it again
```bash
sudo bash ops/pin-nvidia-driver.sh     # apt-mark hold on the nvidia-*-580 packages
```
After this, driver updates are **manual + deliberate**, and every manual update is followed
by a reboot. (Script + rationale in `ops/pin-nvidia-driver.sh`.)

### 4b. Remove the stale second driver metapackage
You currently have **two** driver metapackages installed:
```
nvidia-driver-550   550.163.01     ← stale, remove
nvidia-driver-580   580.159.03     ← active, keep
```
After confirming 580 works (Section 1):
```bash
sudo apt-get purge nvidia-driver-550
sudo apt-get autoremove
# then reboot and re-verify nvidia-smi
```

### 4c. Enable persistence mode (driver stays initialized, faster first load)
```bash
sudo systemctl enable --now nvidia-persistenced
nvidia-smi -pm 1
```

### 4d. Tune the Ollama service for single-GPU stability
Apply `ops/ollama.service.d-override.conf` (keep_alive, max-loaded-models, flash attention,
quantized KV cache). Instructions are in that file's header.

---

## 5. The safety net that makes this self-announcing

`dina-server` now ships a **GPU residency monitor** (`src/modules/llm/gpuMonitor.ts`) that
polls Ollama `/api/ps` every 60s and compares `size_vram` to `size`. The moment a model is
on CPU (or split), it logs a loud `🔴 [gpuMonitor]` alert and flips the `gpu.healthy` flag
in the status payload, surfaced via:

- `GET /dina/api/v1/status`        → `modules.llm.gpu`
- `GET /dina/api/v1/mirror/status` → mirror module health (consumed by mirror-server)

So next time the driver drifts, you'll see **"Dina is running on CPU"** within a minute —
not after users complain about latency.

### Quick manual check anytime
```bash
bash ops/verify-gpu.sh
```