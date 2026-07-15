# SAGA — Reference Fidelity Methodology

> How SAGA reproduces a reference faithfully — for **any** subject, not one test case.
> Written after a pattern of misrepresentation (a mask bar rendered as a tongue, proportions
> drifting, forms melting at high weight) made clear the fixes must be systemic, not per-subject.

## The core distinction

Reference conditioning has **two independent axes**, and a faithful result needs both:

| Axis | Tool | What it controls | Failure if missing |
|---|---|---|---|
| **Identity / style** | IP-Adapter | "make something that *feels* like this" | generic output; no likeness |
| **Structure / geometry** | ControlNet | "put the edges/depth *here*" | mask→tongue, proportion drift, melting |

IP-Adapter alone is an **identity** tool. It does not pin geometry, so structural details get
re-interpreted. No IP-Adapter weight or prompt tweak fixes a *structural* error — that is
categorically ControlNet's job. Chasing structural bugs with prompts is the trap we fell into.

## The three laws (all subject-agnostic)

### Law 1 — Neutral prompting
When a reference supplies identity, the prompt describes **only framing, mood, and quality —
never the subject**. Every subject word competes with the reference and induces drift. Enforced
in code by `assembleReferencePrompt()`, whose type has **no subject slot** — the rule cannot be
violated by accident.

```
❌ "exodia, golden bandaged giant, masked face, full body, dark, ominous"   ← subject words fight the ref
✅ "full body, standing, dark, chiaroscuro, rim light, ominous, cinematic"  ← reference IS the subject
```

### Law 2 — Reference preprocessing
Feed the CLIP vision encoder a properly cropped/scaled reference (`PrepImageForClipVision`,
center-crop + LANCZOS). Better features in → better identity out. Baked into `image-reference@1`.
Multiple references should be *consistent* (same character, varied angle) — conflicting crops
muddy the identity embedding.

### Law 3 — Structural conditioning (ControlNet)
For faithful geometry, derive a control map (depth / lineart / canny) from the reference and
constrain generation to it. This is what makes the mask *stay* a mask. Applied as an optional,
weighted layer in the reference workflow (`controlnet_strength` 0..1) so callers trade
faithfulness against creative freedom — the same dial philosophy as IP-Adapter weight.

## Calibrated defaults (policy, not per-subject)

- **IP-Adapter weight:** 0.6–0.8. Below 0.5 loses identity; above 0.8 the reference overpowers
  structure and forms melt. Live-characterized; stored on the model profile, not typed per run.
- **CFG:** ~4.5–5 for SDXL reference work — higher over-saturates ("plasticky").
- **ControlNet strength:** start ~0.5 (guide) → 0.8 (hard lock) when geometry must be exact.
- **Sampler:** `dpmpp_2m` + `karras`, 30 steps.

## Where each law lives in the code

- Law 1 → `core/promptNormalizer.ts::assembleReferencePrompt` (+ proofs in `tests/promptSystemsTest.ts`)
- Law 2 → `systems/workflowTemplates.ts::TEMPLATE_IMAGE_REFERENCE` (`PrepImageForClipVision` node)
- Law 3 → `image-reference-structured@N` template (ControlNet layer) — pending live node verification
- Calibrated defaults → `core/modelRegistry.ts` profile `defaults`

## The remaining, honest gaps

- Localized artifacts that survive all three (a stray finger, a smudged emblem) are cleaned by the
  **detailer** stage (region re-generation), not by global settings.
- ControlNet needs the right control type per goal: **lineart/canny** for flat anime line fidelity,
  **depth** for volume/pose. We pick per shot; both are cheap to install.
