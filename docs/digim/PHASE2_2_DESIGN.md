# Phase 2.2 — Design: ResearchTool abstraction + BrowserTool

**Status: IMPLEMENTED (code merged; live browser verification pending on prod).**

> **Implementation deltas from the original proposal** (all discussed and approved):
> - **Containerized browser over the wire.** The browser is NOT launched in the
>   DINA process. Chromium runs in a separate, hardened, network-SEGREGATED
>   container (Playwright server / browserless); `BrowserTool` connects as a thin
>   client via `DIGIM_WEB_BROWSER_WS_ENDPOINT`. The DINA host never installs or
>   executes the browser binary. See `ops/PLAYWRIGHT_RUNBOOK.md`.
> - **Network egress filter is the outer "can't leave" guarantee.** The container
>   denies RFC1918/loopback/link-local/metadata egress but allows the public
>   internet — an *egress filter, not a block* (the browser's job is to reach
>   public URLs). This is also the true DNS-rebinding fix, since it drops packets
>   regardless of what DNS resolved. Our app-layer `page.route` SSRF check is the
>   inner layer; the network policy is the outer.
> - **Browser concurrency semaphore** (`DIGIM_WEB_BROWSER_CONCURRENCY`, default 2)
>   — separate from and lower than HTTP concurrency, so a burst of escalations
>   can't spawn N heavy pages and starve Ollama.
> - **Circuit breaker** (`DIGIM_WEB_BROWSER_BREAKER_*`) — after K consecutive
>   browser failures the registry stops escalating for a cooldown (HTTP-only),
>   so a wedged browser service can't drag research down. Plus BrowserTool's own
>   connection cooldown for a down/restarting service.
> - **Bot-detection ceiling (known limit, not a bug).** Cloudflare/DataDome/etc.
>   detect headless Chromium and serve CAPTCHAs/blocks. 2.2 reaches the JS-rendered
>   *open* web (news, blogs, docs, most public sites), NOT fortresses behind
>   enterprise bot-walls. We do not chase that arms race.
> - **robots.txt** is not honored (public-data posture); a future `DIGIM_WEB_RESPECT_ROBOTS`
>   flag can add it. Conscious choice, documented.

---

## Original proposal (below) — preserved for the record.

**Status: PROPOSED (awaiting green light before implementation).**

Goal: give DINA a second way to acquire a page — a headless browser that runs
JavaScript — so she can read the JS-rendered web she's currently blind to, while
keeping the cheap/safe HTTP path as the default and the browser as a bounded,
security-hardened escalation.

---

## 1. The seam — where a tool plugs in

Today the pipeline has exactly one acquisition point:

```
gatheringPipeline.ts:147   const fetched = await this.fetcher.fetchUrl(candidate.url);
```

`WebFetcher.fetchUrl(url) → FetchResult` (raw HTML in, `FetchResult` out). Everything
downstream — extract → score → dedupe → store → embed → synthesize — consumes
`FetchResult` and is **tool-agnostic already**. So the clean abstraction is at
*acquisition only*. We do not touch extraction or anything after it.

### Two tool ROLES (introduced only as each is justified)

The roadmap's "ResearchTool" is really two roles. We introduce each one the moment
a second concrete instance of it exists — never before:

| Role | Shape | Introduced in | Instances |
|---|---|---|---|
| **FetchTool** (acquisition) | URL in → `FetchResult` out | **2.2 (now)** | `HttpFetchTool` (existing WebFetcher), `BrowserTool` (new) |
| **SourceTool** (production) | query in → documents out | 2.3 (later) | `FeedTool`, `ApiTool` (Wikipedia/Reddit/HN…) |

2.2 introduces **FetchTool** because the browser is a second *fetcher*. The broader
SourceTool role waits for 2.3, when FeedTool actually arrives. This is the
"abstract on the 2nd instance, not the 1st" discipline you asked for.

### FetchTool interface

```ts
export type FetchToolCost = 'cheap' | 'expensive';

export interface FetchTool {
  readonly name: string;          // 'http' | 'browser'
  readonly cost: FetchToolCost;   // selection hint — prefer cheap
  isAvailable(): boolean;         // browser: is Playwright present & launchable
  fetch(url: string): Promise<FetchResult>;  // MUST resolve; errors → ok:false
  shutdown?(): Promise<void>;     // browser: close Chromium
}
```

`WebFetcher` already matches this almost exactly (`fetchUrl` → `fetch`). We wrap it
in a thin `HttpFetchTool` adapter rather than editing WebFetcher's internals — the
proven HTTP path is untouched.

---

## 2. Escalation policy — "fetch-first, render-on-miss"

The browser is **never the default path.** A tiny `FetchToolRegistry` owns selection:

```
acquire(url, { mode }):
  mode resolves to 'off' | 'on-miss' | 'always'
    - if browser globally disabled OR unavailable → forced 'off'
    - else per-request mode || config default

  'off'     → http only (today's behavior, byte-for-byte)
  'on-miss' → http first; escalate to browser ONLY if the HTTP result is:
                • ok BUT thin (JS shell — see §3), or
                • !ok with status 403/429 (bot/JS wall) [config-gated]
              keep the browser result only if it's better.
  'always'  → browser first (debugging / special jobs); http fallback on failure
```

`shouldEscalate(httpResult, cfg)` and the thin-content check are **pure functions**
→ unit-tested exhaustively without launching Chromium.

**Default config: `DIGIM_WEB_BROWSER_ENABLED=false`.** Like every other capability,
2.2 ships dormant. With it off, `acquire()` is literally `http.fetch()` — zero
behavior change, zero new risk, zero new dependency loaded.

---

## 3. Thin-content ("empty shell") detection

After the cheap HTTP fetch, a lightweight check on the raw HTML (NOT full
extraction — no double work) decides escalation:

- Crudely strip `<script>`/`<style>`, then tags; count visible non-whitespace chars.
- **Thin** ⇔ `visibleChars < DIGIM_WEB_BROWSER_THIN_TEXT_CHARS` (default 500) **AND**
  an SPA signature is present (`id="root"`, `id="__next"`, `<app-root`, `ng-version`,
  `data-reactroot`, `__NUXT__`, `__NEXT_DATA__`, or script-tag-heavy + text-poor).

Both conditions required, so a legitimately short article never triggers a costly
browser launch. Pure function, fully tested.

---

## 4. BrowserTool security model (the part that matters)

A headless browser **executes untrusted JavaScript** — the inverse of Phase 1's
"untrusted content, trusted infrastructure." Every control below is mandatory and
present from the first line:

1. **SSRF at the browser layer (closes the sub-request hole).** `page.route('**')`
   intercepts *every* request the browser attempts — document, xhr, fetch, script,
   iframe, everything. Each URL runs through the **same `checkUrlSafety()` policy**
   as WebFetcher (scheme allowlist + DNS-resolve + private/loopback/link-local/
   metadata block). Unsafe → `route.abort()`. This is what stops a malicious page
   from making the browser reach `169.254.169.254` or your LAN.
2. **Sub-resource blocking.** `image`, `media`, `font`, `stylesheet` are aborted by
   type (config `DIGIM_WEB_BROWSER_BLOCK_RESOURCES`). We allow only `document`,
   `script`, `xhr`, `fetch` — the minimum to render content. Cuts bandwidth, CPU,
   and attack surface.
3. **Per-page request cap** (`DIGIM_WEB_BROWSER_MAX_REQUESTS`, default 80) — a page
   that spins up thousands of sub-requests is cut off.
4. **Post-navigation re-check.** After load, `page.url()` (JS may have redirected) is
   re-validated through `checkUrlSafety()` before we read content.
5. **No downloads** (`acceptDownloads:false`); **byte cap** on `page.content()` (same
   `maxContentBytes` as HTTP); **hard nav timeout** (`DIGIM_WEB_BROWSER_NAV_TIMEOUT_MS`,
   default 20 s) + overall deadline.
6. **Process hygiene.** One lazily-launched shared Chromium; a **fresh context per
   fetch** (cookie/storage isolation), closed in `finally`; `browser.close()` on
   subsystem shutdown. Launch flags: `--disable-dev-shm-usage`, `--disable-gpu`
   (GPU stays reserved for Ollama). Chromium's own sandbox stays ON by default;
   `--no-sandbox` is an explicit, documented opt-in only if the box can't provide
   user namespaces.
7. **Optional dependency, guarded require.** `playwright` is an *optionalDependency*
   loaded via guarded `require` (same pattern as `@mozilla/readability`). Not
   installed → `isAvailable()=false`, mode auto-degrades to HTTP-only, one warning,
   **no crash**. `DIGIM_WEB_BROWSER_EXECUTABLE_PATH` lets you point at a system
   Chromium instead of Playwright's download.

---

## 5. Files

**New (`src/modules/digim/web/tools/`):**
- `fetchTool.ts` — `FetchTool` interface + role types.
- `httpFetchTool.ts` — thin adapter over the existing `WebFetcher`.
- `browserTool.ts` — Playwright `BrowserTool` (guarded require, all §4 controls). Its
  request-decision logic is split into a pure `classifyResourceType()` for testing.
- `thinContent.ts` — pure empty-shell heuristic (§3).
- `fetchRegistry.ts` — `FetchToolRegistry.acquire()` + pure `shouldEscalate()`/`resolveMode()`.

**Changed (additive, behavior-neutral when browser disabled):**
- `config/webConfig.ts` — browser config block (all `DIGIM_WEB_BROWSER_*`).
- `types.ts` — `FetchResult.tool?`, `FetchResult.escalated?`; diagnostics
  `browserUsed`/`escalated`; `GatherOptions.browserMode?`.
- `pipeline/gatheringPipeline.ts` — swap the raw fetcher call for `registry.acquire()`,
  count browser usage into diagnostics.
- `webResearchOrchestrator.ts` — build the registry; `shutdown()` closes the browser;
  `getStatus()` reports `browserEnabled`/`browserAvailable`/`browserMode`; thread
  per-job `browserMode`.
- `modules/digim/index.ts` + `api/routes/index.ts` — accept per-request `browser_mode`;
  status surfaces browser state.
- `package.json` — `playwright` in `optionalDependencies`; `test:tools` script.

**New docs/ops:**
- `docs/digim/PHASE2_2.md` (verification record), `ops/PLAYWRIGHT_RUNBOOK.md`
  (install on prod, sandbox trade-off, troubleshooting).

**Tests — `test/digim/toolTest.ts` (hermetic, no Chromium):**
- `assessThinContent`: SPA shell → thin; real article → not thin; empty → thin.
- `shouldEscalate`: ok+thin→true; ok+rich→false; 403→true; 404→false.
- `resolveMode`: disabled→off always; per-request 'always' honored when enabled.
- `classifyResourceType`: blocked types blocked, document/script/xhr allowed.
- `FetchToolRegistry.acquire` with **mock** http/browser tools: off→never browser;
  on-miss+thin→browser; on-miss+rich→no browser; always→browser-first; unavailable→http-only.

BrowserTool's live Chromium drive is verified on your box (the sandbox here can't run
Chromium reliably), same honest split we used for the DB migration.

---

## 6. Decisions I'm defaulting (veto any before I build)

1. **Ships default-OFF** (`DIGIM_WEB_BROWSER_ENABLED=false`) — matches every other capability.
2. **Default mode `on-miss`** once enabled — browser only when HTTP returns a shell/403.
3. **Chromium sandbox stays ON**; `--no-sandbox` documented opt-in only.
4. **Fresh context per fetch** (isolation) over a context pool (marginally slower, safer).
5. **`playwright` as optionalDependency** — install is a deliberate prod ops step, documented.

If those five sit right with you, I build the whole increment, verify tsc + the
hermetic tool tests, commit, and hand you the Playwright-install + live-verify commands.
