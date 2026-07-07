// File: src/modules/digim/web/gatherers/webFetcher.ts
// ============================================================================
// DIGIM WEB-RESEARCH — ROBUST, SAFE WEB FETCHER
// ============================================================================
//
// This is the ONLY place DIGIM reaches out to an arbitrary URL. Every fetch:
//   1. Passes through the SSRF guard (assertUrlSafe) BEFORE connecting.
//   2. Follows redirects MANUALLY, re-validating each hop through the guard
//      (a plain fetch would auto-follow a 302 into an internal host).
//   3. Enforces a hard timeout via AbortController.
//   4. Streams the body with a byte cap so a malicious/huge page can't OOM us.
//   5. Gates on Content-Type (only textual pages are kept).
//   6. Honours a per-host politeness delay (never hammer one origin).
//   7. Retries transient failures with exponential backoff.
//
// It NEVER throws for an expected failure (blocked URL, timeout, 404, oversize):
// those come back as a FetchResult with ok=false and a reason, so the pipeline
// can keep going. It only throws for genuine programmer error.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { assertUrlSafe, UrlSafetyError } from '../security/urlGuard';
import { FetchResult } from '../types';

// Per-host last-fetch timestamps for politeness pacing (process-local).
const lastFetchByHost = new Map<string, number>();

export class WebFetcher {
  constructor(private cfg: DigimWebConfig = getDigimWebConfig()) {}

  /**
   * Fetch a single URL safely. Resolves to a FetchResult; only ok===true
   * results carry a usable body.
   */
  async fetchUrl(rawUrl: string): Promise<FetchResult> {
    const base: FetchResult = {
      requestedUrl: rawUrl,
      finalUrl: rawUrl,
      status: 0,
      contentType: '',
      body: '',
      byteLength: 0,
      fetchedAt: new Date().toISOString(),
      ok: false,
      redirects: 0,
    };

    let attempt = 0;
    let lastError = '';
    while (attempt <= this.cfg.fetchRetries) {
      attempt++;
      try {
        return await this.fetchOnce(rawUrl, base);
      } catch (err) {
        // A safety rejection is terminal — never retry a blocked URL.
        if (err instanceof UrlSafetyError) {
          return { ...base, ok: false, error: `blocked: ${err.reason}: ${err.message}` };
        }
        lastError = (err as Error).message || String(err);
        // Retry only transient network errors with backoff.
        if (attempt <= this.cfg.fetchRetries) {
          const backoff = Math.min(2 ** (attempt - 1) * 500, 8000);
          await sleep(backoff);
          continue;
        }
      }
    }
    return { ...base, ok: false, error: lastError || 'fetch failed' };
  }

  /** One fetch attempt including manual redirect following. */
  private async fetchOnce(rawUrl: string, base: FetchResult): Promise<FetchResult> {
    let currentUrl = rawUrl;
    let redirects = 0;

    while (true) {
      // (1) SSRF guard on EVERY hop.
      const safeUrl = await assertUrlSafe(currentUrl, this.cfg);

      // (6) Per-host politeness delay.
      await this.respectHostDelay(safeUrl.host);

      // (3) Timeout via AbortController (mirrors the LLM manager's pattern).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.fetchTimeoutMs);

      let res: Response;
      try {
        res = await fetch(safeUrl.toString(), {
          method: 'GET',
          redirect: 'manual', // we follow manually so we can re-validate each hop
          signal: controller.signal,
          headers: {
            'User-Agent': this.cfg.userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      // (2) Manual redirect handling.
      const status = res.status;
      if (status >= 300 && status < 400) {
        const location = res.headers.get('location');
        // Drain the redirect body so the socket can be reused.
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        if (!location) {
          return { ...base, finalUrl: currentUrl, status, ok: false, error: 'redirect without location', redirects };
        }
        if (redirects >= this.cfg.maxRedirects) {
          return { ...base, finalUrl: currentUrl, status, ok: false, error: 'too many redirects', redirects };
        }
        redirects++;
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(location, safeUrl).toString();
        continue;
      }

      // Non-2xx, non-3xx → failure.
      if (status < 200 || status >= 300) {
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        return { ...base, finalUrl: safeUrl.toString(), status, ok: false, error: `HTTP ${status}`, redirects };
      }

      // (5) Content-Type gate — keep only textual content.
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!isTextualContentType(contentType)) {
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        return {
          ...base,
          finalUrl: safeUrl.toString(),
          status,
          contentType,
          ok: false,
          error: `unsupported content-type: ${contentType || 'unknown'}`,
          redirects,
        };
      }

      // Early reject on an oversized declared Content-Length.
      const declaredLen = parseInt(res.headers.get('content-length') || '', 10);
      if (Number.isFinite(declaredLen) && declaredLen > this.cfg.maxContentBytes) {
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        return {
          ...base,
          finalUrl: safeUrl.toString(),
          status,
          contentType,
          ok: false,
          error: `content too large: ${declaredLen} bytes`,
          redirects,
        };
      }

      // (4) Stream the body with a hard byte cap.
      const { text, bytes, truncated } = await readCapped(res, this.cfg.maxContentBytes);
      if (truncated) {
        return {
          ...base,
          finalUrl: safeUrl.toString(),
          status,
          contentType,
          ok: false,
          error: `content exceeded ${this.cfg.maxContentBytes} bytes`,
          byteLength: bytes,
          redirects,
        };
      }

      return {
        requestedUrl: rawUrl,
        finalUrl: safeUrl.toString(),
        status,
        contentType,
        body: text,
        byteLength: bytes,
        fetchedAt: new Date().toISOString(),
        ok: true,
        redirects,
      };
    }
  }

  private async respectHostDelay(host: string): Promise<void> {
    if (this.cfg.perHostDelayMs <= 0) return;
    const now = Date.now();
    const last = lastFetchByHost.get(host) || 0;
    const wait = this.cfg.perHostDelayMs - (now - last);
    // Reserve the slot immediately to serialize concurrent hits to the host.
    lastFetchByHost.set(host, Math.max(now, last + this.cfg.perHostDelayMs));
    if (wait > 0) await sleep(wait);
  }
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

function isTextualContentType(ct: string): boolean {
  if (!ct) return false;
  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('text/plain') ||
    ct.includes('application/xml') ||
    ct.includes('text/xml') ||
    ct.includes('application/rss') ||
    ct.includes('application/atom')
  );
}

/**
 * Read a Response body into a string, aborting once `maxBytes` is exceeded.
 * Uses the web-stream reader (same API the LLM manager uses for SSE) so we
 * never buffer more than the cap.
 */
async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) {
    // No streamable body — fall back to text() but still cap length.
    const t = await res.text();
    const bytes = Buffer.byteLength(t, 'utf8');
    if (bytes > maxBytes) return { text: '', bytes, truncated: true };
    return { text: t, bytes, truncated: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return { text: '', bytes, truncated: true };
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { text, bytes, truncated: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
