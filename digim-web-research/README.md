# DIGIM Web-Research Subsystem — Goal #1 Delivery

**Teaching DINA to gather information, surf the web, and generate insights.**

This folder is the delivery package for Goal #1. It documents the analysis,
the research that grounded the design, the architecture, every file that
changed, how to enable it, and how each edge case is handled.

> **No-disruption guarantee.** The subsystem is **disabled by default**
> (`DIGIM_WEB_ENABLED` unset ⇒ `false`). With it unset, DINA's runtime behavior
> is byte-for-byte unchanged: no network calls, no new LLM instance, no schema
> changes. Every change is additive and reversible. See
> [`CHANGES.md`](./CHANGES.md).

---

## 1. Current state of DIGIM (what we found)

DIGIM shipped as a **"Phase 1 foundation"**: the skeleton exists but the
intelligence does not.

| Capability | Before | Notes |
|---|---|---|
| DUMP routing / message normalization | ✅ Real | `handleIncomingMessage` → `routeRequest` switch |
| DB schemas (`digim_sources/content/intelligence/clusters`) | ✅ Real | Created in `digim/index.ts` + `db.ts` |
| Source management (add/list/test) | ✅ Real | `testSource()` had **no SSRF protection** (see below) |
| `digim_gather` (collect content) | ⚠️ Placeholder | Returned `{status:'queued'}`, gathered nothing |
| `digim_query` (NL intelligence) | ⚠️ Placeholder | Ran complexity analysis only, consulted 0 sources |
| `digim_analyze / generate / cluster / export` | ⚠️ Placeholder | "available in Phase 2/3/4" stubs |
| Web search / fetch / extraction | ❌ Absent | No way to reach the open web |

### Latent bugs found and fixed (additive, low-risk)

1. **SSRF in `testSource()`** — it called `fetch(source.url)` on an arbitrary,
   user-supplied URL with zero validation. A source pointing at
   `http://169.254.169.254/…` (cloud metadata) or an internal admin panel was
   reachable. **Fixed**: routed through the new SSRF guard.
2. **Broken `/digim/sources` route** — it sent method `digim_list_sources`,
   which the orchestrator does not handle, so every call threw
   *"Unknown DIGIM method"*. **Fixed**: now sends `digim_sources` with
   `action:'list'`.
3. **Invalid `intelligence_level:'basic'`** — the route defaulted queries to
   `'basic'`, which is not a valid level (`surface|deep|predictive`). **Fixed**:
   normalized (`basic → surface`).

---

## 2. What we built

A self-contained web-research subsystem under
[`src/modules/digim/web/`](../src/modules/digim/web) — separate concerns, no
intertwined logic, one cohesive pipeline:

```
                    ┌──────────────────────────────────────────────┐
  query ──────────► │  WebResearchOrchestrator  (facade + cache)    │
                    └───────────────┬──────────────────────────────┘
                                    │
        ┌───────────────────────────┴──────────────────────────────┐
        ▼                                                            ▼
┌──────────────────────── GatheringPipeline ───────────┐   ┌──────────────────┐
│ SearchProvider → WebFetcher → ContentExtractor →      │   │ WebInsight        │
│ QualityScorer  → WebResearchStore (dedupe+persist)    │──►│ Synthesizer (LLM) │
│        ▲              ▲                                │   └──────────────────┘
│        │              │                                │            │
│   urlGuard (SSRF)  urlGuard (per redirect hop)         │            ▼
└───────────────────────────────────────────────────────┘   digim_intelligence
                                                                (persisted)
```

| Module | File | Concern |
|---|---|---|
| Config | `web/config/webConfig.ts` | Env-driven, frozen singleton (mirrors `llmConfig.ts`) |
| **SSRF guard** | `web/security/urlGuard.ts` | Scheme/creds/port/DNS/private-range defense (IPv4+IPv6) |
| Search providers | `web/gatherers/searchProvider.ts` | Pluggable: SearXNG / Brave / Tavily / none |
| Fetcher | `web/gatherers/webFetcher.ts` | Timeout, manual redirect re-validation, size cap, politeness, retry |
| Extractor | `web/gatherers/contentExtractor.ts` | Readability-style main-content extraction, **zero deps** |
| Scorer | `web/scoring/qualityScorer.ts` | relevance/freshness/authority/completeness/uniqueness |
| Pipeline | `web/pipeline/gatheringPipeline.ts` | Orchestrates gather with bounded concurrency + fault isolation |
| Synthesizer | `web/processors/webInsightSynthesizer.ts` | LLM synthesis → grounded `WebInsight` (mirror synthesizer pattern) |
| Store | `web/storage/webResearchStore.ts` | Persists to existing `digim_content` / `digim_intelligence` |
| Facade | `web/webResearchOrchestrator.ts` | Cache → gather → synthesize; owns its own `DinaLLMManager` |

### New capabilities exposed

| Method (DUMP) | HTTP | Behavior |
|---|---|---|
| `digim_research` | `POST /dina/api/v1/digim/research` | Surf → gather → synthesize → grounded insight |
| `digim_gather` (upgraded) | `POST /dina/api/v1/digim/gather` | Surf → gather → store documents only |
| `digim_query` (upgraded) | `POST /dina/api/v1/digim/query` | NL query → full research when enabled |

---

## 3. Design principles honored

- **Established infrastructure respected.** Reuses DUMP, `database.query`,
  `redisManager`, the per-module `DinaLLMManager` isolation pattern, and the
  existing DIGIM tables — **no new npm dependencies, no schema changes.**
- **Separate concerns / no intertwined logic.** Each stage is one module with a
  single responsibility, composed by the pipeline.
- **Enterprise robustness.** Every stage is fault-isolated; one bad URL never
  fails a run. Defensive env parsing, LLM-JSON normalization, graceful
  degradation (degraded insight when the LLM is down).
- **Security first.** SSRF guard on every fetch and every redirect hop; content
  is parameterized into SQL; the subsystem is closed by default.
- **Effective UX.** Rich, structured responses with source attribution,
  confidence, caveats, and full diagnostics for observability.

See [`RESEARCH.md`](./RESEARCH.md) for the best-practices research that grounded
these choices, [`INTEGRATION.md`](./INTEGRATION.md) to enable it,
[`EDGE_CASES.md`](./EDGE_CASES.md) for edge-case coverage, and
[`VERIFICATION.md`](./VERIFICATION.md) for test results.
