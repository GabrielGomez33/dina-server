# SAGA — Live Verification Log

Record of what was proven on the live `tugrr-portal` box, per phase. Infrastructure values (concrete
paths, user ids, tenant ids) are redacted — the record is the *outcomes*, not the secrets.

## Phase 1 — Foundation live (dark launch) — ✅ SIGNED OFF 2026-07-15

**Pre-deploy gates (on the box):** proof harnesses green — gpu 43 / saga 97 / render 29 / routes 38;
`npm run type-check` + `npm run build` clean; migration `003_saga_core` applied (7 `saga_*` tables);
database backed up before and after the migration (`--single-transaction --no-tablespaces`).

**Deploy:** `dina-server` reloaded clean under pm2. Startup log confirmed:
```
🛡️ GPU Arbiter registered (enforcement: off — dark launch)
🎬 Phase 5/5 — SAGA Module → ✅ SAGA ready (execution engine: Phase 2)
```

**Live API checks — all passed:**

| Check | Request | Result |
|---|---|---|
| Status, unauthenticated | `GET /saga/status` | `200` (non-sensitive module/version/method list) |
| Create tenant | `POST /saga/tenants` (plan=admin) | success; quota resolved to 3.5 TB; `saga_memberships` row role=`owner` |
| **Authz boundary** | `POST /saga/<non-member-tenant>/projects` | **`403 FORBIDDEN`** — not a member (the security boundary, proven live) |
| Create project | `POST /saga/<tenant>/projects` | success; row persisted `status=active`; `storageRoot` under `$SAGA_ROOT/tenants/<t>/projects/<p>` |
| Input validation | `POST /saga/tenants {"name":""}` | `400 INVALID_REQUEST` |
| No-regression | `@Dina` chat | unchanged (arbiter `off` → byte-identical LLM path) |

**Bug found & fixed during Phase 1:** the route response extractor was copied from the mirror
double-wrap pattern and mis-classified SAGA's single-wrap `{success,data}` shape, returning HTTP 500
on every SAGA request. Root-caused, fixed (`extractSagaResult`), and covered by a new
`routeContractTest` (38 assertions reconstructing the exact orchestrator envelope). Commit `b94d6c6`.
Lesson logged: the HTTP→DUMP→extraction round-trip now has explicit test coverage; module-handler
unit tests alone were insufficient.

**Known follow-ups (non-blocking, tracked separately):**
- **Arbiter go-live** — flip `DINA_GPU_ARBITER=on` + reload when single-GPU load-balancing is wanted;
  rollback is the same flip back to `off`.
- **Pre-existing mirror debt** — `mirror_user_context` / `mirror_user_metadata` tables missing on this
  box (a mirror migration never run here; errors predate SAGA). Unrelated to SAGA; fix on its own.
- **Phase 0 engine** — ✅ now live and proven; see the section below.

## Phase 0 — Engine live (ComfyUI + render pipeline) — ✅ SIGNED OFF 2026-07-15

**Engine:** ComfyUI (pinned tag) running under pm2 as `saga-comfyui`, bound localhost-only
(`--listen 127.0.0.1 --port 8188`). GPU-backed (CUDA available). Triton JIT resolved
(`python3.12-dev` provided `Python.h`).

**Model tree consolidation:** collapsed the two competing model roots into ONE canonical tree
(the managed SAGA storage tree); ComfyUI's built-in `models/` is now a symlink to it, and the
redundant `extra_model_paths.yaml` indirection was retired. Single source of truth — no model can
be "in the wrong root" again. Starter checkpoints in place: an anime SDXL model and a general
FLUX model, each provenance-hashed in the tree's `MANIFEST.txt`.

**Proven live (all passed):**

| Check | Result |
|---|---|
| Base text→image render | ✅ SDXL 1024², 28 steps, ~9 s warm |
| **GPU coexistence (the core Goal-#1 question)** | ✅ Ollama held 2 models **100% GPU (not evicted)** while a full SDXL render ran alongside — peak ≈ 13 GB of 23 GB. The single-GPU contention fear does **not** materialize for the SDXL-class path; it space-shares cleanly. (Arbiter *exclusive drain* is reserved for the heavy video models that genuinely can't fit next to Ollama.) |
| Prompt control | ✅ mood fully steerable — weighted tags `(dark:1.4)`, `(black background:1.3)`, `(glowing red eyes:1.3)` pulled the model out of its bright-heroic prior into a dark/ominous result |
| Single-subject control | ✅ the model's "giant + tiny onlooker" scale-prior (a spurious 2nd figure) suppressed via negative `(2boys:1.4), multiple people, extra person`. Note: this is a *prompt* mitigation; ControlNet is the eventual *structural* guarantee |
| **Reference conditioning (IP-Adapter)** | ✅ `IPAdapterUnifiedLoader` + `IPAdapterAdvanced` with `ip-adapter-plus_sdxl_vit-h` + CLIP-ViT-H. A classic reference image transferred subject identity onto the generation while the prompt kept mood. Weight dial characterized live: **0.5–0.7 = identity locked + coherent; ≥0.8 = reference overpowers structure (forms melt).** This is the first rung of the consistency stack, working. |

**Bug found & fixed live:** `IPAdapterAdvanced` rejected `weight_type:'standard'` (an older node
label) — `value_not_in_list`. Corrected to `linear` in both the box script and the repo template
(`image-reference@1`), with a regression-guard assertion. Commit `07f73c5`.

## Phase 0.5 — First video (Wan I2V) — ✅ PIPELINE VERIFIED 2026-07-15

**Wan 2.2 TI2V-5B image→video ran end-to-end on the box.** The provisional template validated
live on the FIRST submit — no node/socket errors — through UNETLoader → CLIPLoader(wan) →
WanImageToVideo → KSampler(uni_pc/simple) → VHS_VideoCombine → mp4. Template `video-i2v-wan@1`
de-flagged from provisional.

| Check | Result |
|---|---|
| Manual exclusive drain | `ollama stop` → GPU **278 MB** used of 23 GB (card cleared for the heavy model) |
| Wan graph accepted | queued with **no rejection** (node names correct first try) |
| Render | **703 s** for 33 frames @ 704×1280, 30 steps → `saga_video_00001.mp4` (first video calibration point) |
| Output | coherent subject + motion; palette/menace preserved |

**Known issues (params, not graph):**
- **Slow (703 s):** ComfyUI streamed the 5B weights (low-VRAM mode, ~1.5 GB resident) + 30 steps.
  Fixes: resident VRAM mode, steps→20, and a **Wan speed LoRA** (4–8 steps). NOT an arbiter issue.
- **Subject tiling** (repeated figures): extreme 704×1280 portrait; use Wan-native 1280×704.
- **Not anime / not-exact-Exodia:** prompt lacked style/identity tokens; Wan's default aesthetic is
  semi-realistic. Add style tokens; anime video needs an anime-tuned approach.

## Phase 0.6 — Primary anime video (Wan I2V-A14B + lightning) — ✅ VERIFIED 2026-07-17

**The anime video target, hit — fast.** Wan 2.2 **I2V-A14B GGUF Q6_K** (MoE: high + low noise
experts) + the two **4-step LightX2V lightning LoRAs**, two-stage KSampler handoff, 4 steps / CFG 1.
The 18-node graph was **accepted on the first submit** (no node/socket errors).

| Metric | Result |
|---|---|
| Render | **126 s** @ 1280×704 × 33 frames, 4 steps (vs 373 s for the 5B at 20 steps) |
| Style | **flat 2D cel-shaded anime** achieved (`anime, 2d, cel shaded` tokens + A14B) — the look the 5B could not hit |
| Coherence | single figure, clean; no tiling |
| VRAM | Q6_K expert (~11 GB) stays **resident** (the headroom bet paid off — no offload penalty) |

**Decision:** A14B-lightning is now the **primary `video_gen` profile** (`video-i2v-wan-a14b@1`);
the 5B is demoted to a lighter fallback. Both are `heavy → exclusive` (drain Ollama). Registry +
templates + tests updated (registry 31, worker 38, prompt 45, render 29 green). Model provenance
manifest regenerated (17 files hashed).

**Open (params, not graph):** motion smoothness at 4 steps (→ RIFE interpolation if steppy);
optional anime-style LoRA to push styling further; expert step-split (currently 2/2 of 4) untuned.

**Known follow-ups from Phase 0 (next work):**
- **Hands** — universal diffusion weakness (seen: merged/miscounted fingers when hands are in
  frame). Fix is Stage 3 refinement: a detailer pass (Impact-Pack + `hand_yolov8`), not an
  embedding. Tracked in `TOOLCHAIN.md`.
- **`saga-comfyui` runs as root** under pm2 — outputs land root-owned. Housekeeping: relaunch as
  `dina`. Non-blocking.
- **Arbiter still dark** — flip to `on` once the heavy (video) stages that need exclusive turns
  come online.
