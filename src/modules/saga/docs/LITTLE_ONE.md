# Little One — character bible & LoRA recipe (Mirror)

> **Status:** v1 LoRA trained and **verified production-usable** (2026-08-18). Identity binds; full-body
> renders reliably with the inference recipe below. This doc is the reproducible record — design,
> training recipe, inference recipe, and the hard-won gotchas. Don't relearn them.

## The character
Mirror's mascot: a **small, round, soft charcoal-grey character** — big round head, large glossy black
eyes, soft rosy cheeks, tiny stub arms and legs, a tiny hair tuft on top, tender/endearing. Plain
off-white paper ground. Aesthetic: moody hand-drawn charcoal/graphite (Serial-Experiments-Lain-adjacent),
**not** pink/purple, **not** photoreal. Canonical hero image: `SAGA_ROOT/refs/little_one_canon.png`.

## v1 LoRA — how it was trained (ai-toolkit, Flux.1-dev)
- **Trigger:** `l1ttl3one` (rare token; carries identity + style).
- **Dataset:** 28 stills, **Redux-cloned from the one hero canonical** (varied expression/framing, plain
  bg), flat `image + .txt` layout at `tmp/l1_dataset` (built by the explicit filename→caption map, see
  session history / `saga-flux-lora-dataset.sh`).
- **Captions — the critical rule:** trigger + **only what VARIES** (framing/expression). **Never describe
  the body or style** → those bind to the trigger. (This is also why, at inference, full-body shots must
  re-describe the body — see below.)
- **Config:** `training/lora_flux.yaml.tmpl` via `saga-flux-lora-train.sh`. rank 16 / alpha 16 / lr 1e-4 /
  2500 steps / fp8 quantize / adamw8bit / res buckets [768,1024]. ~2 h on a RunPod 4090.
- **Checkpoint choice:** **step 2500 = the keeper** (`models/loras/little_one.safetensors`). Step 1000 was
  **undertrained** — reverted to a generic anime *human*. Keep the mid ladder (`keep/`) before ai-toolkit's
  `max_step_saves_to_keep` pruner deletes it.

## v1 inference recipe (VERIFIED — use this)
```
LoRA:    little_one.safetensors (step 2500)  @ strength 0.75   (0.65–0.8 band; 1.0 over-constrains → blanks)
Prompt:  "l1ttl3one, a small round soft grey creature, big black eyes, rosy cheeks,
          tiny stub arms and legs, no hair, <expression>, <framing>,
          hand-shaded soft charcoal and graphite, plain off-white background, no text"
Sampler: cfg 1.0 · guidance 3.5 · euler/simple · 28 steps · 1024x1280 (or shot aspect)
```
Test harness: `scripts/l1_test.sh` / `l1_test2.sh` (LoraLoaderModelOnly + Flux txt2img).

### The gotchas (each cost real iterations)
1. **The face binds far stronger than the body.** The trigger alone renders a gorgeous *face close-up* but
   **blanks or drifts on full-body** — because the body was deliberately left out of the training captions.
   **Fix: always describe the body** (`small round soft grey creature, tiny stub arms and legs`) for any
   full-body / distant shot. Close-up face prompts need no body description.
2. **Strength 1.0 → blank renders.** Ease to **~0.75**. At 1.0 the LoRA over-constrains certain
   prompt/seed combos into an empty background.
3. **Occasional human drift.** Little One is anthropomorphic; strong human-pose or "big round head + hair"
   language can flip it to a grey human. **Anti-drift cue: `small round creature, no hair`.**
4. **Don't ask for anatomy the blob lacks.** "running mid-stride", "reaching one arm up" demand articulated
   limbs Little One doesn't have → the model substitutes a human. Keep stills in Little One's gentle
   register (standing, small turns, floating, emoting). **Motion comes from the VIDEO stage (FramePack
   animates a static keyframe), not from posing the still.**
5. **Style range.** Outputs span soft-3D-toy ↔ charcoal-drawing. **Pin the look** with
   `hand-shaded soft charcoal and graphite`.
6. **Faint fake signatures** occasionally appear (the cfg-1.0 watermark tic on "drawing"-style renders) —
   crop or re-roll the seed. Raising `--cfg` reintroduces haze + kills seed variety; **stay at cfg 1.0.**

## v2 plan (future — only if genuine pose variety is needed)
Bootstrap-then-refine: use v1 to generate a **pose-varied** on-model set, curate hard, retrain →
v2 has identity *and* flexibility. For pose variety on a non-human blob, prefer **Kontext-dev instruction
edits** ("same character, now …") which preserve the round silhouette, over openpose ControlNet (openpose
assumes a *human* skeleton — the root cause of SAGA's earlier pose-control failures). **Video 1's gentle
register does NOT need v2** — v1 + the recipe above is sufficient; motion is added by FramePack.

## Licensing note (see COMPETITIVE_RESEARCH.md)
This LoRA is trained on **Flux.1-dev = non-commercial**, so v1 is **R&D only**. Before commercial Mirror
content ships, retrain the identity on a commercial-clean base (schnell / SDXL / SD3.5) or license dev.
