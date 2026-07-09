# Phase 2 — Tool Ecosystem

Turning DINA from "I hand her URLs" into "she finds her own sources," then
expanding *how* she reaches public data. Built incrementally on the proven
Phase 1 foundation.

## Phase 2.1 — Autonomous discovery (this increment)

The `SearchProvider` layer (SearXNG / Brave / Tavily / none) already existed from
Phase 1. This increment operationalizes and instruments it:

| Capability | Method | HTTP | Notes |
|---|---|---|---|
| **Discovery inspection** | `digim_search` | `POST /digim/search` | Runs the provider, returns candidate URLs **each SSRF-annotated** (`safe`/`safety_reason`), **without fetching**. See/audit what DINA would gather. |
| Subsystem status | (in `digim_status`) | `GET /digim/status` | New `web_research` block: `enabled`, `provider`, `providerConfigured`, `memoryEnabled`, retention. |

With a provider configured, **`digim_research` and `digim_query` now work from a
query alone** (no `seed_urls`): search → SSRF-guard → fetch → extract → score →
embed → synthesize.

- `GatheringPipeline.search()` / `providerConfigured` expose discovery.
- `WebResearchOrchestrator.discover()` annotates each candidate with the SSRF
  verdict; `getStatus()` reports operational state.
- Every discovered URL still passes the SSRF guard before any fetch — discovery
  never bypasses security.

### Enabling it

Stand up self-hosted SearXNG (free, no key) per `ops/SEARXNG_RUNBOOK.md` — the
one gotcha is that SearXNG ships with the **JSON API disabled** and DINA needs
it on. Then:

```bash
DIGIM_WEB_SEARCH_PROVIDER=searxng
DIGIM_WEB_SEARXNG_URL=http://localhost:8080
```

### Verify

```bash
# what does she discover? (each candidate SSRF-annotated)
curl -sk .../digim/search   -d '{"query":"solid state battery 2026"}' | jq '{provider, provider_configured, candidate_count}'
# autonomous research — no seed_urls
curl -sk .../digim/research -d '{"query":"solid state battery 2026","intelligence_level":"deep"}' | jq '.diagnostics'
```

## Roadmap (next increments)

- **2.2 — Tool abstraction + BrowserTool:** a `ResearchTool` interface + registry
  (introduced when the 2nd tool arrives, to avoid premature abstraction), plus a
  headless-Chromium/Playwright tool for JS-rendered public pages, with per-job
  tool selection.
- **2.3 — FeedTool + public APIs:** RSS/Atom/sitemap ingestion and clean
  key-optional public APIs (Wikipedia/Wikidata, Reddit `.json`, YouTube
  captions, Mastodon, HN).
- **2.4 — Intelligence graph (Palantir tactics):** entity resolution, relationship
  graph, provenance, corroboration.
- **Tier-3 (opt-in):** authenticated/social sources — gated, per-job, logged.

Verified: tsc clean; web 107/107, memory 33/33, migration 18/18. Additive and
config-gated — with `DIGIM_WEB_SEARCH_PROVIDER=none` (default) nothing changes.
