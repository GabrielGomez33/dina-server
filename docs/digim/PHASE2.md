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

- **2.2 — Tool abstraction + BrowserTool: ✅ DONE** (`docs/digim/PHASE2_2.md`).
  The `FetchTool` acquisition role + registry (fetch-first / render-on-miss),
  plus a headless-Chromium tool that runs in a hardened, network-segregated
  **container** and is driven over the wire — app-layer SSRF + container egress
  filter, concurrency semaphore, and circuit breaker. Per-job `browser_mode`.
- **2.3 — SourceTool role + FeedTool + public APIs:** introduce the *second* tool
  role (query → documents) now that a second instance exists: RSS/Atom/sitemap
  ingestion and clean key-optional public APIs (Wikipedia/Wikidata, Reddit
  `.json`, YouTube captions, Mastodon, HN). These are the low-risk, high-signal
  counterpart to the browser — structured data, no JS execution. They register
  alongside the search provider and feed candidates/documents into the same
  proven pipeline.
- **2.4 — Intelligence graph (Palantir tactics):** a **research planner** that
  decomposes a broad question into sub-queries and fuses them, feeding an
  **entity + relationship graph** with provenance and corroboration — "see the
  relationships between information." Built on the richer harvest that 2.2 (JS web)
  and 2.3 (structured sources) provide.
- **Tier-3 (opt-in):** authenticated/social sources — gated, per-job, logged. For
  genuinely hostile targets, escalate the browser container to a microVM sandbox
  (gVisor/Firecracker/Kata).

Verified: tsc clean; web 107/107, memory 33/33, migration 18/18. Additive and
config-gated — with `DIGIM_WEB_SEARCH_PROVIDER=none` (default) nothing changes.

## Live capstone verification (production, 2026-07-11)

SearXNG (`DIGIM_WEB_SEARCH_PROVIDER=searxng`) wired into the production box and
the full pipeline exercised end-to-end on live, worldwide, post-training-cutoff
news. Every layer confirmed against real data — no fixtures.

| Layer | Result |
|---|---|
| **Status** | `enabled=true, provider=searxng, providerConfigured=true, memoryEnabled=true` |
| **Discovery** (`digim_search`) | 10 candidates for "iran united states conflict 2026" — AP, Guardian, NYT, USA Today, Congress.gov PDF, Britannica, Wikipedia — **each SSRF-annotated `safe:true`, none fetched**. |
| **Fetch robustness** | 10 found → 8 fetched/extracted/stored, 0 duplicates. Two failures **caught gracefully**: CNN live-blog exceeded the 5 MB cap (rejected, no OOM); Britannica returned HTTP 403 (caught, no crash). |
| **Synthesis** (`digim_research`, deep) | Grounded July-2026 briefing (late-Feb outbreak, failed nuclear talks, US/Israel strikes, Iranian missile/drone response, regional spillover). Confidence 0.8, 6 sources cited, honest caveat flagging conflicting-timeline disagreement across sources. Discovered "Twelve-Day War" via the search fan-out (not in the original 10). |
| **Semantic memory** (`digim_recall`) | Query "strait of hormuz oil tensions" — **zero words shared with the research query** — recalled all 8 gathered docs by meaning (scores 0.53–0.68). Proves vector recall, not keyword match. |
| **Transparency** | `basis`, `memory_used`, `sources_consulted`, and `diagnostics` (candidates/fetched/extracted/stored/errors) all accurate to the run. |

The `basis` field behaved correctly across the run: first (uncached) research
returned `web+memory`; the immediate re-run returned `cache` with
`documents_gathered:0` — the intelligence cache serving without re-fetching, as
designed.

Phase 2 (autonomous discovery) is complete and hardened on production.
