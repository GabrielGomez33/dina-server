# DIGIM API — Frontend Reference

The complete, DUMP-compliant API surface the DINA frontend SPA consumes. Every
endpoint below is backed by a `DigimClient` method that builds a
`DinaUniversalMessage` and routes it through `dina.handleIncomingMessage` — so
the REST layer is a thin, uniform shell over the protocol. Foreign modules can
call the same capabilities in-process via `DigimClient` (see
`src/modules/digim/digimClient.ts`).

## Conventions

- **Base path:** `/<api-prefix>/digim/...` — on the production box this is
  `https://<host>:8445/dina/api/v1/digim/...`.
- **Auth:** requests pass through the standard auth middleware (`req.dina`).
  Reads used by the frontend work at the normal trust level; only the
  `/digim/memory/*` admin routes require `trusted`.
- **CORS (dev):** the Vite dev/preview origins (`localhost:5173`, `:4173`) are
  allowlisted in non-production so the SPA can develop against the API. In
  production, serve the SPA from an allowlisted origin (same-origin is simplest —
  then no CORS is involved at all).
- **Response envelope:** successful bodies include `status: "success"` and an
  `auth_info: { trust_level, rate_limit_remaining }`. Errors return an HTTP 4xx/5xx
  with `{ error, message }`. A disabled subsystem returns `{ status: "disabled" }`.
- **Reads are GET, actions are POST.** Lists/details are cacheable GETs; anything
  that gathers, synthesizes, or mutates is a POST.

## Capability map

| Capability | HTTP | Route | DUMP method | Client method |
|---|---|---|---|---|
| Research (gather → synthesize) | POST | `/digim/research` | `digim_research` | `research()` |
| Investigate (multi-facet) | POST | `/digim/investigate` | `digim_investigate` | `investigate()` |
| Gather (raw documents) | POST | `/digim/gather` | `digim_gather` | `gather()` |
| Search (discovery, no fetch) | POST | `/digim/search` | `digim_search` | `search()` |
| Recall (semantic memory) | POST | `/digim/recall` | `digim_recall` | `recall()` |
| Graph (subgraph + view) | POST | `/digim/graph` | `digim_graph` | `graph()` |
| Semantic (3D embedding cloud) | POST | `/digim/semantic` | `digim_semantic` | `semantic()` |
| Node insight (on-demand) | POST | `/digim/node-insight` | `digim_node_insight` | `nodeInsight()` |
| **History (list researches)** | **GET** | `/digim/history` | `digim_history` | `history()` |
| **Get research (by id)** | **GET** | `/digim/research/:id` | `digim_get` | `get()` |
| Status | GET | `/digim/status` | `digim_status` | `status()` |
| Sources | GET | `/digim/sources` | `digim_sources` | — |
| Memory backfill (admin) | POST | `/digim/memory/backfill` | `digim_memory_backfill` | `memoryBackfill()` |
| Memory prune (admin) | POST | `/digim/memory/prune` | `digim_memory_prune` | `memoryPrune()` |

The three views the SPA renders map to: **research/investigate/get** (the
briefing), **graph** (network + timeline), **semantic** (the cloud). `history`
is the session sidebar; `get` re-opens one.

---

## Research history (the session sidebar)

Every `research`/`investigate` run is already persisted as a `digim_intelligence`
record. These two endpoints expose that store as a browsable history.

### `GET /digim/history`

List past researches, newest first.

Query params (all optional): `limit` (1–200, default 30), `offset` (default 0),
`type` (`surface|deep|predictive`), `search` (LIKE on the query text).

```json
{
  "status": "success",
  "total": 42,
  "count": 30,
  "offset": 0,
  "items": [
    {
      "id": "b1f0…",
      "query": "the 2026 Iran-USA war: causes, timeline, oil effects",
      "level": "deep",
      "confidence": 0.82,
      "model": "mistral:7b",
      "processingTimeMs": 91234,
      "generatedAt": "2026-07-13T14:28:42.000Z",
      "expiresAt": null,
      "sourceCount": 22,
      "snippet": "Iran and the United States escalated after…"
    }
  ]
}
```

Render `items` as the sidebar; page with `offset += limit` until `offset+count >= total`.

### `GET /digim/research/:id`

Open one research in full. Add `?with_documents=true` to also resolve the gathered
source documents behind it.

```json
{
  "status": "success",
  "research": {
    "id": "b1f0…", "query": "…", "level": "deep",
    "confidence": 0.82, "model": "mistral:7b", "processingTimeMs": 91234,
    "generatedAt": "2026-07-13T14:28:42.000Z", "expiresAt": null,
    "sourceCount": 22,
    "summary": "…full briefing text…",
    "keyInsights": ["oil shock", "Hormuz closure"],
    "trends": ["Brent > $120"],
    "entities": [{ "text": "Iran", "type": "location" }],
    "topics":   [{ "topic": "oil", "relevance": 0.9 }],
    "caveats":  ["some sources disputed the casualty figures"],
    "sources":  ["https://reuters.com/…", "https://apnews.com/…"],
    "sourceContentIds": ["c1", "c2"],
    "documents": [
      { "id": "c1", "title": "…", "url": "https://…", "snippet": "…", "provider": "searxng" }
    ]
  }
}
```

`404` with `{ status: "not_found" }` if the id is unknown. Retention: records
persist until the retention sweep prunes them (`DIGIM_WEB_RETENTION_DAYS`); the
cache TTL only affects re-serving, not visibility in history.

**Wiring a research into the other views:** from a detail record, open the
graph with `entities[0].text` (or the query) as the focus, and the semantic
cloud with the query as the `filter`.

---

## Perform / open each view

### `POST /digim/research`
`{ "query": string, "intelligence_level"?: "surface"|"deep"|"predictive", "browser_mode"?: "off"|"on-miss"|"always", "graph"?: boolean }`
→ `{ status, answer|summary, basis, sources[], entities[], confidence, graph_relationships_added, … }`

### `POST /digim/investigate`
`{ "query": string, "intelligence_level"?: … }` → decomposes into facets, runs each
through the pipeline, fuses. Returns the fused briefing plus `facets_planned`,
`sources_consulted`. (Long-running — the API allows up to 300s.)

### `POST /digim/gather`
`{ "query": string, … }` → raw gathered documents (no synthesis).

### `POST /digim/search`
`{ "query": string }` → candidate URLs (each SSRF-annotated), no fetch.

### `POST /digim/recall`
`{ "query": string, "top_k"?: number, "min_score"?: number }` → semantic-memory hits.

### `POST /digim/graph`
`{ "query": string, "max_nodes"?: number }` →
`{ status, focus, matched_focus, suggested_view, node_count, edge_count, nodes[], edges[], graph_totals }`.
`nodes[]`: `{ id, name, type, occurred_at, weight }`. `edges[]`:
`{ from, predicate, to, corroboration, confidence, occurred_at, sources[] }`.
Feeds the **Network** and **Timeline** views.

### `POST /digim/semantic`
`{ "filter"?: string, "limit"?: number }` →
`{ status, dimensions, point_count, explained_variance[3], points[] }`.
`points[]`: `{ id, label, url, provider, x, y, z }` (coords in `[-1,1]`).
Feeds the **Semantic** cloud. Points are deduped by source URL.

### `POST /digim/node-insight`
`{ "entity": string, "max_sources"?: number }` →
`{ status, entity, insight, relationships[], sources[], cached }`.
One grounded LLM call over the entity's graph relationships + stored source
snippets. Cached per entity (30 min). Used by "Generate insight" on a node.

### `GET /digim/status`
Subsystem health: provider, memory, browser, sources, planner, graph enablement,
retention. Use to gate UI (e.g. hide the graph tab when `graphEnabled` is false).

---

## In-process use (foreign modules / SSR)

```ts
import { DigimClient } from 'src/modules/digim/digimClient';
const digim = new DigimClient(dina, { sourceModule: 'frontend-bff' });

const { items, total } = await digim.history({ limit: 30 });
const research      = await digim.get({ id, withDocuments: true });
const cloud         = await digim.semantic({ filter: 'iran' });
const sub           = await digim.graph({ query: 'Iran' });
const note          = await digim.nodeInsight({ entity: 'the Strait of Hormuz' });
```

Every call is DUMP-compliant end to end — the same envelope validation, routing,
and security the rest of DINA uses.
