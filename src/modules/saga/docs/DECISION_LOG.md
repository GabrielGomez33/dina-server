# SAGA — Decision Log

Strategic decision records for the SAGA subsystem. Each entry is dated, states the decision, the
context that forced it, the reasoning, and the conditions under which it should be revisited. This
is the "why we chose what we chose" companion to `HANDOFF.md` (the "where are we" living state).

---

## 2026-07-22 — Build-vs-buy: pause self-hosted SAGA, adopt ElevenLabs / Eleven Creative for content

### Decision
**Stop leaning on self-hosted SAGA for content production. Use ElevenLabs + Eleven Creative
(hosted) as the primary engine for making visuals, stories, and content.** Keep SAGA banked and
resumable — do not delete it — but do not invest further engineering in it right now.

### What drove it
The goal was clarified this session: **"create my own visuals, stories, and content."** That is a
*creator* goal (make output), **not** an *owned-platform* goal (build identity-generation as the
product). Once the goal is "make things," the pipeline is a means, not the point — and the thing a
creator lives on is **iteration speed**.

### Reasoning (the honest weighing)
- **Iteration speed.** SAGA renders a single take in **~20–30 min** on the 24 GB 3090 Ti (dominated
  by the CPU-offload / PCIe tax, not compute). Hosted generates a clip in **minutes**, **hands-off**
  and **parallel** (queue several variations at once). A tool that makes you wait half an hour per
  idea quietly kills output.
- **Ecosystem disruption (the deciding con).** SAGA and Dina's `mirror` + `digim` share ONE GPU.
  The GPU arbiter time-shares (it cannot space-share — a ~12 GB warm LLM set + a 30 GB+ video model
  do not fit in 24 GB). A granted **exclusive** lease is **non-preemptive** (aging only reorders the
  *waiting* queue; the watchdog only frees a *crashed* holder), so every SAGA render **stalls
  interactive @Dina chat for the full 20–30 min**. Running SAGA in anger actively degrades a product
  that already works.
- **Cost.** Hosted clips run **cents to ~$2 each**. A 5090 is **~$2,000** (the ASUS ROG Astral
  variant we looked at is **$2,800–3,500** — flagship cooler, no inference benefit). Break-even is
  *thousands* of clips.
- **Quality-at-speed is a model gap, not a chip gap.** Hosted speed comes from proprietary,
  distilled models (Veo/Sora/Kling/Seedance) on **H100/H200 clusters**. No consumer GPU closes that
  on quality; it only closes raw speed on *our* open/stylized models.

### What SAGA proved (NOT wasted — banked)
- Trained HunyuanVideo LoRA **locks the user's identity** hard and consistently across frames.
- The **Wired Ronin aesthetic landed** (Lain + Afro Samurai; flat painterly shading, palette).
- The **full A–Z jutsu pipeline runs** (keyframes → single-take FramePack → polish/upscale/grade).
- All of it is **committed** on `claude/dina-server-analysis-9wjtkc`. Resumable with zero loss.

### Technical findings recorded this session (so we don't re-derive them)
- **FramePack near-static motion = TeaCache.** `teacache_rel_l1_thresh:0.15` cached away gradual
  head/body motion (only blinks survived). Fixed: TeaCache is now a knob (`--teacache` /
  `--no-teacache` / `FP_TEACACHE`), default lowered to **0.05 (motion-first)**. Second factor: tight
  face-crop framing has nothing but the face to animate — the full jutsu also needs a **wider K1**
  (upper-body) so hand-seals are in frame.
- **Single-take wiring.** `saga-jutsu-flf.sh` now drives framepack/ltx as first-class flags on the
  ONE pipeline: renders at `VIDEO_W/VIDEO_H` (640, not the 1024 keyframe res — the prior OOM cause),
  passes `--gpu-keep` for framepack, and generates **only K1** for single-take backends.
- **NVLink ≠ memory pooling (myth busted).** NVLink is a fast *interconnect*, not a 40 GB flat pool;
  a >24 GB model still needs explicit model-parallel splitting. And **no 16 GB card can NVLink a
  3090 Ti** (NVLink needs matching cards + bridge; consumer NVLink is **gone after the 30-series**).
  To stop SAGA starving Dina you want **two *separate* GPUs** (Ollama on a cheap 16 GB card, SAGA on
  the 3090 Ti) — workload separation, not pooling.
- **If self-hosting were the play**, the offload-killer is the **RTX 5090 (32 GB, native fp8)** — the
  plain TUF/PNY at ~MSRP, **not** the Astral. Even then, one 5090 only *reduces* Dina contention (fp8
  FramePack ~13 GB + LLM set ~12 GB ≈ 25 GB fits, but bf16 Wan/Hunyuan still want the whole card).

### Eleven Creative — what it actually is
Not ElevenLabs' own video model. It's a **beta platform wrapping the hosted models** (Veo, Sora,
Kling, Wan, Seedance) + ElevenLabs audio. Single-clip ceilings: **Sora 2 ~25 s, Seedance 2.0 ~15 s,
Kling 3.0 ~10 s, Veo 3.1 ~8 s** — so a 20 s piece is one Sora generation or a couple stitched.

### Recommended creator stack (for Project 1 / Wired Ronin)
- **Audio (score / voice / sound):** ElevenLabs — home turf, and Wired Ronin is *song-driven*.
- **Visuals (anime motion):** a hosted video model via Eleven Creative.
- **Edit / composite:** self, cut to the track. Beat-synced cutting was always the plan.
- Open question for hosted: keeping **the user as a consistent recurring character** across shots
  *without* the LoRA. If that consistency turns out to be essential and hosted can't hold it, that is
  the one creative reason to pull SAGA back out.

### Revisit SAGA only when BOTH are true
1. A **second GPU** exists so SAGA stops cannibalizing Dina's `mirror`/`digim`.
2. There is a **product surface that needs owned, private, per-user identity generation** (i.e. SAGA
   becomes the product, not a tool for one project).

Absent either, self-hosting is premature optimization on a capability with no consumer yet.
