# dina-saga — Readiness Plan ("sharpen the sword")

Gap analysis performed before commencing phase 2b. Seven gaps identified across the shipped design
(arbiter, foundation slice, preprod ladder). Each entry: the risk, the fix, and when it lands.
Ordering inside each phase is deliberate — durability and calibration precede anything that renders.

---

## GAP 1 — Durability & disaster recovery  ⟶ phase 2b (first)

**Risk.** The 4TB SSD is a single point of failure; crashes corrupt quota counters; orphan files
accumulate invisibly.

**Design insight that makes this cheap:** generations store seed + params + model + lineage, so
rendered output is *re-rollable* and needs no backup. The irreplaceable set is small:

| Must back up (nightly rsync to second disk/cloud) | Re-rollable (no backup) |
|---|---|
| MySQL DB (the "compressed backup" of everything) | all generated images/video |
| raw refs, audio source | stems/analysis (recompute) |
| trained LoRAs, promoted exports | previews, tmp |

**Build items**
- `backup.sh` + runbook: mysqldump + rsync of the must-back-up set; restore drill documented.
- Boot recovery: jobs in state `running` at startup → `failed` (reason `crash_recovery`) + policy-based
  re-enqueue. Idempotent job execution (output dir per gen id; partial output overwritten on retry).
- Janitor reconciliation sweep: filesystem scan vs `bytes_used` (drift repair) + orphan-file
  removal (files with no DB row older than 24h). Proof harness: drift/orphan decision functions pure.

## GAP 2 — Model supply chain  ⟶ phase 2b (before first model download)

**Risk.** 400GB of checkpoints with no version/hash/license tracking; unpinned Python deps (the same
failure class as the documented NVIDIA driver drift); ComfyUI custom nodes are arbitrary community
code executing on the box.

**Build items**
- `saga_models` registry table: name, family, version, sha256, source URL, disk path, size,
  **license**, enabled flag. Download tooling verifies hash; workflows reference registry ids, not
  raw paths.
- ComfyUI runs from a **pinned venv** (requirements freeze committed to ops/); upgrades are manual +
  deliberate + smoke-tested (mirror the pin-nvidia-driver.sh discipline).
- Custom-node allowlist in ops runbook; nodes reviewed before install; no auto-update.

## GAP 3 — Licensing awareness  ⟶ policy now, enforcement with GAP 2

**Facts that matter for a publishable story:** Wan 2.x = Apache 2.0 (commercial OK).
FLUX.1 **dev** = non-commercial license; FLUX.1 **schnell** = Apache 2.0. HunyuanVideo community
license carries territory/scale restrictions. Community anime checkpoints/LoRAs: per-model terms.

**Build items:** `license` + `commercial_ok` fields in the model registry; UI badge + filter;
generation rows already record `model`, so any output's provenance is auditable after the fact.

## GAP 4 — Hardware ground truth (calibration)  ⟶ phase 2b (before ETA code)

**Risk.** All quoted numbers are published benchmarks, not this box. ETAs derived from them are
fiction; the progress bar's credibility dies first.

**Build items**
- One-time calibration suite (`ops/calibrate-saga.sh` + a small runner job): measures s/frame at
  480p/720p per video model, model load seconds, upscale fps, RIFE fps, TTS chars/sec, on THIS
  hardware. Results stored in `saga_calibration` and consumed by the ETA estimator that feeds
  `JobProgress.eta_seconds`.
- Golden-path smoke test: tiny end-to-end render (image → 1s video → upscale → interpolate →
  assemble) as the post-deploy health check; wired next to `npm run test:saga` as `test:saga:gpu`
  (requires the real card; skipped in hermetic CI).
- Re-run calibration after any model/driver/ComfyUI upgrade (append-only history → regression visible).

## GAP 5 — Ingest security & asset serving  ⟶ phase 2b (with upload endpoints)

**Risk.** Uploads (refs, audio) and asset downloads are the module's real attack surface; express
json limit (1MB) is irrelevant to them.

**Build items**
- Multipart uploads with per-plan size caps; **magic-byte content sniffing** (never trust
  extension/mime header); ffprobe structural validation for audio/video; image decompression-bomb
  guard (pixel-count cap before full decode); uploads renamed to server-generated safe names
  (storagePaths already enforces the final gate).
- Asset serving: membership-checked, short-lived signed URLs; HTTP Range support for video scrubbing;
  no directory listing; paths always resolved through StoragePaths (proven traversal-safe).
- Rate limits on generation endpoints (per-user, per-tenant) — cheap insurance even single-tenant.

## GAP 6 — Observability: GPU-seconds, disk, success rates  ⟶ phase 2b (cheap, do early)

**Build items**
- `gpu_seconds` on `saga_jobs` (arbiter lease hold time — already measured, just record it);
  per-project/tenant GPU-time rollups next to bytes_used.
- Disk watermark alerts at 80%/90% of the 4TB (janitor emits; surfaces in module status + logs) —
  a full disk mid-render is the ugliest failure mode we can cheaply prevent.
- Render success-rate + retry-count tracking per model/workflow (a degrading workflow becomes
  visible instead of anecdotal).
- GPU thermals: extend gpuMonitor snapshot with temperature/power draw (nvidia-smi query) and note
  the sustained-load power-limit recommendation (`nvidia-smi -pl 380`) in the ops runbook.

## GAP 7 — The script layer (story → scenes → shots)  ⟶ phase 2b/2c seam

**Risk.** The pipeline starts at the shot list, but the workstation's actual input is the STORY.
Without this, the most labor-intensive creative step (breaking script into shots) stays manual and
outside the system.

**Build items**
- `saga_scripts` table (project-scoped, versioned text) + `saga_breakdown_script` DUMP method:
  feeds the script to Dina's EXISTING LLM stack (mistral/qwen via a **shared** arbiter lease — runs
  beside renders, never against them) to draft scenes + shots: suggested camera angles, extracted
  dialogue, holdLoop-vs-action shot typing, transition suggestions.
- Output lands as `draft` rows in saga_scenes/saga_shots — the human edits and **approves**;
  the stage-gate ladder (PREPRODUCTION_AND_FRAMERATE.md) takes over from there. LLM proposes,
  author disposes.
- Proof harness: breakdown-parsing pure functions (LLM output → validated scene/shot drafts,
  malformed-output containment).

---

## Revised phase-2b build order

1. **Calibration + smoke harness** (GAP 4) — ground truth before anything renders
2. **ComfyUI worker + comfyClient** — exclusive arbiter lease, batch-grouped; records gpu_seconds (GAP 6)
3. **Model registry + pinned env** (GAPs 2/3) — before the first big download
4. **Crash recovery + backup + janitor reconciliation** (GAP 1)
5. **Migration 004** (preprod tables) **+ upload/serving security** (GAP 5)
6. **Script breakdown** (GAP 7) + animatic assembler
7. Voice gen (Maya1/Orpheus, shared leases) — slots in anywhere after 2

Each step ships with its own hermetic proof harness (established convention) plus, from step 1
onward, the GPU smoke test for hardware-touching pieces.
