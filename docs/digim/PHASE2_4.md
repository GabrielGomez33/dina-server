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

## 2.4b — Relationship Graph

**One canonical model, three views, events first-class.** Store the graph once
(nodes + edges + weights + time + provenance); render it as a **network**
(force-directed web), a **temporal** cascade (x = time — shows ripples), or a
**semantic** cloud (project embeddings). A pure `suggestView()` picks the best
one per subgraph. Storage and rendering are separate concerns.

### 2.4b-1 — Data model (DONE)

| Piece | File | Role |
|---|---|---|
| **Schema** | `migrations/002_digim_relationship_graph.ts` | `digim_entities` (nodes; `occurred_at` makes events first-class, `mention_count` = weight, `embedding_ref` for the semantic view), `digim_relationships` (edges; `corroboration_count`, `confidence`), `digim_relationship_sources` (provenance). |
| **Entity resolution** | `web/graph/entityResolution.ts` | Pure alias-merge: canonical key + predicate/type normalization. |
| **Adaptive view** | `web/graph/graphView.ts` | Pure `suggestView()` — network / temporal / semantic. |
| **Store** | `web/graph/graphStore.ts` | Race-safe entity/edge upserts; subgraph query; provenance-driven corroboration. |

Verified: **graph 28/28** (`npm run test:graph`) — alias merge on the live
aliases, predicate/type normalization, adaptive view (incl. temporal-over-
semantic precedence + empty/edge cases), DB-row mapping. tsc clean; no regression.
Config-gated (`DIGIM_WEB_GRAPH_ENABLED=false`). Live DB round-trip verified after
migration (sandbox has no MySQL).

### 2.4b-2 — Extraction + query (NEXT)

LLM triple extraction from gathered content (reusing injection fencing) → upsert
into the store; `digim_graph` returns a topic's subgraph + suggested view; wire
extraction into research/investigate. Then the renderers.

## Verification

- tsc clean; planner **28/28**; no regression (tools 32, sources 20, web 107,
  memory 33, migration 18).

### Live capstone (production, 2026-07-11)

`digim_investigate` on *"the 2026 Iran–USA war: causes, timeline, effects on oil
and gas prices, and regional ripple effects"*:

- **Self-planned 5 facets:** causes, timeline, oil/gas effects, regional ripples,
  and — chosen by the planner itself — *"Caveats (potential manipulations)"*.
- **Each facet ran the full pipeline:** `basis: web+memory`, 8 documents each;
  **22 unique sources** fused (deduped union).
- **Fused briefing connected the facets:** outbreak (Operation Epic Fury, Feb 28),
  retaliation, oil shock (Brent > $120/bbl), regional fallout (GCC economic model)
  — grounded, post-training-cutoff.
- **Entities surfaced:** Trump, Khamenei, US, Iran, Strait of Hormuz, GCC, Iranian
  forces — the raw material for the 2.4b relationship graph.

Observed limitation → motivates 2.4b: entity aliases were not merged ("Strait of
Hormuz" vs "The Strait of Hormuz"; "Ali Khamenei" vs "Supreme Leader Ali
Khamenei"). The planner's exact-match dedupe is intentional; **canonical entity
resolution is a 2.4b responsibility.**

Phase 2.4a is complete and proven on production.
