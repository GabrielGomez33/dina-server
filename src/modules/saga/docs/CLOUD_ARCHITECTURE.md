# SAGA — Cloud Architecture (two-layer: control plane ↔ compute plane)

> **Status:** target architecture, adopted 2026-07-22 (see `DECISION_LOG.md`). SAGA runs on **rented
> GPU compute**, not the local 24 GB 3090 Ti — this removes the Dina `mirror`/`digim` contention
> entirely (SAGA is no longer on the same card) and turns capital cost into ~cents/clip pay-per-use.

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

## Next build step
`saga-cloud.sh` — a provisioner that takes a fresh RunPod pod from zero to first render: mount the
volume, run the install/setup scripts, fetch/verify models, health-check ComfyUI. Builds directly on
the existing script suite. (Deferred until a provider is chosen and an account exists.)
