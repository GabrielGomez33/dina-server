# SAGA — User Storage Pipeline

Design for per-user asset storage, reconciled with the existing tenant/project model
(`storagePaths.ts`). Status: **design** (pre-implementation). Owner scope: Phase 4–5.

---

## 1. Principle: user assets live *inside* the tenant boundary

The security model is non-negotiable: **every path is contained under
`<SAGA_ROOT>/tenants/<tenantId>/`**, and that containment is proven in `storagePaths.ts`
(reject-don't-sanitize on ids/filenames + a defense-in-depth prefix check). A top-level
`users/` tree would sit *outside* that boundary and lose the guarantee.

So the user's `users/<name>/…` idea is placed **within** the tenant:

```
<SAGA_ROOT>/tenants/<tenantId>/users/<userId>/…
```

- **`<userId>` is a UUID, not a display name.** Names contain spaces/unicode/`..`; the
  path charset gate only accepts `[0-9a-fA-F-]`. The human name is a DB column; the path
  uses the id. (Same rule the tenant/project ids already follow.)
- A **user** = a `saga_memberships` row (user ↔ tenant, with a role). Their personal assets
  are reusable across every project they own in that tenant.

## 2. The four scopes (what lives where, and why)

| Scope | Path | Holds | Lifetime |
|---|---|---|---|
| **Global** | `<SAGA_ROOT>/models/`, `tmp/`, `backups/`, `engine/` | Base checkpoints, VAE, CLIP, ControlNet, upscalers, interpolation — shared, read-only | Permanent |
| **Tenant** | `tenants/<t>/shared/` | Assets shared across the tenant's users (a shared character library, house style presets) | Tenant life |
| **User** | `tenants/<t>/users/<u>/` | **Identity & reusable assets** — uploads, datasets, LoRAs, characters, voices, profile | User life |
| **Project** | `tenants/<t>/projects/<p>/` | **Per show/episode** — plan, storyboard, content, previews, timeline, audio, exports | Project life |

The dividing question: *"is this reusable across projects (→ user) or specific to one show (→ project)?"* Your face LoRA is user-scoped; episode 3's timeline is project-scoped.

## 3. The tree (your list, organized + gaps filled)

```
tenants/<tenantId>/
├── shared/                         # tenant-wide shared library (optional)
│   ├── characters/                 # characters shared across the tenant's users
│   └── presets/                    # house style/fidelity/cinematography presets
│
├── users/<userId>/                 # ── USER SCOPE — reusable identity assets ──
│   ├── uploads/                    # raw ingested media (photos, ref images, audio). IMMUTABLE source of truth
│   │   ├── images/
│   │   └── audio/
│   ├── datasets/<datasetId>/       # prepared training sets (kohya "<repeats>_<trigger>/" + captions) ← from uploads
│   ├── loras/<loraId>/             # trained personal LoRAs (self, owned characters), VERSIONED
│   │   └── v3/lora.safetensors     #   + card.json (base, trigger, rank, steps, dataset hash, sample grid)
│   ├── characters/<characterId>/   # ★ a CHARACTER = the show's building block (added)
│   │   ├── sheet.json              #   trigger, active loraId+version, canonical design notes, negative tags
│   │   ├── refs/                   #   canonical reference stills (the "this is the look" anchors)
│   │   └── control/                #   pose/seal control refs (real-hand photos, openpose maps)
│   ├── voices/<voiceId>/           # ★ TTS/voice-clone models + ref samples for dialogue (added; Phase 4)
│   ├── models/                     # ★ user-IMPORTED models (private fine-tunes); base models stay Global (added/clarified)
│   ├── profile/                    # ★ preferences: default fidelity, style, fps, export presets (added)
│   └── quota.json                  # ★ per-user storage accounting snapshot (added; see quota.ts)
│
└── projects/<projectId>/           # ── PROJECT SCOPE — one show/episode ──
    ├── plan/                       # script, beat sheet, shot list, treatment
    ├── storyboard/                 # boards + keyframe stills (the FLF keyframes)
    ├── timeline/                   # ★ sequence/EDL json (timeline.ts Sequences), edit state (added)
    ├── content/                    # generated RAW assets — draft clips/images, pre-upscale (proxy-edit source)
    │   ├── images/
    │   └── videos/
    ├── previews/                   # ★ low-res proxies for the timeline UI (proxy editing) (added)
    ├── audio/                      # music / dialogue / sfx / ambience (stems + generated) (added detail)
    ├── cache/                      # ★ intermediate render artifacts (interpolation/upscale temps, latents) — TTL'd (added)
    ├── exports/<exportId>/         # final rendered deliverables, VERSIONED
    ├── manifests/                  # ★ provenance + job records (hashes, seeds, licenses, render logs) (added)
    └── trash/                      # ★ soft-delete quarantine before TTL purge (added; see ttlPolicy.ts)
```

**★ = gaps I filled beyond the original list**, with the reason inline. Notably: `datasets/`
(the missing step between `uploads` and `loras`), `characters/` (the reusable show building
block that ties a LoRA + trigger + canonical refs + control refs + voice together), `timeline/`,
`previews/`, `cache/`, `manifests/`, `trash/`, `voices/`, `profile/`, and versioning on
LoRAs/exports.

## 4. The user storage *pipeline* (data flow)

```
uploads/  ──prep──▶  datasets/  ──train──▶  loras/<id>/vN  ──register──▶  characters/<id>/sheet.json
 (photos)          (kohya layout)          (+ card.json)                (trigger + active LoRA + refs)
                                                                              │
                                                    used by projects ◀────────┘
projects/<p>:  content/ (raw gen) ──proxy──▶ previews/ ──edit──▶ timeline/ ──export──▶ exports/<id>
                    ▲ cache/ (interp, upscale temps)                                   manifests/ (provenance)
```

This is exactly the loop we're running by hand now: `me_raw` photos → `saga-lora-dataset.sh`
(datasets) → `saga-lora-train.sh` (loras) → a character record → keyframes/clips in a project →
timeline → export. The storage layout makes each stage a durable, addressable location.

## 5. Cross-cutting rules

- **Versioning.** LoRAs and exports are immutable versioned dirs (`loras/<id>/v3/`,
  `exports/<id>/v2/`). A retrain (e.g. the consistency fix) creates `v4`, never overwrites `v3`;
  the character `sheet.json` points at the *active* version. This makes rollbacks trivial.
- **Provenance.** Every generated asset gets a `manifests/` record: model+LoRA+version, seed,
  prompt, node graph hash, source dataset hash, license. Reproducibility + audit.
- **Retention / TTL** (`ttlPolicy.ts`): `cache/` and `previews/` are ephemeral (regenerable →
  short TTL); `uploads/`, `datasets/`, `loras/`, `characters/`, `exports/` are durable. Deletes
  go to `trash/` first (soft-delete), then purge.
- **Quota** (`quota.ts`): accounted per user AND per project, rolled up to the tenant plan.
  `uploads` + `loras` count against the user; `content`/`exports` against the project.
- **Immutability of `uploads/`.** Raw ingested media is never mutated in place — prep writes to
  `datasets/`, so we can always re-derive from source.

## 6. Implementation plan (tracked; not built yet)

1. **`storagePaths.ts`** — add a `userRoot(tenantId, userId)` + user `AssetArea`s
   (`user_uploads`, `user_datasets`, `user_loras`, `characters`, `voices`) and project areas
   (`plan`, `storyboard`, `timeline`, `previews`, `cache`, `trash`). Each must keep the G1–G3
   containment proofs (still under `tenants/<t>/`). Extend `storageTest` accordingly.
2. **DB** — migration for `saga_user_assets` (id, userId, kind, version, path, hash, bytes, ttl)
   and `saga_characters` (id, userId, trigger, activeLoraId, sheet json). Rolls up to `quota`.
3. **Core** — a `characterRegistry.ts` (pure): resolve a character → its active LoRA + trigger +
   negative tags + control refs, for the generation worker to consume. Tested.
4. **API/worker** — upload ingest → dataset → train → register flows wired to these paths.

Until built, the box scripts use `$SAGA_ROOT/tmp/lora/...` as a flat staging area; this design is
the durable home they graduate into.

---

## 7. Future extrapolation (design so growth doesn't force a redesign)

The scope model (Global → Tenant → User → Project) is deliberately extensible. Everything below
is anticipated but **not** in the initial build — it's here so the paths, DB, and containment
proofs are designed with room for it.

### 7.1 A `series/` scope between Tenant and Project (episodes)

A *show* is not one project — it's a series of episodes that share a cast, world, and style.

```
tenants/<t>/series/<seriesId>/
├── bible/            # series bible: canon, lore, continuity notes, timeline-of-events
├── cast/             # the character roster for THIS series (refs to users/<u>/characters/<id>)
├── styleguide/       # locked palette, line style, fps policy, cinematography presets for the show
├── music/            # recurring themes / leitmotifs
└── episodes/         # symlinks/refs to projects/<p> that are episodes of this series
```
Projects (episodes) inherit the series styleguide + cast → **consistency across an entire show**,
not just within one shot. This is the natural home for "the character must look identical in
episode 7 as in episode 1."

### 7.2 Asset libraries (User or Tenant scope, reusable like characters)

Beyond characters, a production accumulates reusable non-character assets:

| Library | Holds | Analogous to |
|---|---|---|
| `environments/` | background/set LoRAs, location refs, matte plates | characters, for places |
| `props/` | recurring objects (Exodia's chains, a signature weapon) as trained/tagged assets | — |
| `effects/` | VFX presets — energy/rasengan/lightning looks, ffmpeg filter chains, particle overlays | cinematography presets |
| `motion/` | motion LoRAs, camera-path presets, pose libraries, reusable seal/keyframe sets | — |
| `audio_lib/` | SFX library, ambience beds, foley kits, music stems | — |
| `voices/` | per-character voice models, dialogue take archives, lip-sync maps | loras, for speech |

### 7.3 Model lineage & advanced training

```
users/<u>/loras/<id>/
├── v3/ … v4/                  # versions (already in §3)
├── lineage.json               # parent models, merges, dataset hashes — a full provenance graph
├── checkpoints/               # intermediate training epochs (pick-best, resume)
├── eval/                      # sample grids, consistency scores, reference-match metrics per version
└── merges/                    # LoRA stacks/merges (character + style + costume composited)
```
Plus tenant/global **embeddings / textual inversions**, and a **model marketplace** area for
importing/exporting characters and LoRAs between users (with license records).

### 7.4 Collaboration, review & QA

- **Review state** per shot/clip: `pending / approved / rework`, with reviewer + notes.
- **Annotations/comments** anchored to a timeline timecode or a frame.
- **Edit versions** of a `timeline/` sequence (branch/compare cuts).
- **Consistency QA**: automated per-shot consistency score vs the character's canonical refs →
  flags drift *before* it ships (directly addresses the drift problem we hit).

### 7.5 Distribution, publishing & localization

```
projects/<p>/exports/<exportId>/
├── masters/          # full-res deliverable (2K/4K)
├── renditions/       # platform cuts (1080p, vertical/social, gif, thumbnail)
├── captions/         # subtitles per language
├── dubs/             # localized audio mixes per language
└── credits.json      # cast/model/content credits + license roll-up
```
Plus a **publish/CDN** staging area and per-rendition delivery metadata.

### 7.6 Rights, provenance & moderation

- **License ledger** per asset (model licenses, any third-party refs, music rights).
- **Content credentials** (e.g. C2PA-style signed provenance) attached to exports.
- **Moderation flags** (NSFW/policy) on user uploads and generations, with quarantine.

### 7.7 Lifecycle: tiers, archive & DR

- **Hot / warm / cold tiers**: active project on SSD; finished series archived to cheaper/cold
  storage; `cache/` never leaves hot.
- **Snapshots + offsite replication** of durable scopes (`uploads/loras/characters/exports`).
- **Archive bundle**: a finished series exported as a single self-describing archive (assets +
  manifests + lineage) for cold storage or handoff.

### 7.8 Automation & agents

- **Saved pipelines/workflows** (a user's named render recipes; parameterized batch jobs).
- **Scheduled/queued jobs** (overnight batch training/renders) with a per-user job history.
- **Cost/telemetry**: GPU-hours, storage bytes, render counts — rolled into `quota` + billing.

### Design invariant across all of the above

Every future path still resolves **under `tenants/<tenantId>/`** and through the same
reject-don't-sanitize id/filename gates. New scopes (`series/`) and libraries (`environments/`,
`effects/`, …) are new `AssetArea`s in `storagePaths.ts` with their own containment proofs — the
isolation guarantee never weakens as the surface grows.

