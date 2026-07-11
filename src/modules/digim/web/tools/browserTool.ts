// File: src/modules/digim/web/tools/browserTool.ts
// ============================================================================
// DIGIM WEB-RESEARCH — HEADLESS BROWSER TOOL (Phase 2.2)
// ============================================================================
//
// The EXPENSIVE acquisition tool: a headless Chromium that runs JavaScript, so
// DINA can read the JS-rendered web that a plain fetch() returns as an empty
// shell. It is NEVER the default path — the registry escalates to it only on a
// detected shell/403 (see fetchRegistry + thinContent).
//
// ISOLATION MODEL (defense in depth)
// ----------------------------------
// The heavy, risky Chromium does NOT run in the DINA process. It runs in a
// separate, hardened, network-SEGREGATED container (Playwright server or
// browserless); this tool is a thin CLIENT that connects over a WebSocket. So:
//   • The DINA host never installs/executes the browser binary.
//   • The container's network policy (deny RFC1918/loopback/link-local/metadata,
//     allow public) is the OUTER guarantee that a compromised page "can't leave".
//   • This code adds the INNER, app-layer guarantee below.
//
// APP-LAYER SECURITY (present from line one — a browser runs UNTRUSTED JS)
// -----------------------------------------------------------------------
//   1. Every request the browser attempts (document, xhr, fetch, script, iframe)
//      is intercepted and run through the SAME checkUrlSafety() SSRF policy as
//      WebFetcher. Unsafe → aborted. Closes the sub-request SSRF hole.
//   2. Sub-resources we don't need (image/media/font/stylesheet) are aborted by
//      type — less bandwidth, less CPU, smaller attack surface.
//   3. Per-page request cap — a page that spins up thousands of requests is cut.
//   4. Post-navigation re-check of the final URL (JS may have redirected).
//   5. No downloads; byte cap on the rendered HTML; hard navigation timeout.
//   6. Fresh context per fetch (cookie/storage isolation), always closed.
//
// GRACEFUL DEGRADATION
// --------------------
//   • `playwright` is an OPTIONAL dependency, loaded via a guarded require. Not
//     installed → isAvailable()=false, the registry silently stays HTTP-only.
//   • isAvailable() is DYNAMIC: a connection failure marks the tool down for a
//     cooldown, so a wedged/restarting browser service degrades to HTTP-only
//     instead of failing research. fetch() NEVER throws — errors → ok:false.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { checkUrlSafety } from '../security/urlGuard';
import { FetchTool, failedFetch } from './fetchTool';
import { FetchResult } from '../types';

// ----------------------------------------------------------------------------
// Guarded, one-time load of the optional Playwright CLIENT.
//
// We connect to a REMOTE browser (in a container) — we never launch one locally
// — so the right dependency is `playwright-core`: the same chromium.connect()
// API with NO browser-download postinstall. We try it first, then fall back to
// the full `playwright` package if that's what happens to be installed. Either
// provides chromium.connect().
// ----------------------------------------------------------------------------
let _pw: { mod: any | null; error: string | null } | undefined;
function loadPlaywright(): { mod: any | null; error: string | null } {
  if (_pw) return _pw;
  const errors: string[] = [];
  for (const pkg of ['playwright-core', 'playwright']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(pkg);
      if (mod && mod.chromium && typeof mod.chromium.connect === 'function') {
        _pw = { mod, error: null };
        return _pw;
      }
      errors.push(`${pkg}: no chromium.connect`);
    } catch (err) {
      errors.push(`${pkg}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  _pw = { mod: null, error: errors.join(' | ') };
  return _pw;
}

/**
 * PURE, testable request-filter decision: should a sub-request of the given
 * resource type be allowed or blocked? Extracted so the block policy can be
 * unit-tested without a browser.
 */
export function classifyResourceType(resourceType: string, blocked: string[]): 'allow' | 'block' {
  const t = (resourceType || '').toLowerCase();
  return blocked.map((b) => b.toLowerCase()).includes(t) ? 'block' : 'allow';
}

export class BrowserTool implements FetchTool {
  readonly name = 'browser';
  readonly cost = 'expensive' as const;

  private cfg: DigimWebConfig;
  private libPresent: boolean;
  private libError: string | null;
  private browser: any = null;
  private connecting: Promise<any> | null = null;
  /** Epoch ms until which the tool is considered down (post connection failure). */
  private downUntil = 0;

  constructor(cfg: DigimWebConfig = getDigimWebConfig()) {
    this.cfg = cfg;
    const l = loadPlaywright();
    this.libPresent = !!l.mod;
    this.libError = l.error;
    if (this.cfg.browserEnabled && !this.libPresent) {
      console.warn(`⚠️ [browserTool] DIGIM_WEB_BROWSER_ENABLED=true but 'playwright' is not installed (${this.libError}). Staying HTTP-only. See ops/PLAYWRIGHT_RUNBOOK.md.`);
    }
    if (this.cfg.browserEnabled && this.libPresent && !this.cfg.browserWsEndpoint) {
      console.warn('⚠️ [browserTool] browser enabled but DIGIM_WEB_BROWSER_WS_ENDPOINT is empty — set it to the containerized browser (e.g. ws://localhost:3000). Staying HTTP-only.');
    }
  }

  /** DYNAMIC availability: config-feasible, library present, and not in cooldown. */
  isAvailable(): boolean {
    if (!this.cfg.browserEnabled) return false;
    if (!this.libPresent) return false;
    if (!this.cfg.browserWsEndpoint) return false;
    if (Date.now() < this.downUntil) return false;
    return true;
  }

  /** Why the tool is unavailable, for diagnostics. */
  unavailableReason(): string {
    if (!this.cfg.browserEnabled) return 'browser disabled';
    if (!this.libPresent) return `playwright not installed (${this.libError})`;
    if (!this.cfg.browserWsEndpoint) return 'no ws endpoint configured';
    if (Date.now() < this.downUntil) return 'browser service marked down (cooldown)';
    return 'available';
  }

  /**
   * Build a failed FetchResult AND log why — a browser fetch failing silently
   * (then falling back to HTTP) is an observability hole. Failures should be rare
   * and visible.
   */
  private fail(url: string, reason: string): FetchResult {
    console.warn(`⚠️ [browserTool] fetch failed for ${url}: ${reason}`);
    return failedFetch(url, reason, this.name);
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.isAvailable()) {
      return failedFetch(url, `browser unavailable: ${this.unavailableReason()}`, this.name);
    }

    let context: any = null;
    try {
      const browser = await this.ensureBrowser();
      context = await browser.newContext({
        acceptDownloads: false,
        userAgent: this.cfg.userAgent,
        viewport: { width: 1280, height: 800 },
        // Do not persist anything: fresh, isolated jar per fetch.
        ignoreHTTPSErrors: false,
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.cfg.browserNavTimeoutMs);

      await this.installGuardedRouting(page);

      const resp = await page.goto(url, {
        waitUntil: this.cfg.browserWaitUntil,
        timeout: this.cfg.browserNavTimeoutMs,
      });

      // (4) Post-navigation SSRF re-check — JS may have redirected the page.
      const finalUrl = page.url();
      const postNav = await checkUrlSafety(finalUrl, this.cfg);
      if (!postNav.safe) {
        return this.fail(url, `blocked post-navigation: ${postNav.reason || 'unsafe final URL'}`);
      }

      // (5) Rendered HTML with a byte cap (matches the HTTP path's behavior).
      let html = await page.content();
      const bytes = Buffer.byteLength(html, 'utf8');
      if (bytes > this.cfg.maxContentBytes) {
        return this.fail(url, `content exceeded ${this.cfg.maxContentBytes} bytes`);
      }

      const status = resp && typeof resp.status === 'function' ? resp.status() : 200;
      if (status >= 400) {
        return this.fail(url, `HTTP ${status}`);
      }

      return {
        requestedUrl: url,
        finalUrl,
        status,
        contentType: 'text/html',
        body: html,
        byteLength: bytes,
        fetchedAt: new Date().toISOString(),
        ok: true,
        redirects: 0,
        tool: this.name,
      };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      // Connection-level failures trip the local cooldown (breaker) so we stop
      // hammering a wedged/restarting browser service.
      if (/connect|disconnect|closed|websocket|econnrefused|target closed|browser has been closed/i.test(msg)) {
        this.markDown();
      }
      return this.fail(url, `browser fetch failed: ${msg}`);
    } finally {
      if (context) {
        try { await context.close(); } catch { /* best-effort */ }
      }
    }
  }

  async shutdown(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) {
      try { await b.close(); } catch { /* best-effort */ }
    }
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  /** Install per-request interception implementing controls (1)–(3). */
  private async installGuardedRouting(page: any): Promise<void> {
    let requestCount = 0;
    await page.route('**/*', async (route: any) => {
      try {
        const req = route.request();

        // (3) Per-page request cap.
        requestCount++;
        if (requestCount > this.cfg.browserMaxRequestsPerPage) {
          return await route.abort();
        }

        // (2) Sub-resource type block (cheap, synchronous — do first).
        if (classifyResourceType(req.resourceType(), this.cfg.browserBlockedResourceTypes) === 'block') {
          return await route.abort();
        }

        // (1) SSRF policy on EVERY request URL (same guard as WebFetcher).
        const safety = await checkUrlSafety(req.url(), this.cfg);
        if (!safety.safe) {
          return await route.abort();
        }

        return await route.continue();
      } catch {
        // Any handler error → fail closed (abort the request), never leak.
        try { return await route.abort(); } catch { /* route already handled */ }
      }
    });
  }

  /** Lazily connect to the containerized browser; reuse a live connection. */
  private async ensureBrowser(): Promise<any> {
    if (this.browser && this.isConnected(this.browser)) return this.browser;
    if (this.connecting) return this.connecting;

    const l = loadPlaywright();
    if (!l.mod) throw new Error(`playwright unavailable: ${l.error}`);

    this.connecting = (async () => {
      const browser = await l.mod.chromium.connect(this.cfg.browserWsEndpoint, {
        timeout: this.cfg.browserNavTimeoutMs,
      });
      // If the service drops, forget the handle so the next fetch reconnects.
      if (typeof browser.on === 'function') {
        browser.on('disconnected', () => {
          this.browser = null;
        });
      }
      this.browser = browser;
      return browser;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private isConnected(browser: any): boolean {
    try {
      return typeof browser.isConnected === 'function' ? browser.isConnected() : true;
    } catch {
      return false;
    }
  }

  private markDown(ms: number = this.cfg.browserBreakerCooldownMs): void {
    this.downUntil = Date.now() + ms;
    this.browser = null;
  }
}
