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

### 2.4b-2 — Extraction + query (DONE)

| Piece | File | Role |
|---|---|---|
| **GraphExtractor** | `web/graph/graphExtractor.ts` | LLM triple extraction from gathered docs; content **fenced + sanitized** (same promptGuard as synthesis) + `INJECTION_SYSTEM_RULE`. Injected LLM dep; pure `parseTriples` maps source-number → URL. |
| **Wiring** | `webResearchOrchestrator.ts` | When `graphEnabled`, `research()` extracts triples after synthesis and upserts them (best-effort, fully guarded). `investigate()` populates the graph across all facets automatically. |
| **Query** | `digim_graph` (DUMP) + `POST /digim/graph` + `DigimClient.graph()` | Returns a focus's subgraph (nodes + edges + provenance) and the recommended view. |

`digim_research` now reports `graph_relationships_added`. Verified: **graph 39/39**
(adds source-number→URL mapping, self-loop/junk drops, extractor orchestration
incl. LLM-failure → `[]`), tsc clean, no regression. Config-gated
(`DIGIM_WEB_GRAPH_ENABLED=false`).

### Live verification (production, 2026-07-12)

`digim_research` (graph enabled) on the Iran–USA topic → `graph_relationships_added: 8`,
then `digim_graph {"query":"Iran"}` returned the populated graph:
- 6 entities, 8 relationships; `Iran` correctly resolved as the most-connected node
  (`mention_count: 8`, merged from all mentions).
- Readable edges, e.g. `United States —launched_strikes_on→ Iran`,
  `Iran —struck→ Qatari-flagged vessel al-Rakiyat`.

Two live-exposed bugs, both fixed & proven in isolation:
1. **Extraction truncated at the 1200-token synthesis budget** → unterminated JSON →
   0 triples. Fixed: dedicated `DIGIM_WEB_GRAPH_EXTRACT_MAX_TOKENS` (3000) +
   truncation-salvage parser.
2. **`getSubgraph` bound `LIMIT ?`** — mysql2 `pool.execute` (prepared statements)
   rejects a parameterized LIMIT (`ER_WRONG_ARGUMENTS`); the query threw, caught,
   returned empty despite stored data. Proven via `execute+LIMIT? FAILS /
   query+LIMIT? OK`. Fixed: inline the clampInt-validated limit.

End-to-end proven on production: research → entity/relationship extraction →
alias resolution → provenance storage → queryable subgraph.

### Known extraction-quality items (2.4b-3 polish)

From the live data: near-duplicate/generic entities ("three vessels" vs "three
commercial vessels", "a container ship") and verbose non-canonical predicates
("launched_a_series_of_powerful_strikes_against" vs "launched_strikes_on" — same
edge, corroboration stuck at 1). Fix via a tighter extraction prompt (canonical
short predicates, skip generic entities, date only real events) + light predicate
normalization.

### 2.4b-3 — Renderers (next)

The interactive network / temporal / semantic views over the populated graph.

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
