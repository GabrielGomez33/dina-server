# dina-saga — Pre-Production Pipeline & Frame-Rate Policy (locked design)

This document extends the foundation slice (migration 003, `SagaModule`) with the film
pre-production workflow and the delivery frame-rate policy. It is the design contract for
**migration 004** and the phase-2b handlers. Nothing here changes shipped code; it specifies what
gets built next.

---

## 1. Frame-rate policy

Base generation is always 16 fps (Wan's native cadence — a model constraint, not a choice).
Delivery frame rate is a **post-pass**: RIFE interpolation multiplies frames, then retime + upscale.

| Delivery target | How | When |
|---|---|---|
| **30 fps (standard)** | 2× interpolation (16→32) + retime | default for all shots |
| **60 fps (action)** | 2× then 2× (16→64) + retime | per-shot opt-in via `fps_target` |
| 24 fps (filmic) | retime only or light interpolation | per-shot opt-in |

**Guards (built into the interpolation stage):**
- **Scene-cut detection** — interpolation NEVER blends frames across a cut (the #1 ghosting source).
- 4× is gated behind per-shot review; fast motion + impact frames are where artifacts concentrate.
- "Animated on twos" holds are detected (duplicate-frame runs) and preserved rather than smoothed,
  so the anime timing aesthetic survives interpolation.
- Cost note: 60 fps doubles frames through the upscaler (~minutes per clip, budgeted in the job ETA).

`fps_target` lives on the **shot**, not the project — one scene can mix 30 fps dialogue with a
60 fps action beat.

---

## 2. Pre-production stage ladder

Every artifact of film pre-production maps onto pipeline machinery we already have — and the ladder
is ordered by cost so cheap stages gate expensive ones:

```
STAGE            ARTIFACT                 ENGINE                COST/UNIT      GATE
1. Concept art   style/location/char/     image gen (existing)  seconds        approve → usable as refs
                 prop/costume/mood refs
2. Storyboard    panel sequence per shot  image gen, draft      seconds        approve → shot locked
                 w/ camera + action notes mode (fast SDXL)
3. Shot list     structured shot specs    DB rows (no GPU)      free           approve → renderable
4. Animatic      panels + timing + temp   ffmpeg assembly +     ~1 min, CPU    approve → scene flow locked
                 audio (music/TTS scratch) TTS scratch dialogue
5. Previs        480p draft renders       video gen DRAFT tier  ~10 min/clip   approve → final render
6. Final         720p render → upscale →  video gen FINAL tier  ~25 min/clip   promote → export
                 interpolate → assemble
```

**The economics:** a rejected storyboard panel costs ~10 seconds of GPU; a rejected final render
costs ~25 minutes. Every approval pushed earlier in the ladder multiplies effective GPU runway.
Previs is not a new engine — it IS the existing draft tier, formalized as a gate.

### Mapping to your artifact list

| Film artifact | dina-saga implementation |
|---|---|
| **Concept art** (locations, characters, props, lighting/mood, costumes) | image generations tagged with an `asset_category`; approved concepts become manifest refs / LoRA training inputs and IP-Adapter references for downstream consistency |
| **Storyboard** (camera angles, character positions, movement, dialogue/action notes, transitions) | `saga_storyboard_panels` rows — each panel is a cheap draft image generation PLUS structured fields for angle/movement/notes; ordered per shot |
| **Shot list** (every shot, lens, movement, setup) | `saga_shots` — the machine-readable contract. "Lens/setup" become prompt+seed+LoRA-set metadata; this table is what the ShotPlanner consumes, so the shot list literally drives generation |
| **Animatic** (boards + timing + temp SFX/dialogue/music) | `assemble` job (existing queue, CPU): panels held for their shot durations + user's music + TTS scratch dialogue → preview .mp4. Near-free to re-cut |
| **Previs** | the existing 480p draft render tier, now a formal gate before finals |

### Stage-gating workflow

Statuses flow `draft → approved → superseded`, and each stage's generator only consumes **approved**
rows from the stage above (e.g. a final render request for a shot whose animatic scene is not
approved is refused with `STAGE_NOT_APPROVED`). Approval is per-artifact, so iterating one shot
never blocks the rest of the scene.

---

## 3. Migration 004 (planned schema — extends 003, same idempotent framework)

```
saga_scenes            id, project_id FK, seq, title, synopsis, status(draft/approved/superseded),
                          soft-delete + timestamps
saga_shots             id, scene_id FK, shot_number, shot_type ENUM(standard, holdLoop, chained),
                          camera_angle, camera_movement, character_positions JSON,
                          dialogue TEXT, action_notes TEXT, transition,
                          duration_target_s DECIMAL, fps_target ENUM(24,30,60) DEFAULT 30,
                          setup_ref JSON (seed, lora_set, prompt_template, keyframe_gen_id),
                          status(draft/approved/rendered/superseded)
saga_storyboard_panels id, shot_id FK, seq, generation_id FK (the panel image),
                          notes TEXT, status(draft/approved/superseded)
ALTER saga_generations ADD asset_category ENUM(production, concept_location, concept_character,
                          concept_prop, concept_costume, concept_mood, storyboard, animatic) DEFAULT 'production'
ALTER saga_generations MODIFY kind ENUM(..., 'animatic')   -- additive enum extension
```

TTL policy additions: storyboard panels & concept art = 90 days (cheap to re-roll but referenced
often); **approved** concepts/panels and animatics of approved scenes = TTL-immune while referenced
by a non-superseded shot (janitor checks references before pruning — same pattern as `promoted`).

## 4. New DUMP methods (registered in methodRegistry, same validation pattern)

```
saga_create_scene            {tenantId, projectId, title, synopsis?}
saga_create_shot             {tenantId, projectId, sceneId, spec}       // spec = shot-list fields
saga_generate_storyboard     {tenantId, projectId, shotId, prompt, panels?}   // draft-tier images
saga_generate_concept        {tenantId, projectId, category, prompt, params?}
saga_assemble_animatic       {tenantId, projectId, sceneId, audioTrackId?, scratchDialogue?}
saga_approve                 {tenantId, projectId, kind, id}            // uniform stage-gate approval
saga_get_scene_board         {tenantId, projectId, sceneId}             // scene + shots + panels + animatic
```

All follow the shipped pipeline: registry validation → role-ranked authz (approve requires
`editor`+) → handler; storyboard/concept generation reuses the existing quota-checked
`enqueueGeneration` path at draft priority.

## 5. Frontend surface additions (phase 2c, mirror-server)

- `/preprod` — scene board: shots as cards (angle/movement/dialogue), panel strips, approve buttons
- `/preprod/animatic/:sceneId` — animatic player with per-shot timing scrubber
- Shot detail: fps_target selector (30 default, 60 flagged "action — review interpolation"),
  shot_type selector (standard / holdLoop dialogue / chained motion)
```
