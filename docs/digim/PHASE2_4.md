# Phase 2.4a — Research Planner

Turns a **broad question into coverage.** A single search can't answer "the
Iran–USA war and its ripples" — the planner decomposes it into facets, researches
each through the proven pipeline, and fuses the results into one comprehensive,
provenance-tracked briefing.

## What shipped

| Piece | File | Role |
|---|---|---|
| **ResearchPlanner** | `web/planner/researchPlanner.ts` | Orchestration only: decompose → run facets → fuse. All heavy steps are **injected deps** (no orchestrator import, no pipeline internals). |
| **Orchestrator wiring** | `web/webResearchOrchestrator.ts` | `investigate()` supplies real deps (LLM decompose, `research()` per facet, synthesizer fuse). |
| **Capability** | `digim_investigate` (DUMP), `POST /digim/investigate`, `DigimClient.investigate()` | Reachable by the API and any foreign module through the DUMP client. |

## Flow

1. **Decompose** — one LLM call breaks the question into ≤ `plannerMaxSubQueries`
   facets. Junk/failed output → single-facet fallback (still works).
2. **Run facets** — each sub-query runs through the existing `research()` (search
   + sources + browser-escalation + memory). Bounded by `plannerConcurrency` so a
   fan-out can't swamp Ollama. Each facet is fault-isolated.
3. **Fuse** — the per-facet briefings become "documents" for the proven
   synthesizer; the final `sources`/`entities` are then overridden with the UNION
   of the facets' *real* web sources/entities, so provenance is genuine.

The only new code is decompose + the orchestration loop; everything expensive is
reused and already proven.

## Robustness (proven, not asserted)

`npm run test:planner` — **28/28**, all with mock deps (no LLM/network):
- `parsePlan`: every response shape (`subQueries`/`facets`/bare array), fence
  unwrap, case-insensitive dedupe, clamp-to-max, junk → `[]`.
- Orchestration: happy path (3 facets → fuse, real provenance union), decompose
  failure → single-facet fallback, all-facets-empty → honest empty (fuse skipped),
  fuse failure → assembled fallback with sources preserved.
- **Concurrency**: `maxConcurrent <= plannerConcurrency` asserted directly — the
  fan-out race is bounded by construction.

## Enabling (default OFF)

```bash
DIGIM_WEB_PLANNER_ENABLED=true
DIGIM_WEB_PLANNER_MAX_SUBQUERIES=5     # hard cap on facets
DIGIM_WEB_PLANNER_CONCURRENCY=2        # facets researched at once
DIGIM_WEB_PLANNER_FACET_LEVEL=surface  # per-facet depth (fuse is the deep pass)
```

`digim_status` reports `plannerEnabled`. With it off, `digim_research` is
untouched.

## Security

Sub-queries are LLM-generated *search strings*, not code. Facet content is fenced
& sanitized at each facet's synthesis (existing injection defense); the decompose
prompt also carries `INJECTION_SYSTEM_RULE`. Config-gated, additive.

## Next: 2.4b — Relationship Graph

MySQL-backed entity + relationship extraction (provenance + corroboration) over
the planner's rich harvest — the "see the relationships" layer. Design in
`docs/digim/PHASE2_4_DESIGN.md`.

## Verification

- tsc clean; planner **28/28**; no regression (tools 32, sources 20, web 107,
  memory 33, migration 18). Live Iran–USA investigation to be run on the box as
  the capstone.
