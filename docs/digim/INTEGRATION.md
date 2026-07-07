# Integration & Operations Guide

## How it is wired (already integrated, gated off)

The subsystem is already wired into the running server through **additive**
changes (see [`CHANGES.md`](./CHANGES.md)). With `DIGIM_WEB_ENABLED` unset,
nothing changes at runtime.

```
HTTP POST /dina/api/v1/digim/research
  → api/routes/index.ts            (builds DUMP message: target digim/digim_research)
  → dina.handleIncomingMessage()   (orchestrator routes module 'digim')
  → digiMOrchestrator.handleIncomingMessage() → routeRequest('digim_research')
  → handleResearchRequest()
  → webResearch.research()          (WebResearchOrchestrator facade)
      → GatheringPipeline.gather()  (search → fetch → extract → score → store)
      → WebInsightSynthesizer.synthesize()  (own DinaLLMManager → grounded insight)
      → WebResearchStore.storeIntelligence()
```

## Enabling it

Set these in the PM2 env block (`ecosystem.config.js`) or the process
environment. **Minimum to turn it on** (self-hosted SearXNG recommended):

```bash
DIGIM_WEB_ENABLED=true
DIGIM_WEB_SEARCH_PROVIDER=searxng
DIGIM_WEB_SEARXNG_URL=http://localhost:8080     # your SearXNG instance
```

Brave or Tavily instead:

```bash
DIGIM_WEB_SEARCH_PROVIDER=brave
DIGIM_WEB_BRAVE_API_KEY=...
# or
DIGIM_WEB_SEARCH_PROVIDER=tavily
DIGIM_WEB_TAVILY_API_KEY=...
```

## Full configuration reference (all optional, safe defaults)

| Env var | Default | Meaning |
|---|---|---|
| `DIGIM_WEB_ENABLED` | `false` | Master switch. Nothing reaches the network unless `true`. |
| `DIGIM_WEB_SEARCH_PROVIDER` | `none` | `none` \| `searxng` \| `brave` \| `tavily` |
| `DIGIM_WEB_SEARXNG_URL` | `http://localhost:8080` | SearXNG base URL |
| `DIGIM_WEB_BRAVE_API_KEY` | `` | Brave Search API key |
| `DIGIM_WEB_TAVILY_API_KEY` | `` | Tavily API key |
| `DIGIM_WEB_MAX_SEARCH_RESULTS` | `10` | Results requested per query (1–50) |
| `DIGIM_WEB_MAX_DOCUMENTS` | `8` | Documents fetched+extracted per gather (1–50) |
| `DIGIM_WEB_MIN_WORD_COUNT` | `60` | Drop extracted docs shorter than this |
| `DIGIM_WEB_FETCH_CONCURRENCY` | `4` | Concurrent fetches (1–16) |
| `DIGIM_WEB_PER_HOST_DELAY_MS` | `1000` | Politeness delay between hits to one host |
| `DIGIM_WEB_FETCH_TIMEOUT_MS` | `15000` | Per-request timeout |
| `DIGIM_WEB_MAX_CONTENT_BYTES` | `5242880` | Hard body-size cap (5 MB) |
| `DIGIM_WEB_MAX_REDIRECTS` | `3` | Max redirect hops (each re-validated) |
| `DIGIM_WEB_FETCH_RETRIES` | `2` | Retries on transient failure (backoff) |
| `DIGIM_WEB_USER_AGENT` | `DINA-DIGIM/1.0 (…)` | Outbound UA |
| `DIGIM_WEB_SSRF_GUARD` | `true` | **Keep true in prod.** Master SSRF toggle |
| `DIGIM_WEB_BLOCK_PRIVATE_RANGES` | `true` | Block private/loopback/link-local/metadata IPs |
| `DIGIM_WEB_ALLOWED_HOSTS` | `` | If set, ONLY these hosts (suffix match) may be fetched |
| `DIGIM_WEB_DENIED_HOSTS` | `` | Always-blocked hosts (suffix match) |
| `DIGIM_WEB_ALLOWED_PORTS` | `80,443` | Permitted outbound ports |
| `DIGIM_WEB_SYNTHESIS_MODEL` | `$DINA_ANALYSIS_MODEL` (`mistral:7b`) | LLM for synthesis |
| `DIGIM_WEB_SYNTHESIS_MAX_TOKENS` | `1200` | Synthesis token budget |
| `DIGIM_WEB_SYNTHESIS_TIMEOUT_MS` | `240000` | Hard synthesis timeout |
| `DIGIM_WEB_SYNTHESIS_MAX_DOCUMENTS` | `6` | Docs fed to one synthesis prompt |
| `DIGIM_WEB_SYNTHESIS_PER_DOC_CHARS` | `2000` | Per-doc char budget in the prompt |
| `DIGIM_WEB_INTEL_CACHE_TTL_HOURS` | `6` | Cache TTL for a query's intelligence (0 = off) |
| `DIGIM_WEB_CONTENT_RETENTION_DAYS` | `30` | Retention target for gathered content |

## API usage

All endpoints require the standard DINA auth (same as other `/digim/*` routes).

```bash
# Full research (gather + synthesize)
curl -X POST https://<host>/dina/api/v1/digim/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"latest advances in solid-state batteries","intelligence_level":"deep","max_documents":6}'

# Gather only (no synthesis)
curl -X POST https://<host>/dina/api/v1/digim/gather \
  -H 'Content-Type: application/json' \
  -d '{"query":"solid-state batteries","max_documents":8}'

# Seed specific URLs instead of/alongside a search
curl -X POST https://<host>/dina/api/v1/digim/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"","seed_urls":["https://example.org/report"]}'
```

`digim_research` response shape (abridged):

```jsonc
{
  "status": "success",
  "query": "…",
  "intelligence_level": "deep",
  "cached": false,
  "insight": {
    "summary": "…",
    "keyInsights": ["…"],
    "entities": [{"text":"…","type":"organization"}],
    "topics": [{"topic":"…","relevance":0.8}],
    "trends": [{"trend":"…","direction":"rising"}],
    "confidence": 0.74,
    "sources": [{"title":"…","url":"…"}],
    "caveats": ["…"]
  },
  "documents_gathered": 6,
  "diagnostics": { "searchProvider":"searxng","candidatesFound":10,"fetched":8,"extracted":7,"stored":6,"duplicates":1,"skipped":[…],"errors":[…] },
  "intelligence_id": "…",
  "processing_time_ms": 8421
}
```

## Data model

No new tables. Reuses the existing DIGIM schema:

- **`digim_content`** — one row per gathered document. All ad-hoc web documents
  attach to a single stable system source row (`DINA Web Research`,
  id `d1611eb0-0000-4000-8000-000000000001`) which the store upserts on init,
  satisfying the `NOT NULL` FK without a schema change. The true origin URL lives
  on the row. Dedup is by the unique `content_hash`.
- **`digim_intelligence`** — one row per synthesized insight, keyed by
  `query_hash` with `expires_at` for cache serving.

## Optional future upgrade: Mozilla Readability

The heuristic extractor is intentionally dependency-free. To upgrade extraction
quality, add `@mozilla/readability` + `linkedom`, then implement a class with the
same `extract(html, contentType, url): ExtractedContent` shape and swap it into
`GatheringPipeline`'s constructor. No other code changes required.
