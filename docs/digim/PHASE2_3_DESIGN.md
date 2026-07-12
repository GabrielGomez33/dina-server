# Phase 2.3 — Design: SourceTool role + FeedTool + public APIs

Give DINA more *ways to find sources* beyond the SearXNG search provider: RSS/Atom
feeds and clean public APIs. These are the low-risk, high-signal counterpart to
the 2.2 browser — structured data, **no JavaScript execution, no container needed**.

## The second tool ROLE

2.2 introduced the **FetchTool** role (URL → content). 2.3 introduces the
**SourceTool** role — now that a second instance of it exists, per the
"abstract on the 2nd" rule:

```ts
interface SourceTool {
  readonly name: string;              // 'feeds' | 'wikipedia' | 'hn' | ...
  isEnabled(): boolean;               // config-gated per source
  collect(query, limit): Promise<SearchResult[]>;  // MUST resolve; errors → []
}
```

**Key simplification:** a SourceTool produces the SAME `SearchResult` shape the
search provider already produces (url/title/snippet/publishedAt/provider). So
sources are just *additional discovery producers* that merge into the existing
candidate list — then flow through the SAME proven pipeline (SSRF-guard → fetch →
extract → score → embed → synthesize). **Zero pipeline surgery** beyond "also ask
the sources for candidates."

```
 search provider (SearXNG) ─┐
 seed URLs ─────────────────┤→ merge + dedupe → [existing pipeline unchanged]
 SourceTools (feeds/wiki/hn)┘
```

## Sources shipping in 2.3a (this increment)

| Source | Query-driven? | What it returns | Risk |
|---|---|---|---|
| **FeedTool** (`feeds`) | No — polls configured feeds | recent entries from operator-listed RSS/Atom URLs, optionally keyword-filtered | low |
| **Wikipedia** (`wikipedia`) | Yes | top matching article URLs (via the opensearch API) | low |
| **Hacker News** (`hn`) | Yes | top matching stories (via the free Algolia HN API) | low |

Two+ instances justify the role; FeedTool is the named centerpiece; all three are
key-free and well-behaved. Content they surface is still UNTRUSTED and still passes
through the existing prompt-injection fencing at synthesis.

## Deferred to 2.3b (honest scoping)

- **Reddit `.json`** — easy format but rate-limited / UA-sensitive; needs care.
- **Mastodon** — per-instance, hashtag timelines; pick instances.
- **YouTube captions** — fiddliest (no clean key-free transcript API); may need a
  document-kind source (content-in-hand) rather than a URL producer. Worth it for
  2.4 but not worth blocking 2.3a.
- **Wikidata** — structured entity/relationship facts; a better fit for the 2.4
  relationship graph than for 2.3 discovery.

## Security & governance

- SourceTool API endpoints (wikipedia.org, hn.algolia.com) are operator-trusted
  hosts (like the search provider) — their own calls don't need the SSRF guard.
- **Feed URLs are URL-based config**, so FeedTool runs each feed fetch through the
  SSRF guard anyway (cheap defense in depth).
- Every RESULT URL a source returns is untrusted and passes the SSRF guard before
  any fetch — identical to search results.
- Config-gated, default OFF: `DIGIM_WEB_SOURCES` empty → no sources, no behavior
  change.

## Config

```bash
DIGIM_WEB_SOURCES=wikipedia,hn,feeds     # which sources are enabled (default: none)
DIGIM_WEB_FEED_URLS=https://a/rss,https://b/atom   # feeds for the FeedTool
DIGIM_WEB_SOURCE_MAX_RESULTS=5           # cap per source per query
```

## Files

- `web/sources/sourceTool.ts` — role interface + a bounded fetch helper.
- `web/sources/feedTool.ts` — RSS/Atom parser (dependency-free) + collect.
- `web/sources/wikipediaSource.ts`, `web/sources/hackerNewsSource.ts`.
- `web/sources/sourceRegistry.ts` — builds enabled tools, `collect()` fans out.
- `config/webConfig.ts` — `sources`, `feedUrls`, `sourceMaxResults`.
- `pipeline/gatheringPipeline.ts` — merge source candidates into discovery.
- `webResearchOrchestrator.ts` — `getStatus()` reports enabled sources.
- Tests `test/digim/sourceTest.ts` — RSS + Atom parsing, registry merge/enablement.

Verified hermetically (parse + merge logic), then live on prod. Additive and
default-off.
