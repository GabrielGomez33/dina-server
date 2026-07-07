# Change Manifest — dina-server

Every change made for Goal #1, so the delta is auditable at a glance. All
changes are **additive and reversible**; the subsystem is **off by default**.

## New files (the subsystem) — `src/modules/digim/web/`

| File | Lines of concern |
|---|---|
| `config/webConfig.ts` | Env-driven frozen config singleton (mirrors `llmConfig.ts`) |
| `security/urlGuard.ts` | SSRF guard: scheme/creds/port/DNS/private-range (IPv4+IPv6) |
| `types.ts` | Shared, dependency-free vocabulary for the pipeline |
| `gatherers/searchProvider.ts` | Pluggable SearXNG / Brave / Tavily / none |
| `gatherers/webFetcher.ts` | Safe fetch: timeout, redirect re-validation, size cap, retry |
| `gatherers/contentExtractor.ts` | Readability-style extraction, zero deps |
| `scoring/qualityScorer.ts` | relevance/freshness/authority/completeness/uniqueness |
| `pipeline/gatheringPipeline.ts` | search→fetch→extract→dedupe→score→store, bounded concurrency |
| `processors/webInsightSynthesizer.ts` | LLM synthesis → grounded `WebInsight` |
| `storage/webResearchStore.ts` | Persists to existing `digim_content`/`digim_intelligence` |
| `webResearchOrchestrator.ts` | Facade: cache → gather → synthesize; own `DinaLLMManager` |
| `index.ts` | Public barrel + lazy singleton |

## Modified existing files (additive only)

### `src/modules/digim/types/index.ts`
- Added `'digim_research'` to the `DigiMMethod` union and the `isDigiMMethod`
  guard list. (No existing method removed or changed.)

### `src/modules/digim/index.ts`
- Imported the web subsystem barrel (`getWebResearchOrchestrator`, `checkUrlSafety`).
- Added a `webResearch` field (lazy singleton; constructor does no I/O).
- `initialize()`: added a **non-fatal** web-research init step (a cheap no-op
  when disabled).
- `shutdown()`: added a best-effort web-research shutdown.
- `routeRequest()`: added the `digim_research` case.
- `handleGatherRequest()`: real gathering when enabled; **original placeholder
  preserved** when disabled.
- `handleQueryRequest()`: real research when enabled; **original placeholder
  preserved** when disabled.
- Added `handleResearchRequest()`.
- Added the `normalizeIntelligenceLevel()` helper (maps invalid `basic`→`surface`).
- **Security fix** in `testSource()`: routed the pre-existing arbitrary-URL
  `fetch` through `checkUrlSafety` (was an SSRF hole).

### `src/api/routes/index.ts`
- **Bug fix:** `/digim/sources` now sends `digim_sources` + `action:'list'`
  (was the non-existent `digim_list_sources`, which always threw).
- Added `POST /digim/research` and `POST /digim/gather` endpoints.

## New files (this delivery package) — `digim-web-research/`

`README.md`, `RESEARCH.md`, `INTEGRATION.md`, `EDGE_CASES.md`, `VERIFICATION.md`,
`CHANGES.md`, and `tests/edgeCases.ts`.

## Not changed

- `package.json` / `package-lock.json` — **no new dependencies.**
- Database schema — **no new tables, no ALTERs.**
- Any existing module behavior when `DIGIM_WEB_ENABLED` is unset.

## Reverting

Delete `src/modules/digim/web/` and `digim-web-research/`, then revert the three
modified files. Or simply leave `DIGIM_WEB_ENABLED` unset — the subsystem stays
dormant.

## mirror-server

No mirror-server changes were required for Goal #1. This folder is reserved for
mirror-server updates in later goals; none exist yet.
