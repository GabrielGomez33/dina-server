# SAGA — Competitive Research & Accessible-Techniques Map

> **Purpose.** Imitate the competition's *techniques, technologies, and logic* using only non-proprietary,
> self-hostable methods, and map every finding back to SAGA's existing stack. Compiled 2026-08-18 from six
> parallel research tracks (competitors, image+consistency, video, audio+lip-sync, pipeline architecture,
> security+licensing). Each track cited its sources; the source index per section points back to them.
>
> **How to read licensing/pricing claims.** Model licenses and vendor prices change often (several changed in
> the last 18 months). Every license/price verdict traces to a primary source where reachable; **re-verify
> against the exact pinned model revision before any commercial launch.** This is engineering guidance, not
> legal advice — the licensing table is a decision aid, not counsel.

---

## 0. Executive summary — the decisions that fall out of the research

1. **Own the compute plane — this is the whole thesis, now quantified.** ElevenLabs' video "Studio" is a
   *reseller wrapper* around Veo/Kling/Sora with margin stacked on per-second cost: ~8,000 credits per Veo
   clip means **$22/mo ≈ 15 clips, $99/mo ≈ 75 clips** — exactly the "130k credits gone in 20 minutes" we
   lived. A self-hosted 4090 at ~$0.34–0.69/hr renders unbounded clips at marginal cost. SAGA's two-plane
   design is the correct structural answer; **protect it as the durable cost moat.**
2. **"Great still → animate" is the validated winning topology — and it's already ours.** Midjourney's video
   product uses the identical shape. Keep **Flux+LoRA as the hero stage, FramePack/Wan as the animate stage**;
   don't chase pure text-to-video.
3. **Character consistency is NOT a proprietary moat.** Runway Gen-4 "References" is openly-reproducible
   LoRA/IP-Adapter-class work we already own. The correct recipe: **LoRA owns identity, depth-ControlNet owns
   pose — decoupled.** (Openpose assumes human skeletons → it's *why* pose-control kept failing on a round,
   stub-limbed charcoal character. Use **depth**, not openpose.) Our **v1→v2 bootstrap** is documented SOTA.
4. **The only genuine technical frontier moat is Veo's native synchronized audio-video** (joint AV diffusion —
   no open model does it). SAGA's decoupled **FramePack + Kokoro + ffmpeg** is the *correct* open approximation,
   not a compromise — and for Little One's voiceover-over-visuals format we don't need joint AV at all.
5. **Licensing — three tracks independently flagged the same landmine: FLUX.1-dev is non-commercial.** Running
   dev in a commercial pipeline needs a paid BFL license, and a dev-trained LoRA inherits the restriction.
   Fine for tonight's R&D; **a pre-launch blocker for commercial Mirror content.** Commercial-clean stack the
   research converges on: **schnell / SDXL / SD3.5** (image), **Wan2.1/2.2 (Apache-2.0)** (video),
   **Kokoro (Apache-2.0)** (audio). **Ban XTTS (dead-vendor non-commercial) and MusicGen (CC-BY-NC).**
6. **Architecture: SAGA is ~70% there and above industry norm on the hard parts** (GPU arbiter, monotonic
   progress mapper, readiness checks, typed error taxonomy). The keystone gap is **the durable job queue behind
   `JobQueuePort` (still a `StubJobQueue`)** — P0 below — then eventing/reproducibility/observability.
7. **Security: ComfyUI is the highest-risk component, and we already do the most important thing right**
   (bound to `127.0.0.1`, not a public port). Remaining: pin custom nodes to reviewed SHAs, **safetensors-only**,
   block pod egress to cloud-metadata, rotate the leaked HF token, and add **EU AI Act Art. 50** AI-disclosure
   (mandatory 2026-08-02) at the publish step.

---

## 1. Competitor landscape (imitate the logic, not the vendor)

Everything that *looks* like a moat is one of: (a) a stronger base model — imitable by swapping in a better open
model; (b) character-consistency tooling we already own; or (c) non-technical go-to-market (Synthesia's
compliance, Adobe's indemnity, HeyGen's consent ops). The only real *technical* moat is Veo's joint AV.

| Product | Pipeline shape | Economics (2025–26, verify) | Native audio | Open equivalent | Real moat |
|---|---|---|---|---|---|
| **Runway Gen-4/4.5 + Act-Two** | t2v/i2v/v2v + refs + perf-capture | ~$0.50–1.00/1080p-sec | partial | Wan/Hunyuan + Flux LoRA/IP-Adapter; LivePortrait | data + control tooling |
| **Pika 2.x** | t2v/i2v + effects | ~40 cr / 5s 1080p; personal-use trap on low tiers | limited | Wan/Hunyuan + ComfyUI | UX/brand |
| **Luma Ray2** | t2v/i2v/keyframe | 11–32 cr/sec | limited | Wan/Hunyuan; FramePack extend | motion quality |
| **Kling 2.x/3.0** | t2v/i2v (+audio 2.6+) | 10 cr / 5s Std | yes (2.6+, unconf) | Wan/Hunyuan (chases Kling) | Kuaishou video-data scale |
| **Google Veo 3/3.1 + Flow** | t2v/i2v + **native sync audio** | API $0.15–0.75/sec | **yes — best** | **none open for joint AV** | joint AV training |
| **OpenAI Sora 2** | t2v/i2v + cameo + audio | API $0.10–0.70/sec; *shutdown rumor — verify* | yes (inconsistent) | Wan/Hunyuan + LoRA | model quality |
| **Midjourney V1** | **i2v only ("Animate")** | GPU-hours model | no | FramePack/Wan i2v | **still aesthetic** |
| **Adobe Firefly video** | t2v/i2v + Premiere Extend | 500 cr / 5s 1080p | no | any open model | legal indemnity + NLE |
| **HeyGen / Synthesia** | script→avatar | credit / minute-capped | TTS-driven | SadTalker/MuseTalk/LivePortrait | consent ops / enterprise compliance |
| **Captions/Mirage** | AI-actor-in-scene | credit-metered | yes | LivePortrait + i2v | in-house actor model |
| **Descript** | **transcript-based editor** | media-min + AI-credit meters | Overdub clone | Whisper + ffmpeg cut-list | editing UX |
| **ElevenLabs (TTS)** | TTS/clone/dub/music | 1 cr/char (~1k/min) | is audio | Kokoro/StyleTTS2/Chatterbox | expressive v3 model |
| **ElevenLabs (video)** | **reseller of Veo/Kling/Sora** | **~8,000 cr/Veo clip → ~15/mo on $22** | via wrapped model | **self-host = SAGA itself** | none (margin stacking) |

**Patterns worth imitating:** (1) still→animate topology (ours); (2) transcript/caption as the edit primitive
(Descript — we already burn captions via ffmpeg; formalize script→timed-caption→cut-list→ffmpeg); (3) keep an
open lip-sync module *on the shelf* (SadTalker/MuseTalk/LivePortrait) but don't build it now; (4) if SAGA ever
bills downstream, prefer **flat GPU-time**, not per-clip credits — every credit product here hits a volume cliff.

*Sources:* Runway pricing/Act-Two, Gemini/Veo API pricing, ElevenLabs credit breakdown (flexprice/eesel),
Midjourney GPU-hours, open lip-sync roundups — full URLs in the competitor track (archived in task transcript).

---

## 2. Open-tech capability map

### 2.1 Image (base models)
| Model | License | Commercial? | Role for SAGA |
|---|---|---|---|
| **Flux.1-dev** | FLUX.1 [dev] Non-Commercial | ❌ needs paid BFL license | R&D only today; **do not ship commercial on it** |
| **Flux.1-schnell** | Apache-2.0 | ✅ | commercial-clean default (train LoRA on a base, infer on schnell) |
| **Flux.1-Kontext-dev** | FLUX.1 [dev] Non-Commercial | ❌ needs BFL license | instruction-edit; great for **v2 dataset gen** (R&D) |
| **SDXL 1.0** | OpenRAIL++-M | ✅ no cap | richest adapter ecosystem (InstantID/IP-Adapter/every ControlNet) |
| **SD 3.5 L/M** | Stability Community | ✅ if org rev < $1M | clean middle ground |

### 2.2 Video (runnable on 24–32 GB)
| Model | License | Commercial? | 24 GB? | Notes |
|---|---|---|---|---|
| **Wan2.2 TI2V-5B** | **Apache-2.0** | ✅ | ✅ native 720p/24fps | **recommended primary upgrade**; deep LoRA ecosystem, FLF/VACE control |
| **Wan2.1 14B / FLF2V / VACE** | Apache-2.0 | ✅ | fp8+offload | first-last-frame + reference/pose control |
| **HunyuanVideo / FramePack** | Tencent Community | ⚠️ <100M MAU **AND excludes EU/UK/KR** | ✅ (FramePack 6 GB min) | **current engine**; length champion (~60–120s), but territory carve-out |
| **LTX-Video 0.9.8** | Custom (tiered) | ⚠️ under ~$10M rev | ✅ distilled | near-real-time previz lane |
| **CogVideoX 2B/5B** | Apache-2.0 (2B) / custom (5B) | ✅ (2B) | ✅ | capable fallback |
| **Mochi-1** | Apache-2.0 | ✅ | tight | **t2v only → not a keyframe animator; skip** |
| **SVD / AnimateDiff** | Stability / Apache | ⚠️ / ✅ | ✅ | superseded / short stylized loops only |

**Post-chain (all engines):** generate 480–720p → **RIFE** interpolate (2–3×) → **Real-ESRGAN** 2× → 1080×1920
encode. Cheaper and more controllable than native-1080p generation.

### 2.3 Audio (TTS / music / lip-sync)
- **TTS commercial-clean:** **Kokoro** (Apache-2.0, fixed voice = zero cloning-consent surface — keep as narrator),
  **Chatterbox** (Resemble AI, **MIT — the one top-tier *cloning* model with a clean license**, has a watermark),
  MeloTTS, Parler-TTS (prompt-described voice), StyleTTS2 (MIT, watch GPL phonemizer). **Ban:** XTTS/Coqui (CPML
  non-commercial, vendor defunct → unlicensable), F5-TTS / Fish-Speech (CC-BY-NC).
- **Music/SFX commercial-clean:** **Stable Audio Open** (< $1M rev, CC-trained) for beds/stingers, **ACE-Step**
  (Apache-2.0, no cap) for full tracks. **Ban:** MusicGen, AudioLDM2 (CC-BY-NC).
- **Lip-sync (future, if a character speaks on-screen):** photoreal-clean = **MuseTalk (MIT, real-time)**,
  **LatentSync (Apache-2.0, best quality)**, **SadTalker (Apache-2.0)**. **Ban:** Wav2Lip (LRS2 non-commercial
  weights), Sonic/EMO (NC/closed). LivePortrait is MIT *only if* you swap InsightFace→MediaPipe.
- **⚠️ Little One caveat:** every lip-sync model is trained on **real human faces** and will artifact on a
  charcoal hand-drawn character. The on-brand, license-clean path is **audio → forced alignment (whisperX /
  Montreal Forced Aligner) → 2D viseme/mouth-shape compositing (ffmpeg)** — art-directable, style-preserving,
  no model retrain. Reserve diffusion lip-sync fine-tuned on the character as an R&D experiment, not the plan.

---

## 3. Licensing decision table (cross-confirmed — treat as decided-fact)

| Model (role) | License | Commercial for SAGA? | Action |
|---|---|---|---|
| **Flux.1-dev** (image) | FLUX.1 [dev] Non-Commercial | ❌ without paid BFL license | Switch prod to **schnell**, or buy BFL commercial license + generation reporting |
| **Flux.1-schnell** | Apache-2.0 | ✅ | recommended default |
| **Flux.1-Kontext-dev** | FLUX.1 [dev] Non-Commercial | ❌ without BFL license | R&D dataset-gen only, or license |
| **SDXL 1.0** | OpenRAIL++-M | ✅ no cap | safe workhorse |
| **SD 3.5** | Stability Community | ⚠️ if org rev < $1M | Enterprise license before crossing $1M |
| **HunyuanVideo / FramePack** | Tencent Community | ⚠️ <100M MAU **AND not distributed EU/UK/KR** | **prefer Wan** if EU/UK audience possible |
| **Wan2.1 / Wan2.2** | Apache-2.0 | ✅ | recommended default video |
| **LTX-Video** | Custom (tiered) | ⚠️ under threshold | verify exact-version license |
| **Kokoro** (TTS) | Apache-2.0 | ✅ | current choice — keep |
| **Chatterbox** (TTS clone) | MIT | ✅ | the clean cloning option, if we ever mint a brand voice |
| **XTTS-v2 / Coqui** | CPML | ❌ non-commercial, vendor defunct | **never use** |
| **MusicGen** | CC-BY-NC-4.0 | ❌ | **never use** — Stable Audio Open / ACE-Step instead |
| **Stable Audio Open** | Stability Community | ⚠️ if org rev < $1M | track revenue |

**Two must-fix exposures before commercial launch:** (1) **Flux.1-dev** — swap to schnell or license it (and a
dev-trained LoRA inherits the restriction — plan to retrain on the commercial base); (2) **HunyuanVideo output
reaching EU/UK/South Korea** — migrate those workloads to Wan. **Keep XTTS and MusicGen out entirely.**

---

## 4. Character-consistency recipe (the core hard problem)

**Principle: separate identity from pose so neither method has to do both.**
**Identity ← LoRA (in the weights). Pose ← ControlNet (depth/openpose) in the spatial input.**

- **Redux locks composition** (pose+background) — it's an image-*variation* tool, not an identity tool. Correct
  use: bootstrap a *look* from one hero frame; never for a diverse character sheet. (This is exactly why v1's
  Redux-cloned set is pose-stiff.)
- **Openpose assumes human-proportioned skeletons** → use **depth ControlNet** for a round, stub-limbed
  character. This diagnoses the earlier pose-control failure loop precisely.
- **PuLID-Flux** (`--offload --fp8`, <17 GB) as a light **face-lock on close-ups**, not a whole-character method.
- **LoRA craft (validated defaults):** 15–30 varied images; rank 16 / alpha 16 / LR 1e-4 / ~2000–2500 steps /
  fp8 / adamw8bit; **caption only what VARIES** (pose/expression/framing/bg) so identity binds to the trigger;
  pick the **earliest checkpoint** where identity is locked but pose/expression still respond to the prompt.
- **Bootstrap v1→v2 (documented SOTA — our plan):** v1 LoRA captures the *look* (accept pose-stiff) → generate a
  **pose-varied** set with **v1 LoRA + depth-ControlNet** (and/or Kontext instruction edits) → curate ruthlessly
  → **v2 LoRA** has identity *and* flexibility. Avoid v3+ on purely synthetic data (model-collapse); keep a
  held-out canonical set as the retrain benchmark.

*If tonight's v1 samples come back pose-stiff, the next move is already decided — not guessed:* v1 + depth-CN to
build the v2 dataset.

---

## 5. Architecture — SAGA is ~70% there; the gap is the durable queue + eventing

The pipeline research read the actual control plane. Verified present: `systems/comfyClient.ts` (hardened HTTP+WS
client — overall timeout, stall watchdog, abort→`/interrupt`, single-close, prompt-id filtering, injected
transport for tests), `systems/generationWorker.ts` (lease-based worker + `classifyError` typed taxonomy:
`ENGINE_REJECTED/ENGINE_ERROR/TIMEOUT/STALLED/CANCELLED/ENGINE_UNREACHABLE/MODEL_NOT_FOUND`),
`systems/progressMapper.ts` (weighted, **monotonic** progress), `systems/jobQueue.ts` (**`StubJobQueue` behind a
`JobQueuePort`** — the seam), `systems/workflowTemplates.ts` (typed templates + bind), `core/pipeline.ts`
(ordered stage catalog with **readiness checks** — fail before the GPU), `core/quota.ts`, `core/ttlPolicy.ts`,
`core/storagePaths.ts` (tenant-isolated), `modules/gpu/gpuArbiter.ts` (single-GPU admission control, aging,
crash-watchdog, backpressure). **These are at or above industry norm.**

**The queue is the boundary between the planes.** The control plane must never call the GPU synchronously — it
enqueues; workers pull. That single principle gives backpressure/retries/autoscaling/degradation "for free."

**Staged plan (mapped to the code):**
- **P0 — Replace the stub queue (keystone).** `RedisJobQueue implements JobQueuePort` on **BullMQ** (Redis
  already a dep → no new datastore): durable enqueue, priorities, **exponential backoff + jitter driven by the
  existing typed error codes** (retry `ENGINE_UNREACHABLE/TIMEOUT/STALLED/GPU_UNAVAILABLE`; **never**
  `INVALID_REQUEST/MODEL_NOT_FOUND/ENGINE_ERROR`), a `saga:dlq` dead-letter queue, per-tenant concurrency/rate
  limits. A `WorkerRunner` pulls and calls the existing `GenerationWorker.run()`. **Idempotency key** =
  hash(tenant, template, bound inputs, seed, model digests) → BullMQ `jobId` + unique key in `GenerationStore`
  → duplicate/cached recipe short-circuits with **zero GPU**.
- **P1 — Eventing + live progress.** Concrete `ProgressSinkPort` → Redis pub/sub → **SSE/WS** relay to the
  browser keyed by `job_id`; persist ComfyUI preview frames to `previews/` and fill `JobProgress.preview_url`;
  end-to-end cancel via `cancel:{job_id}` → worker `AbortController` → existing interrupt path; terminal-state
  compare-and-set to resolve the interrupt-vs-complete race.
- **P2 — Reproducibility + content-addressed artifacts.** On success write the full replay record into the
  existing `SagaManifest` (frozen): seeds, **model file digests**, node/ComfyUI/ffmpeg versions, bound graph.
  Name artifacts by `recipe_hash` under `storagePaths.ts` (identical recipe → cache hit). Wrap
  `saga-assemble.sh` behind the `assemble` JobKind; **pin ffmpeg + flags** (containerize) for byte-reproducible
  output. Derive child seeds `seed + index` (varied *and* reproducible — the fix for "ten identical frames").
- **P3 — Multi-stage graph.** Promote `generate→detail→interpolate→upscale→filters→assemble` from the bash chain
  to **BullMQ parent/child flows**; migrate *only this graph* to **Temporal** later if per-stage resume-on-
  failure becomes a material GPU-cost saver (single-shot gen stays on BullMQ).
- **P4 — Observability + cost + serverless endpoint.** OpenTelemetry spans control-plane→queue→worker→ComfyUI
  keyed by `job_id`; **DCGM exporter** for GPU metrics; dashboards for queue depth / oldest-waiting-age / p95 /
  failure-by-error-class / **GPU-seconds & $/run per tenant** (lease timestamps already exist); per-tenant
  GPU-seconds/day budget at enqueue. Deploy the **fal.ai / RunPod-serverless** endpoint behind the same
  `ComfyExecutor` port so the control plane is endpoint-agnostic and can **circuit-break/fallback** by health+cost.

**Pod vs serverless crossover:** if `(hours-of-actual-GPU-work/day × on-demand $/hr) < (persistent $/hr × 24)`
and the latency SLA tolerates cold starts → serverless. A batch-render content shop favors serverless — which
validates the already-decided RunPod-first → fal-second sequencing. Run a one-week cost bake-off before
committing. **Don't** use ComfyUI's internal `/queue` as the job queue; **don't** adopt hosted ComfyUI-as-API or
Temporal wholesale; **don't** float model tags (pin by digest).

---

## 6. Security checklist (the "zero holes" mandate)

**Secrets**
- [ ] **Revoke the leaked HF token now**; issue a fine-grained, **read-scoped** replacement (revocation is what
      neutralizes the leak — scrubbing text does not).
- [ ] Audit the HF account for abuse during the exposure window; purge the value from transcript/logs/shell
      history/pod env.
- [ ] No secrets in code/images/workflow JSON; inject at runtime. **Long-lived secrets on the control plane
      only; compute pods get short-lived, least-privilege, read-scoped tokens.**
- [ ] GitHub secret scanning + push protection; `gitleaks`/`trufflehog` pre-commit. Treat AI/agent transcripts
      as untrusted sinks — never paste live secrets into chat.

**ComfyUI / pipeline** (highest-risk component)
- [x] ComfyUI bound to `127.0.0.1`, reached via SSH-tunneled localhost — **never a public port** (already done;
      an April-2026 botnet conscripted 1,000+ *exposed* instances).
- [ ] Custom nodes on an allow-list, **pinned to reviewed commit SHAs**; Manager auto-install disabled in prod
      (real trojaned nodes exist: ComfyUI_LLMVISION credential stealer, "Upscaler_4K" Akira stealer).
- [ ] **safetensors-only**; refuse/scan `.ckpt`/`.pt` (pickle = arbitrary code exec); `picklescan` on intake.
- [ ] Disable URL-fetch/LoadImage-from-URL in prod; **block pod egress to 169.254.169.254 (cloud metadata) and
      RFC1918**; enforce IMDSv2.
- [ ] GPU pods: non-root, ephemeral, egress allow-listed, no persistent secrets, per-job fresh.
- [ ] Any LLM step: treat input text as untrusted; schema-constrain output; no direct LLM control of URLs/paths.

**Supply chain**
- [ ] Weights pinned to HF **commit revisions**; nodes to SHAs; base images by digest. **SHA-256 verify every
      weight at boot** against a manifest (also catches truncated fp8 downloads — the EUR-IS-1 outage lesson).
- [ ] Only official org repos (black-forest-labs, stabilityai, Wan-Video, Tencent-Hunyuan, hexgrad/Kokoro);
      maintain an SBOM (model + node → source, revision, license, checksum) = license register + IR inventory.

**Provenance & legal**
- [ ] **EU AI Act Art. 50** machine-readable AI-marking before **2026-08-02** (existing systems by 2026-12-02):
      **C2PA Content Credentials** signed at ffmpeg assembly + an invisible **SynthID-class watermark** +
      platform "AI-generated" labels at publish + an internal per-asset provenance log (model+version+prompt+seed).
- [ ] **No cloning of any real voice/face/likeness** without signed, specific, informed consent + digital-replica
      license (Tennessee ELVIS Act, CA AB 1836/2602, etc.). Little One is fully synthetic — keep it that way.

---

## 7. Net recommendation

- **Keep the topology** (still→animate, decoupled AV, two-plane) — the research validates all three as correct
  and, in places, ahead of the field.
- **Near-term (this project):** finish the v1→v2 LoRA bootstrap using **depth-ControlNet** for pose; keep
  Kokoro; assemble with ffmpeg. All dev-based work stays **R&D**.
- **Pre-commercial-launch blockers:** migrate the production image base off **Flux-dev** (→ schnell/SDXL/SD3.5),
  migrate EU-facing video off **HunyuanVideo** (→ Wan2.2), and land the **Art. 50 provenance** layer.
- **Highest-ROI engineering:** **P0 durable queue (BullMQ behind `JobQueuePort`)**, then eventing +
  reproducibility manifests + observability. No re-architecture needed — the seams already exist.
- **On the shelf (not now):** Wan2.2-TI2V-5B as the primary video upgrade (re-train Little One's LoRA on Wan),
  LTX for previz, an open lip-sync/viseme module if a character ever speaks on-screen, Chatterbox if we mint a
  brand voice.

*Full per-track reports (with every source URL) are archived in this session's task transcripts; the source
indices in each track name the primary vendor/repo/paper links behind the claims above.*
