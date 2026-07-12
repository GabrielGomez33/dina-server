# Phase 2.3 — SourceTool role + FeedTool + public APIs

Gives DINA more *ways to find sources* beyond the SearXNG search provider —
RSS/Atom feeds and clean public APIs. The low-risk, high-signal counterpart to the
2.2 browser: structured data, **no JS execution, no container**.

## What shipped

| Piece | File | Role |
|---|---|---|
| **SourceTool interface** | `web/sources/sourceTool.ts` | The second tool ROLE: query → candidate `SearchResult`s. Emits the same shape the search provider does, so sources merge into the existing pipeline with no downstream changes. |
| **FeedTool** (`rss`) | `web/sources/feedTool.ts` | Polls operator-configured RSS/Atom feeds; dependency-free parser; keyword-filters entries when a query is present. |
| **WikipediaSource** (`wikipedia`) | `web/sources/wikipediaSource.ts` | Query-driven article discovery via the key-free `opensearch` API. |
| **HackerNewsSource** (`hn`) | `web/sources/hackerNewsSource.ts` | Query-driven story discovery via the free Algolia HN API. |
| **SourceRegistry** | `web/sources/sourceRegistry.ts` | Builds enabled sources; fans a query out in parallel, fault-isolated. |

Discovery now merges three producers — search provider + seed URLs + enabled
sources — then flows through the unchanged, proven pipeline (SSRF-guard → fetch →
extract → score → embed → synthesize).

## Enabling (default OFF)

```bash
DIGIM_WEB_SOURCES=wikipedia,hn,feeds          # which sources are on (default: none)
DIGIM_WEB_FEED_URLS=https://a/rss,https://b/atom
DIGIM_WEB_SOURCE_MAX_RESULTS=5                # cap per source per query
```

`digim_status` reports the enabled `sources`. With `DIGIM_WEB_SOURCES` empty,
discovery is unchanged.

## Security

- Source API hosts (wikipedia.org, hn.algolia.com) are operator-trusted, like the
  search provider — their own calls skip the SSRF guard.
- **Feed URLs are URL-based config**, so each feed fetch IS run through the SSRF
  guard (defense in depth).
- Every RESULT URL a source returns is untrusted and passes the SSRF guard before
  any fetch, identical to search results. Their content passes the same
  prompt-injection fencing at synthesis.

## DUMP client API (foreign requestees)

Also in this increment: `web`/`digimClient.ts` — the single, correct DUMP
(DinaUniversalMessage) builder for anything OUTSIDE the DIGIM module (other
modules or the HTTP API) to reach DIGIM's capabilities:
`research`/`gather`/`search`/`recall`/`status`/`memoryBackfill`/`memoryPrune`.

Each capability's payload is defined in exactly **one place**, so the class of bug
that dropped `browser_mode` at the API boundary (Phase 2.2) cannot recur. The
HTTP `/digim/*` routes were refactored to dispatch through this client instead of
hand-assembling messages.

```ts
const digim = new DigimClient(dina, { sourceModule: 'api' });
await digim.research({ query: 'iran oil', browserMode: 'on-miss' }, caller);
```

## Deferred to 2.3b (honest scoping)

Reddit `.json` (rate-limit/UA care), Mastodon (per-instance), YouTube captions
(needs a content-in-hand source, fiddly), Wikidata (better fit for 2.4's graph).

## Verification

- tsc clean; sources **20/20** (`npm run test:sources`) — RSS + Atom parsing
  (CDATA, entities, link preference, dates), malformed-feed degradation, and
  config-gated source enablement.
- No regression: tools 32/32, web 107/107, memory 33/33, migration 18/18.
- Additive + default-off. Live source calls verified on the box.
