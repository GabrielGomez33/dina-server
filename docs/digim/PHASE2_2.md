# Phase 2.2 — Tool abstraction + BrowserTool

Gives DINA a **second way to acquire a page**: a headless Chromium that runs
JavaScript, so she can read the JS-rendered web that a plain fetch returns as an
empty shell. Built as a bounded, security-hardened **escalation** — never the
default path.

## What shipped

| Piece | File | Role |
|---|---|---|
| **FetchTool interface** | `web/tools/fetchTool.ts` | The acquisition role: URL → `FetchResult`. Introduced now because the browser is a *second fetcher* (abstract on the 2nd instance, not the 1st). The broader *SourceTool* role waits for 2.3. |
| **HttpFetchTool** | `web/tools/httpFetchTool.ts` | Thin adapter over the proven `WebFetcher` (untouched). The cheap default. |
| **BrowserTool** | `web/tools/browserTool.ts` | Connects to a containerized headless Chromium over a WebSocket; all app-layer security controls. |
| **thinContent** | `web/tools/thinContent.ts` | Pure "empty SPA shell" heuristic — the escalation trigger. |
| **FetchToolRegistry** | `web/tools/fetchRegistry.ts` | Selection: fetch-first / render-on-miss, browser concurrency semaphore, circuit breaker. |

## How selection works

```
'off'     → HTTP only (byte-for-byte the pre-2.2 behavior)
'on-miss' → HTTP first; escalate to the browser ONLY on a JS shell or 403/429
'always'  → browser first (debugging/special jobs), HTTP fallback
```

Per-request override via `browser_mode` on `digim_research` / `digim_gather`; the
browser can **never** be forced on if globally disabled or unavailable (the
registry enforces this). Escalation is bounded by a **semaphore** (default 2
concurrent pages, separate from HTTP concurrency) and a **circuit breaker** (stops
escalating after repeated browser failures).

## Security model (two layers)

- **App layer (in DINA):** `page.route` intercepts *every* browser request and
  runs it through the **same `checkUrlSafety()` SSRF policy** as the HTTP fetcher;
  images/media/fonts/CSS blocked by type; per-page request cap; post-navigation
  URL re-check; byte cap; hard timeouts; fresh isolated context per fetch.
- **Network layer (the container):** Chromium runs in a hardened, **network-
  segregated** container (`ops/PLAYWRIGHT_RUNBOOK.md`) whose egress filter denies
  private/loopback/link-local/metadata but allows the public internet. This is the
  outer "can't leave the environment" guarantee and the true DNS-rebinding fix.

## Graceful degradation

`playwright` is an **optional dependency** loaded via guarded require, and the
browser runs off-box. Not installed, no endpoint, or service down →
`isAvailable()` is false, research silently stays HTTP-only, **no crash**.
`browserAvailable`/`browserStatus` surface in `digim_status`; `browserUsed`/
`escalated` surface in every gather's `diagnostics`.

## Enabling

Default **OFF**. Stand up the container per `ops/PLAYWRIGHT_RUNBOOK.md`, then:

```bash
DIGIM_WEB_BROWSER_ENABLED=true
DIGIM_WEB_BROWSER_WS_ENDPOINT=ws://localhost:3000
DIGIM_WEB_BROWSER_MODE=on-miss
```

## Known limit

Enterprise bot-walls (Cloudflare/DataDome/…) detect headless Chromium. 2.2 reaches
the JS-rendered **open** web, not fortresses behind those walls — an expected
ceiling, not a defect.

## Verification

- `tsc` clean.
- Hermetic tool tests: **32/32** (`npm run test:tools`) — thin-content detection,
  resource-type block policy, mode resolution, escalation trigger, and the full
  registry policy (off / on-miss-rich / on-miss-shell / 403 / always / unavailable
  / fallback / circuit-breaker) driven with mock tools.
- No regression: web 107/107, memory 33/33, migration 18/18.
- Additive + config-gated: with `DIGIM_WEB_BROWSER_ENABLED=false` (default),
  acquisition is unchanged.

Live headless-browser drive is verified on the production box after the container
is stood up (the sandbox can't run Chromium) — same honest split used for the DB
migration.

## Live verification (production, 2026-07-11)

Stood up the hardened browser container and drove the whole chain end-to-end.

| Check | Result |
|---|---|
| **Container** | `mcr.microsoft.com/playwright` + baked-in CLI, `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`, loopback-only port, mem/cpu capped. `Listening on ws://…:3000`. |
| **Network "can't leave"** | A/B proof from inside the container: `BLOCKED host:22 ✓` (cannot reach the host) **and** `PUBLIC …:443 REACHED ✓` (can reach the internet + DNS). |
| **Direct connect** | `chromium.connect(ws://localhost:3000)` → rendered `example.com` (559 bytes). |
| **End-to-end via DINA** | `digim_research` with `browser_mode:"always"` on a live Wikipedia page → `fetched:1, browserUsed:1, errors:[]`. The containerized, network-locked browser rendered the page through the full request→registry→BrowserTool path. |

### Two bugs the live bring-up exposed (both fixed)

1. **Egress firewall was FORWARD-only.** `DOCKER-USER` rules didn't block the
   container reaching the **host itself** — that traffic hits `INPUT`, not
   `FORWARD`. Added `INPUT` drop (new container→host) + established-accept. The
   A/B test is what caught it.
2. **`browser_mode` was dropped at the API boundary.** The `/digim/research` and
   `/digim/gather` routes whitelist payload fields and didn't forward
   `browser_mode`, so per-request escalation silently fell back to the config
   default (browser never invoked). Now forwarded. Also added logging to every
   `BrowserTool` failure branch so a browser fetch can never fail silently again.

### Ops footnote

The base `mcr.microsoft.com/playwright` image ships browsers but not the CLI on
PATH, and `read_only` blocks a runtime `npx` install — so the CLI is baked in via
a tiny Dockerfile at build time (built with `network: host` to satisfy buildkit
DNS). The DINA host uses `playwright-core` (connect-only client, no browser
download). All in `ops/PLAYWRIGHT_RUNBOOK.md`.
