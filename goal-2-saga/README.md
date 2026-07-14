# Goal #2 — `dina-saga` Foundation Slice (multi-tenant image/video generation)

**Branch delivery folder — nothing touches the live `dina-server` tree.** Files sit at their mirrored
target paths, drop-in ready, with a reviewable wiring guide (`dina-server/INTEGRATION.md`). Builds on
Goal #1 (`/goal-1-gpu-arbitration/`): all GPU work here runs through the proven `gpuArbiter`.

```
goal-2-dina-saga/
├── README.md                                   ← this file
└── dina-server/
    ├── migrations/003_saga_core.ts          ← full multi-tenant schema (7 tables, idempotent)
    ├── src/modules/saga/
    │   ├── index.ts                            ← SagaModule (DUMP entry, mirror-pattern singleton)
    │   ├── sagaRoutes.ts                    ← HTTP→DUMP boundary (truthStreamRoutes pattern)
    │   ├── types/index.ts                      ← full type contract incl. JobProgress schema
    │   └── core/                               ← PURE logic (each provable in isolation)
    │       ├── storagePaths.ts                 ← tenant-isolated path resolution (security-critical)
    │       ├── quota.ts                        ← plan-tier quota admission math
    │       ├── ttlPolicy.ts                    ← locked lifecycle table + janitor decision fn
    │       └── methodRegistry.ts               ← DUMP surface + per-method payload validation
    ├── test/saga/sagaFoundationTest.ts   ← hermetic proofs — 97 assertions, all green
    ├── tsconfig.json                           ← scoped standalone type-check config
    └── INTEGRATION.md                          ← exact wiring steps (orchestrator case, routes, migrate)
```

## What this slice is (and deliberately is not)

Per the working principle — *one goal, all edge cases tested, zero ecosystem disruption, then next* —
this slice is the **foundation**: schema, tenancy/authz, quota, TTL lifecycle, the complete DUMP
method surface, and the enqueue-side of every generation flow. It is **not yet** the ComfyUI worker,
audio sidecar, or frontend (phase 2b/2c) — those bolt onto the job queue this slice records into,
each with their own proof harness.

## DUMP compliance — mirrored from the proven mirror module

The mirror module's pattern was analyzed end-to-end (`truthStreamRoutes.ts` → orchestrator
`processMirrorRequest` → `mirrorModule.handle*`) and replicated exactly:

| Proven mirror tactic | saga implementation |
|---|---|
| HTTP → `createDinaMessage` → `dina.handleIncomingMessage` | `sagaRoutes.dispatch()` — one uniform path for all 13 endpoints |
| Injected deps (`DinaInstance`, `CreateDinaMessageFn`) — no cross-module imports | same, plus `DbPort`/`JobQueuePort` ports on the module itself |
| `safeJsonResponse` (ERR_HTTP_HEADERS_SENT guard) | same helper |
| DUMP double-wrap extraction | same `extractDumpResponseData` |
| orchestrator `case 'mirror'` → method switch | additive `case 'saga'` → `handleSagaMessage` |
| per-module error isolation (`MirrorModuleError`) | `SagaModuleError` + every handler failure returned as a structured `{code,message}` — proven in test 5i |
| ad-hoc input caps (`substring(0,10000)`) | **declared** per-field bounds in `methodRegistry` (same intent, auditable) |

Uniform request pipeline (every method, no exceptions):
`init-guard → method known → payload validated → tenant membership authorized (role-ranked) → handler`.

## Security & robustness — the proofs

Run them yourself:

```bash
cd goal-2-dina-saga/dina-server
npx tsc --noEmit -p tsconfig.json                       # strict type-check — clean
npx ts-node test/saga/sagaFoundationTest.ts       # RESULTS: 97 passed, 0 failed
```

What the 97 assertions prove (hermetic — no DB/GPU/network/fs; fakes injected through the same ports
production uses):

1. **Tenant isolation (storage):** every resolved path stays inside `<root>/tenants/<tenantId>/`;
   `../`, absolute paths, encoded dots, null bytes, separator-smuggled filenames are all **rejected,
   never sanitized** — plus a defense-in-depth prefix containment check even if the charset gate were
   bypassed. This implements the locked requirement *"storage paths embed tenant_id so a path
   traversal can't cross tenants even if validation fails."*
2. **Quota math:** admission is exact (shortfall reported to the byte), saturating (two huge values
   can't overflow into an admit), and hostile-input-safe (NaN/negative/Infinity → safe defaults);
   usage counters can never go negative on double-delete.
3. **TTL lifecycle (locked table):** images 30d, video/lipsync 14d, stems/analysis 60d, raw refs &
   audio source & exports never; **promoted generations are never pruned** (invariant test), and
   soft-deleted rows keep a 30-day recovery window before hard-prune.
4. **Registry↔dispatch lockstep:** every registered DUMP method is exercised against the live
   dispatch switch — registry/switch drift is impossible to merge unnoticed.
5. **Pipeline behavior:** non-members are FORBIDDEN before any data query runs; viewers can read but
   not mutate; **quota refusal happens before anything is recorded or enqueued**; the happy path
   records seed/lineage/TTL and enqueues exactly one job with the tenant's `gpu_priority`; cached
   audio analysis short-circuits (no duplicate jobs); finished jobs can't be zombie-cancelled; a DB
   outage inside a handler is contained as a structured `PROCESSING_ERROR`.

The migration was additionally type-checked against the repo's real migration framework
(`migrations/types.ts` + `helpers.ts`) — clean.

## GPU safety (ties into Goal #1)

Generation methods **only validate + record + enqueue**. The phase-2b worker wraps the actual ComfyUI
call in `gpuArbiter.run({ mode: 'exclusive', ... })`, which drains Ollama's warm set first and
re-warms it after — so a FLUX/Wan/Hunyuan render can never silently push @Dina onto the CPU, and
interactive chat always holds priority. `saga_jobs.priority` carries the tenant's `gpu_priority`
so the paid-tier queue-jump hook is already in place.

## Schema (migration 003) — locked decisions encoded

`saga_tenants` (plan free/pro/admin, quota_bytes, gpu_priority) → `saga_memberships`
(owner/editor/viewer, unique per tenant+user, keyed to `dina_users.dina_key`) → `saga_projects`
(**per-tenant slug uniqueness** — no global collisions, soft-delete, bytes_used) → `saga_manifests`
(versioned, draft/frozen/retired) · `saga_audio_tracks` (analysis cached forever in
`analysis_json`) · `saga_generations` (seed + `parent_generation_id` lineage, `promoted`
TTL-immunity, `ttl_expires_at` with janitor index) · `saga_jobs` (all 8 queue classes, progress
snapshot for reconnecting clients). Idempotent `CREATE TABLE IF NOT EXISTS`, FK-ordered `up`/`down`.

## Next (phase 2b) — in order

1. **ComfyUI worker + `comfyClient`** — exclusive arbiter lease, workflow JSON templates, progress
   re-emission (phase-weighted `JobProgress` → WS), preview frames.
2. **Janitor system** — nightly sweep consuming `pruneDecision()` (already proven), byte reclamation.
3. **Audio sidecar contract** — Demucs/WhisperX/beats job, `ShotPlan` merge (types already defined).
4. **mirror-server frontend** — staged under `goal-2-dina-saga/mirror-server/` when we get there.
