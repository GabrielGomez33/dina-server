# Phase 2.4 — Design: Research Planner + Relationship Graph

The payoff: turn a broad question into *coverage* (planner), then turn that
coverage into *structure* — "see the relationships between information" (graph).
Two capabilities that compose; built and proven in that order.

---

## 2.4a — Research Planner (this increment)

A broad question isn't one search. "The Iran–USA war and its ripples" is really
*timeline → causes → oil/gas impact → regional fallout → key actors*. The planner
decomposes, runs each facet through the **existing, proven pipeline**, and fuses
the results into one comprehensive, provenance-tracked briefing.

### Flow

```
 broad query
     │
     ▼
 1. DECOMPOSE  (LLM / mistral)  → a bounded plan of sub-queries, each a facet:
     │            [{facet:"timeline", query:"..."}, {facet:"oil impact", query:"..."}, …]
     │            (≤ plannerMaxSubQueries; degrades to [original query] on LLM failure)
     ▼
 2. RUN FACETS (reuse orchestrator.research per sub-query, bounded concurrency)
     │            each facet → its own gather + synthesis + memory  (nothing new)
     ▼
 3. FUSE       (reuse WebInsightSynthesizer): the per-facet briefings become the
     │            "documents" for a final synthesis that connects across facets,
     │            notes agreements/contradictions, and cites the REAL source URLs.
     ▼
 InvestigationResult { plan, facets[], synthesis, sourcesConsulted }
```

### Why this reuses everything

- **Decompose** is one new LLM call (a prompt + a pure JSON parser).
- **Run facets** is just N calls to the `research()` we already built and proved
  — each facet gets search + sources + browser-escalation + memory for free.
- **Fuse** reuses `WebInsightSynthesizer.synthesize()` verbatim: the facet
  summaries are passed as source "documents," so all the proven grounding,
  coercion, and prompt-injection fencing apply. The final `sources` are then
  overridden with the UNION of the facets' real web sources (deduped), and
  `entities` with the union of facet entities — so provenance is real, not
  synthetic.

So the only genuinely new code is the decompose step + the orchestration loop.
Everything expensive/risky is already tested.

### Boundedness (cost control)

Investigations fan out, so every knob is capped:
- `plannerMaxSubQueries` (default 5) — hard cap on facets.
- `plannerConcurrency` (default 2) — facets run ≤2 at a time so Ollama isn't
  swamped.
- Facets default to `surface` level to keep per-facet cost down; the fuse is the
  one deep pass.

### Testability

The planner takes its dependencies **injected** (`generate`, `research`,
`synthesize`), so the whole orchestration is unit-tested with mocks — no LLM or
network. Pure `parsePlan()` (JSON → clamped facet list) is tested exhaustively.

### Surface

- New method `digim_investigate` (DUMP), `POST /digim/investigate`, and
  `DigimClient.investigate()`.
- New file `web/planner/researchPlanner.ts`.
- Config: `DIGIM_WEB_PLANNER_*` (enabled/maxSubQueries/concurrency/facetLevel).
- Default OFF (`DIGIM_WEB_PLANNER_ENABLED=false`).

---

## 2.4b — Relationship Graph (next increment)

As content is gathered, extract **entities** (people, countries, orgs, events)
and the **relationships** between them, with provenance and corroboration.

- **Storage: MySQL**, via the existing migration runner — `digim_entities`
  (id, name, type, canonical_name) and `digim_relationships` (subject_id,
  predicate, object_id, source_content_id, confidence). Relational by nature,
  reuses the DB already running, **zero new infrastructure**. (A dedicated graph
  DB is over-engineering at this scale.)
- **Extraction: LLM** (mistral), same synthesizer pattern — emits
  `{subject, predicate, object}` triples per document, each tied to its source
  URL (provenance) and merged with existing edges (corroboration count++).
- **Query:** `digim_graph` returns a topic's subgraph (entities + edges + who
  said what), so DINA can literally show "US —sanctioned→ Iran", "Strait of
  Hormuz —chokepoint-for→ oil supply".
- Entity resolution starts simple (case/alias-normalized name match), not ML —
  robust and good enough, upgradable later.

The planner and graph compose: the planner produces broad, multi-facet material;
the graph structures the entities/relationships across all of it. Built after
2.4a is proven.

---

## Security & governance (both)

- Sub-queries are LLM-generated *search strings*, not code. Facet content is
  already fenced/sanitized at each facet's synthesis (existing prompt-injection
  defense).
- Graph triples are extracted from already-fenced content; the extraction prompt
  reuses `INJECTION_SYSTEM_RULE`.
- Config-gated, default OFF. Additive: with the planner disabled, nothing
  changes; `digim_research` is untouched.

## Verification plan

- Hermetic: `parsePlan` clamping/robustness; planner orchestration with mock
  deps (decompose → 3 facets → fuse); source/entity union + dedup.
- No regression across existing suites.
- Live capstone: a real Iran–USA investigation — the broad, multi-facet question
  that motivated this whole effort.
