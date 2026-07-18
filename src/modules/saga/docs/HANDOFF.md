# SAGA — Handoff / State of the World

> **Read this first.** This is the single canonical "where are we, why, and what's next" doc for
> the SAGA subsystem, written so the next iteration (of Claude, or of a human) can resume with zero
> loss. It is the *living state*; the other docs are reference depth. Update the **Status ledger**
> and **Recent prompts** sections every working session. Last updated: **2026-07-18**.

Companion docs (reference, not state): `PHASES.md` (original plan), `VERIFICATION.md` (live proof
log), `TOOLCHAIN.md` (every tool), `RESEARCH_ANIME_PIPELINE.md` (model research),
`REFERENCE_FIDELITY.md` (consistency laws), `PREPRODUCTION_AND_FRAMERATE.md`, `OVERVIEW.md`,
`INTEGRATION.md`, `ENVIRONMENT.md`.

---

## 1. The Goal (and its facets)

**Build SAGA** — *Synchronized Audio-visual Generation Architecture* — a local, enterprise-grade
subsystem inside the existing **DINA** server (`dina-server`, a Node/TypeScript AI-coordination
server) that lets the user **produce anime-style shows/videos**: a video-editor-timeline
workstation for making anime episodes.

The end product is a **video-editor timeline workstation** where the user lays out generated visual
clips and multi-track audio into a sequence, then exports a finished anime show.

Facets of the goal, all in scope:
- **Anime image generation** with **character consistency** across shots (the #1 pillar — same
  character must look the same every time).
- **Anime video generation** (image→video), directed motion, multi-beat action.
- **Polish**: detailer (faces/hands), upscaling to 1080p–2K, frame interpolation for smoothness.
- **Custom characters** via a **LoRA training subsystem** (teach the model a permanent character).
- **Cinematography controls**: framing/angles/optics/camera-motion/filters as first-class knobs.
- **Audio**: the user's **own music** *sometimes*; **AI-inferred sound effects** (rain, sword
  clashes, energy build-up), **dialogue (TTS)**, ambience, **mouth/lip-sync**, all on a
  **multi-track timeline** with per-segment sync (beat-synced vs free).
- **The timeline/NLE**: proxy editing — build with cheap draft clips, run the expensive passes
  (upscale/detailer/filters) only at export, only on surviving clips.

**Hardware reality:** a **single RTX 3090 Ti (24 GB VRAM)**, shared with **Ollama** (DINA's LLM
stack). Everything is designed around this one shared card. This constraint drives most decisions
(quantization, resident-vs-offload, the GPU arbiter, exclusive drain for heavy models).

### The standing enterprise mandate (applies to ALL work, verbatim from the user)

> "Please make sure to implement enterprise tactics, robustness through error handling and edge
> cases, security and effectiveness through ux and ui. Pay attention to the already established
> infrastructure. Different modules that handle separate concerns. No intertwined logic. Organized
> workflows and pipelines. Enterprise level tactics. We are software engineers looking to create
> efficient and intelligent products. Strong foundations and stronger building blocks and double
> checks for possible mistakes or unforeseen errors/bugs/races/detrimental situations. Please get
> into the habit of providing proofs and tests backing up all of your statements regarding the
> logic. It will help us both."

**Operational translation** (what this means in practice, followed every session):
- **One module = one concern.** No intertwined logic. Pure core modules (no I/O) separated from
  systems (I/O, orchestration) separated from routes (HTTP).
- **Every logic module ships with a proof harness** (`tests/<module>Test.ts`, hermetic ts-node,
  `ok/eq/section/throws` helpers, ends with `process.exitCode`). Claims about behavior must be
  backed by a passing test *or* a live verification recorded in `VERIFICATION.md`.
- **Prove it live** on the box before declaring anything works (video render, coexistence, node
  graphs). "It should work" is not acceptable — run it.

---

## 2. Security / infra constraints (NON-NEGOTIABLE)

- **Branch:** develop and push ONLY to `claude/dina-server-analysis-9wjtkc`. Never another branch
  without explicit permission. No PRs unless the user explicitly asks.
- **Model identity:** never put the model identifier (`claude-opus-4-8`) in commits, PR titles/bodies,
  code comments, or any pushed artifact — chat replies only.
- **Secrets/paths:** infrastructure paths, tenant ids, user ids, secrets live ONLY in the untracked
  `.env` (never committed). Docs redact concrete values and use `$SAGA_ROOT` etc. Env vars stay out
  of `ecosystem.config.js` (see commits `fd7840b`, `3c3a1ae`).
- **Repo scope:** `gabrielgomez33/dina-server` only.
- **Commit trailer** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SvwvUYNuJkrcKJbPPqCmrh
  ```
- **ComfyUI** is bound localhost-only (`--listen 127.0.0.1 --port 8188`), pinned tag, PM2-managed as
  `saga-comfyui`. Custom nodes go through allowlist review.

---

## 3. Where we are — Status ledger

Legend: ✅ done & proven · 🟡 in progress · ⬜ not started

### Infrastructure phases (the DINA-integration backbone)
- ✅ **Phase 0 — Engine live**: ComfyUI service, GPU hygiene, model tree consolidated, first image,
  **GPU coexistence proven** (Ollama resident + SDXL render coexist ~13 GB/23 GB). Signed off
  2026-07-15 (`VERIFICATION.md`).
- ✅ **Phase 1 — Backend integration**: GPU arbiter wired (dark launch, `off`), migration
  `003_saga_core` applied (7 `saga_*` tables), saga module + routes live, authz boundary proven
  (403 for non-members). Signed off 2026-07-15.
- 🟡 **Phase 2 — Render engine**: `GenerationWorker` orchestration keystone built & tested (ports
  injected). **Live adapters NOT yet wired** (still uses test doubles) — see roadmap step 3.
- 🟡 **Phase 3 — Video & assembly**: video generation **proven live** (A14B, 126s); polish passes
  proven; **timeline model built & tested**. Assembly/export engine not built. Draft/final tiers not
  wired into the worker yet.
- ⬜ **Phase 4 — Audio & story**, ⬜ **Phase 5 — Workstation UI**.

### The creative/generation pipeline (what actually makes anime)
- ✅ **Anime image base**: Animagine XL 4.0 (Euler a, 28 steps, CFG 5–6). Flat 2D cel look achieved.
- ✅ **Reference conditioning (consistency rung 1)**: IP-Adapter working; weight dial characterized
  (0.5–0.7 identity-locked; ≥0.8 melts forms).
- ✅ **Fidelity dial (0–10)**: one control coordinating IP-Adapter/ControlNet/denoise. Tested (66).
- ✅ **Anime video (primary path)**: Wan 2.2 **I2V-A14B GGUF Q6_K** (MoE high+low experts) + dual
  **LightX2V 4-step lightning LoRAs**, two-stage KSampler handoff. **126 s @ 1280×704 × 33 frames**.
  Flat cel-shaded anime, single figure, no tiling, experts resident. Verified 2026-07-17.
- ✅ **Polish stage** (all three proven live): **Detailer** (FaceDetailer + `hand_yolov8`, denoise
  0.3 preserves designed props); **Interpolation** (RIFE VFI, `dtype=float32`); **Upscale**
  (anime-ESRGAN `4x-AnimeSharp` chosen as default — SUPIR softens anime, kept photoreal-only).
- ✅ **Framerate policy**: `planFramerate()` — render low fps → RIFE-interpolate up; 60fps on anime
  = soap-opera-effect warning. Tested (45).
- ✅ **Cinematography vocabulary**: `cinematography.ts` routes friendly terms to the right mechanism
  (prompt tag / video-prompt / ffmpeg post). Tested (61 → now with timeline, see below).
- ✅ **Timeline / NLE model**: `timeline.ts` — Sequence/Track/Clip, multi-track audio, validation,
  export plan. Tested (68). Commit `72f0dc1`.
- ✅ **Keyframe / FLF choreography (directed motion)**: `keyframeChoreography.ts` — pins poses as
  still keyframes and plans first-last-frame (FLF2V) transitions between them; the fix for the
  jutsu render's improvised action. Tested (42). Provisional FLF template `video-flf-wan-a14b@1`
  (FLF node confirmed present on the box; full render still the gate). Commit `d37aee0`.
- ✅ **Pipeline planner**: `pipeline.ts` — the production pipeline (generate→detail→interpolate→
  upscale→filters) as an explicit plan: content-based stage recommendations + user overrides +
  **readiness cross-check** (blocks/surfaces any stage whose node/model is absent, instead of the
  hardcoded box-script chains that silently skipped the hand detailer). Tested (38). **← most recent
  module.** Seeded by the 2026-07-18 box audit (`CURRENT_BOX_READINESS`) — **entire pipeline is
  installed, nothing missing** (incl. ControlNet Union Promax for seal-forcing).
- 🟡 **LoRA subsystem**: **plan-gate only** (`loraTraining.ts`, `resolveLoraPlan`, tested 25). The
  actual trainer (kohya_ss install + dataset builder + training worker + registration) is NOT built.
- ⬜ **Audio subsystem** (multi-track): TTS, AI SFX (text-to-audio + video-to-audio foley), music
  stems (Demucs), transcription (WhisperX), lip-sync. Designed, not built.
- ⬜ **Assembly/export engine**: consumes `ExportPlan` → renders the final video. Not built.

### The user's LOCKED roadmap (order is fixed by the user)
1. ✅ **Polish** (detailer / upscale / interpolation) — done & proven.
2. 🟡 **LoRA subsystem** — plan-gate done; trainer pending (**this is the next big build**).
3. ⬜ **Live adapters** — wire `GenerationWorker` ports to the real arbiter / ComfyClient transport /
   DB / WebSocket progress.

Then: cinematography controls (✅ vocabulary done), then the **timeline/assembly model** (🟡 model
done, assembly engine pending), then the **audio subsystem**.

---

## 4. The module inventory (code that exists, what each does, its proof)

All under `src/modules/saga/`. **core/** = pure (no I/O, unit-tested). **systems/** = I/O &
orchestration. **tests/** = proof harnesses. Run any via `npm run test:saga:<name>`.

| Module | Concern | Proof (assertions) | Key commit |
|---|---|---|---|
| `core/promptNormalizer.ts` | tag normalize / split / assemble; reference prompt (no subject slot) | promptSystems | `5b2ad5c` |
| `core/modelRegistry.ts` | model profiles + resource policy (heavy→exclusive) | models (31) | `c3cd68a` |
| `core/fidelity.ts` | 0–10 dial → ipAdapter/controlnet/denoise params | fidelity (66) | `3deb962` |
| `core/framerate.ts` | fps plan (generation fps + interpolation factor) | framerate (45) | `283b59e` |
| `core/loraTraining.ts` | LoRA training-request validation gate | lora (25) | `fc0d30d` |
| `core/cinematography.ts` | route cine terms → prompt/camera/ffmpeg | cine (61) | `7dbde6c` |
| `core/timeline.ts` | NLE sequence/track/clip + validation + export plan | timeline (68) | `72f0dc1` |
| `core/keyframeChoreography.ts` | FLF (first-last-frame) directed-motion planner | keyframe (42) | `d37aee0` |
| `core/pipeline.ts` | stage recommend + override + model-readiness planner | pipeline (38) | (this commit) |
| `systems/generationWorker.ts` | orchestrate a generation job (ports injected) | worker (38) | `80b65c2` |
| `systems/workflowTemplates.ts` | ComfyUI node-graph templates (image/ref/video) | render (29) | multiple |
| `systems/comfyClient.ts`, `jobQueue.ts`, `progressMapper.ts` | transport / queue / progress | render/foundation | Phase 1–2 |
| `sagaRoutes.ts`, `index.ts` | HTTP surface + module wiring | routes (38), foundation (97) | `b94d6c6` |

**ComfyUI templates that are VERIFIED LIVE** (in `workflowTemplates.ts`):
- `TEMPLATE_IMAGE_BASIC` — SDXL text→image.
- `TEMPLATE_IMAGE_REFERENCE` — + IP-Adapter (`PrepImageForClipVision`, `weight_type:'linear'`).
- `TEMPLATE_VIDEO_I2V_WAN` — Wan 5B (fallback).
- `TEMPLATE_VIDEO_I2V_WAN_A14B` — 18-node MoE lightning graph (**primary**, verified on first submit).

**Box scripts** (operational, live on the box under `$SAGA_ROOT/`, NOT in the repo — they're the
manual verification tools): `saga-render-ref.sh`, `saga-video-a14b.sh`, `saga-interpolate.sh`,
`saga-detail.sh`, `saga-upscale.sh`, `saga-esrgan-video.sh`, `saga-jutsu.sh` (A–Z orchestrator),
`saga-manifest.sh`.

---

## 5. Key technologies & why we chose them

**Generation engine — ComfyUI.** Driven via its HTTP API (`/prompt`, `/history`, `/object_info`)
with graphs submitted as JSON node-graphs. Chosen for its node-graph flexibility (any pipeline is a
graph) and because it exposes everything (IP-Adapter, ControlNet, GGUF loaders, RIFE, upscalers) as
nodes. We validate node/socket names against `/object_info` before trusting a template.

**Anime image — Animagine XL 4.0.** An anime-tuned SDXL. Understands danbooru tags. We tried generic
SDXL first — user's verdict: *"If SDXL is not up to par then let us not even waste our time."* — so
we moved to the anime-tuned checkpoint (image) and Wan (video). Settings: Euler a, 28 steps, CFG 5–6.

**Character consistency stack (in order of strength):**
`seed → IP-Adapter (identity from a reference image) → ControlNet (structure/pose) → LoRA (permanent
character)`. This is *the* pillar of the project. The **fidelity dial (0–10)** exposes this as one
UX control: 0 = free drawing, 10 = almost-copy.

**Anime video — Wan 2.2 I2V-A14B (GGUF Q6_K) + LightX2V lightning.** Two competing options existed:
- **TI2V-5B** (fallback): smaller, but slower here (373 s @ 20 steps) and its default aesthetic is
  semi-realistic, not flat anime.
- **I2V-A14B** (primary): a **Mixture-of-Experts** (a *high-noise* expert + a *low-noise* expert,
  two-stage KSamplerAdvanced handoff), run as **GGUF Q6_K** (~11 GB/expert) so the expert stays
  **resident** on the 24 GB card (no streaming penalty), with **two 4-step LightX2V lightning LoRAs**
  → 4 steps / CFG 1. Result: **126 s**, flat cel anime. This won the A/B decisively.

*Why GGUF Q6_K, not fp8:* Q6_K fits resident on 24 GB and holds quality; the headroom bet (spend
VRAM to avoid offload) paid off. *Why lightning LoRAs:* 4 steps vs 20+ is the difference between 126 s
and minutes. A **phantom** earlier claim that a *5B* 4-step LoRA existed was disproven by the user's
box query (LightX2V only ships **A14B** LoRAs) — that's part of why we're on A14B.

**Polish choices (all decided by live A/B, not theory):**
- **Upscale = anime-ESRGAN `4x-AnimeSharp`** (default, stills + video): crisp cel lines, ~1–3 s/frame,
  temporally stable. **SUPIR** was researched as the premium option but the live A/B showed it
  *softens flat anime into a painterly look* at ~90 s/frame → demoted to an optional photoreal-only
  mode. Research said one thing; the box corrected it. **Never upscale previews/thumbnails.**
- **Interpolation = RIFE VFI** — smooths 4-step lightning steppiness. Render low fps, interpolate up.
- **Detailer = Impact-Pack FaceDetailer + `hand_yolov8`** at **denoise 0.3** — cleans faces/generic
  hands while *preserving designed props* (a character's chains survive; 0.5 re-invents them).
  Design-specific hands/props are ultimately a **LoRA** job, not a detailer job.

**Framerate policy:** authentic anime is **24–30 fps**; **60 fps on anime = the soap-opera effect**
(reads as cheap video, not animation). So we render low and RIFE-interpolate up only when motion
needs it. `framerate.ts` encodes this with pros/cons facts.

**Efficiency strategy — proxy editing:** during production we generate **many low-res draft clips**
(video gen cost scales with pixels), lay them on the timeline, and run the **expensive passes
(upscale/detailer/filters) only at export, only on surviving clips**. `timeline.ts` is what makes
this possible (draft `sourceId` now, heavy pass at `ExportPlan` time).

**GPU arbiter:** DINA's GPU coordinator. **Dark launch (`off`)** today — SDXL-class work
*space-shares* cleanly with Ollama (proven), so no arbitration needed yet. Heavy **video** models
genuinely can't fit beside Ollama → they're marked `heavy → exclusive` in the registry and will
trigger **exclusive drain** (stop Ollama → render → re-warm) once the arbiter is flipped `on`.

**Audio (designed, not built):**
- **AI SFX has two distinct mechanisms** (this distinction matters): **text-to-audio** (Stable Audio
  Open, AudioLDM2) for *ambience/library* sounds from a description; **video-to-audio foley**
  (MMAudio, FoleyCrafter) for *synced* SFX that hit on-screen action (a sword clash landing on the
  frame it connects). SFX generation is **toggleable per region** of the timeline (user's explicit
  ask — some areas AI-scored, some not).
- **TTS/dialogue:** Parler / F5 / XTTS candidates. **Music stems:** Demucs. **Transcription/timing:**
  WhisperX. **Lip-sync:** mouth-sync to dialogue. All Phase-4.

---

## 6. What worked / what didn't (the discovery log)

**Worked:**
- GPU coexistence for SDXL-class work (space-shares, Ollama not evicted). The core Goal-#1 fear did
  not materialize.
- Model-tree consolidation to one canonical `$SAGA_ROOT/models` via symlink (retired the
  `extra_model_paths.yaml` indirection) → a model can never be "in the wrong root" again.
- A14B video on first submit (18-node graph, no node/socket errors) — validating node names against
  `/object_info` first paid off.
- Directed multi-beat motion in a *single* Wan prompt: hands together → apart → dark energy beam,
  over 81 frames, character consistent, chains preserved.
- The test-first discipline caught real bugs *before* commit (see below).

**Didn't work / corrected:**
- **"Neutral prompting" (Law 1 v1) — user: "Complete and utter failure."** I had built a rule to
  *drop the subject word* when using a reference image. Wrong: the test subject (Exodia) IS a known
  danbooru tag, so dropping it removed the anchor and the model drifted to generic anime. **Fix:**
  anchor on what the model KNOWS; neutrality is *conditional*, not universal. (`7825a57`)
- **Per-subject tuning — user: "Exodia is the guinea pig... changes should affect all future ones."**
  Do not special-case the test character; every fix must be subject-agnostic and systemic.
- **SUPIR for anime** — research recommended it; live A/B proved it softens anime → ESRGAN default.
- **Phantom 5B lightning LoRA** — I claimed it existed; box query disproved it → moved to A14B LoRAs.
- **Two-entity / tiling** — the model's scale-prior spawned a spurious 2nd figure; mitigated via
  negatives (`(2boys:1.4)...`) as a *prompt* patch; ControlNet is the eventual *structural* fix.

**Bugs found & fixed (mostly caught by tests/live before shipping):**
- Route extractor mis-classified SAGA's single-wrap `{success,data}` envelope (copied from the
  mirror's double-wrap) → **HTTP 500 on every SAGA request**. Root-caused, fixed
  (`extractSagaResult`), covered by `routeContractTest` (38). (`b94d6c6`)
- `promptNormalizer` "3D_ rendered" bug: `(\w)_(\w)` missed underscore-before-space → regex changed
  to `/(?<=\w)_|_(?=\w)/g`. Caught by the harness before commit.
- IP-Adapter `weight_type:'standard'` rejected (`value_not_in_list`) → `'linear'`. (`07f73c5`)
- RIFE VFI missing required inputs (dtype/torch_compile/batch_size); then `dtype:'fp32'` rejected →
  `'float32'`.
- `JobKind` type conflict: worker imported the broad `JobKind` (types.ts) but `resolveProfile` wants
  the narrow `'image_gen'|'video_gen'` → imported `JobKind as GenJobKind` from modelRegistry.
- `sudo pip` blocked for user `dina` ("not allowed to execute pip as root") → run **non-sudo** (dina
  owns the venv).

---

## 7. Migrations & data

- **`003_saga_core`** — applied & signed off (Phase 1). Creates **7 `saga_*` tables** (tenants,
  memberships, projects, models, generations, etc.). Backed up before AND after
  (`mysqldump --single-transaction --no-tablespaces` — the app user lacks `PROCESS`, by design; see
  `92b6416`). Membership row role `owner`; authz boundary (403 for non-members) proven live.
- **Pre-existing mirror debt (unrelated to SAGA):** `mirror_user_context` / `mirror_user_metadata`
  tables missing on this box (a mirror migration never run here). Errors predate SAGA; log noise
  silenced (`e4472b5`). Fix on its own track.
- Migration runner: `npm run migrate` / `migrate:status` / `migrate:down`.

---

## 8. Environment / operational facts

- **Box:** single **RTX 3090 Ti, 24 GB** (~23 GB usable), shared with Ollama.
- **ComfyUI:** PM2 process `saga-comfyui`, **runs as root** (outputs land root-owned — housekeeping
  TODO: relaunch as `dina`). Localhost-only, pinned tag.
- **DINA server:** PM2 `dina-server`. Arbiter env flag `DINA_GPU_ARBITER` (currently `off`).
- **venv:** owned by `dina`; use **non-sudo pip**.
- **Storage:** `$SAGA_ROOT` on the 4 TB NVMe; `StoragePaths` is root-agnostic + traversal-proofed.
- **I (Claude) CANNOT see video** — only stills/frames. The user extracts frames with `ffmpeg` for
  review. Always ask for frames, don't claim to have "watched" a clip.
- **SageAttention** not yet installed (free ~30% video speedup) — a pending optimization.

---

## 9. In-flight / immediately pending

- ✅ **20s jutsu A–Z render** (`saga-jutsu.sh`): DONE. **Quality + length + character consistency all
  held** (cel-shaded Exodia, consistent across two chained ~10s segments, smooth, upscaled — the
  end-to-end visual pipeline works). The ONE gap: the model **improvised the action** (generic
  fists / a stray purple void) instead of performing the exact seals → prayer → contained sphere.
  Root cause: single-prompt text can't choreograph discrete poses. Two notes: the chain did NOT run
  the hand-detailer pass (and it wouldn't have helped — detailer cleans, it can't choreograph a
  seal); ESRGAN sharpened the malformed fingers. **→ built the FLF/keyframe path as the fix** (see
  the module above). Next: author the seal/prayer/sphere keyframes and verify FLF2V on the box.

## 10. Next steps (in the user's locked order)

1. **Review the 20s jutsu output** when the user provides frames (validate the A–Z pipeline).
2. **LoRA subsystem build** (roadmap step 2 — the next big one): install **kohya_ss** on the box →
   smoke-test a training run → build the dataset builder + training worker + registration flow, each
   with a proof harness. The plan-gate (`loraTraining.ts`) already validates requests before GPU
   spend; this builds the trainer behind it.
3. **Live adapters** (roadmap step 3): wire `GenerationWorker`'s injected ports (`GpuLeaseProvider`,
   `ComfyExecutor`, `GenerationStore`, `ProgressSinkPort`) to the real arbiter, ComfyClient
   transport, DB, and WebSocket progress. Then flip the arbiter `on` for the heavy video path.
4. **Assembly/export engine**: consume `ExportPlan` from `timeline.ts` → ffmpeg concat + transitions
   + per-track audio mix + the deferred heavy passes → final video.
5. **Audio subsystem** (Phase 4): TTS, AI SFX (both text-to-audio and video-to-audio, per-region
   toggle), Demucs, WhisperX, lip-sync.
6. **Workstation UI** (Phase 5): the timeline front-end on the locked design system.

Pending optimizations: install **SageAttention** (~30% video speedup); relaunch `saga-comfyui` as
`dina`; consider the keyframe (first/last-frame) path for precise beat-timing.

---

## 11. The working rhythm (how every module gets built)

1. Write the **module** (core = pure, no I/O; one concern).
2. Write `tests/<module>Test.ts` — `ok/eq/section/throws` helpers; **assert each invariant rejects
   its exact bad state**; end with `process.exitCode = failed===0?0:1`.
3. Add `"test:saga:<name>"` to `package.json`.
4. `npx ts-node ...` → iterate to **green**.
5. `npx tsc --noEmit` → **clean**.
6. Commit with the required trailer → `git push -u origin claude/dina-server-analysis-9wjtkc`.
7. If it's a live capability, prove it on the box and record the outcome in `VERIFICATION.md`.

---

## 12. Recent prompts (most-recent last) — the conversational thread

Kept so the next iteration knows the *arc*, not just the code. Trimmed to intent.

1. **Cinematography question:** "How do we deal with angles and shots — wideshots, headshots — and
   bokeh, vintage, and filters like negative? Is this another step or handled in prompting?" → led to
   `cinematography.ts` (routes each term to prompt / camera / ffmpeg post).
2. **"Right after SUPIR."** — build the cinematography module after the SUPIR/upscaler decision.
3. **"Yes, do the anime-ESRGAN comparison."** — the A/B that made ESRGAN the default and demoted SUPIR.
4. **"Let us test a video with this pipeline now A–Z. Exodia 20s performing hand signs for a jutsu
   which then leads to the beam of light. From generation to smoothing to final upscaling."** → the
   `saga-jutsu.sh` render now in flight.
5. **Timeline realization:** "We'll generate many low-quality (pre-upscale) visuals during production,
   laid out in a scene/sequence in the front end — like a video editor timeline. Same for sound,
   right?" → confirmed proxy-editing model; motivated `timeline.ts`.
6. **Audio/SFX:** "It won't always be my songs — it's a show that features my music sometimes. How
   will we infer sound effects — rain, sword clashes, energy building up? Will AI do this too? It'll
   have to be toggled for certain areas." → designed the two-mechanism AI-SFX model (text-to-audio +
   video-to-audio foley) with per-region toggle + multi-track audio on the timeline.
7. **"Yes, build the timeline.ts now."** (+ the enterprise mandate verbatim) → built `timeline.ts` +
   68-assertion harness (commit `72f0dc1`).
8. **"The context window is filling up. Create an in-depth md file: the goal and its facets, the
   phases and the current one, extreme detail on technologies, discoveries, what works/didn't, why we
   chose things, migrations, last 10 prompts — so handoff to the next iteration is smooth."** → **this
   document.**

*(Earlier arc, for context: proved GPU coexistence → consolidated the model tree → built the image
base + IP-Adapter reference + fidelity dial → moved from SDXL to Wan for video → landed A14B-lightning
anime video → proved the polish stage → framerate policy → LoRA plan-gate → cinematography → timeline.)*
