// File: src/modules/digim/web/tools/fetchRegistry.ts
// ============================================================================
// DIGIM WEB-RESEARCH — FETCH TOOL REGISTRY (Phase 2.2)
// ============================================================================
//
// Owns tool SELECTION so the pipeline stays clean. Implements the
// "fetch-first, render-on-miss" policy across the HTTP and browser tools:
//
//   'off'     — HTTP only (byte-for-byte today's behavior).
//   'on-miss' — HTTP first; escalate to the browser ONLY when HTTP returns a
//               JS shell (thinContent) or a 403/429 bot wall.
//   'always'  — browser first (debugging / special jobs); HTTP fallback.
//
// HARDENING
// ---------
//   • Browser CONCURRENCY SEMAPHORE — separate from (and lower than) HTTP
//     concurrency, so a burst of escalations can't spawn N heavy pages at once
//     and starve Ollama / the box.
//   • CIRCUIT BREAKER — after K consecutive browser failures the registry stops
//     escalating for a cooldown and serves HTTP-only, so a wedged browser
//     service never drags research down. (Complements BrowserTool's own
//     connection cooldown: this one covers "reachable but every page fails".)
//
// The selection helpers (resolveMode, shouldEscalate) are PURE and exported so
// the policy is unit-tested exhaustively without any real tool.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { FetchTool } from './fetchTool';
import { assessThinContent } from './thinContent';
import { FetchResult, BrowserMode } from '../types';

// ----------------------------------------------------------------------------
// PURE POLICY
// ----------------------------------------------------------------------------

/**
 * Resolve the effective browser mode. The browser can NEVER be forced on when
 * it is globally disabled or unavailable — a per-job override only narrows or
 * selects among modes that are already permitted.
 */
export function resolveMode(
  requested: BrowserMode | undefined,
  cfg: DigimWebConfig,
  browserAvailable: boolean
): BrowserMode {
  if (!cfg.browserEnabled || !browserAvailable) return 'off';
  const mode = requested || cfg.browserMode;
  return mode === 'off' || mode === 'on-miss' || mode === 'always' ? mode : 'on-miss';
}

/**
 * Given an HTTP result, decide whether to escalate to the browser (on-miss).
 * PURE — the escalation trigger, tested exhaustively without Chromium.
 */
export function shouldEscalate(http: FetchResult, cfg: DigimWebConfig): boolean {
  if (http.ok) {
    // Rendered-content miss: an unrendered SPA shell.
    return assessThinContent(http.body, cfg.browserThinTextChars).thin;
  }
  // Fetch failed: a browser may pass a bot/JS wall on 403/429.
  if (cfg.browserOn403 && (http.status === 403 || http.status === 429)) return true;
  return false;
}

// ----------------------------------------------------------------------------
// CONCURRENCY SEMAPHORE
// ----------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ----------------------------------------------------------------------------
// CIRCUIT BREAKER
// ----------------------------------------------------------------------------

class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;
  constructor(private readonly threshold: number, private readonly cooldownMs: number) {}

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      this.consecutiveFailures = 0; // reset; re-probe after cooldown
    }
  }
}

// ----------------------------------------------------------------------------
// REGISTRY
// ----------------------------------------------------------------------------

export interface AcquireOptions {
  mode?: BrowserMode;
}

export class FetchToolRegistry {
  private readonly semaphore: Semaphore;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly http: FetchTool,
    private readonly browser: FetchTool,
    private readonly cfg: DigimWebConfig = getDigimWebConfig()
  ) {
    this.semaphore = new Semaphore(cfg.browserConcurrency);
    this.breaker = new CircuitBreaker(cfg.browserBreakerThreshold, cfg.browserBreakerCooldownMs);
  }

  /** True when the browser tool is currently usable for escalation. */
  get browserAvailable(): boolean {
    return this.browser.isAvailable();
  }

  /**
   * Acquire content for a URL, applying the fetch-first/render-on-miss policy.
   * ALWAYS resolves to a FetchResult — never throws.
   */
  async acquire(url: string, opts: AcquireOptions = {}): Promise<FetchResult> {
    const mode = resolveMode(opts.mode, this.cfg, this.browser.isAvailable());

    // 'always' — browser first, HTTP fallback.
    if (mode === 'always') {
      if (!this.breaker.isOpen()) {
        const b = await this.runBrowser(url);
        if (b && b.ok) return { ...b, escalated: false };
      }
      return this.http.fetch(url);
    }

    // 'off' and 'on-miss' — cheap HTTP first.
    const httpResult = await this.http.fetch(url);
    if (mode === 'off') return httpResult;

    // 'on-miss' — escalate only when warranted and the browser is healthy.
    if (this.breaker.isOpen()) return httpResult;
    if (shouldEscalate(httpResult, this.cfg) && this.browser.isAvailable()) {
      const b = await this.runBrowser(url);
      if (b && b.ok) return { ...b, escalated: true };
    }
    return httpResult;
  }

  /** Release the browser tool's resources. */
  async shutdown(): Promise<void> {
    if (this.browser.shutdown) {
      try { await this.browser.shutdown(); } catch { /* best-effort */ }
    }
    if (this.http.shutdown) {
      try { await this.http.shutdown(); } catch { /* best-effort */ }
    }
  }

  /** Run one browser fetch under the semaphore, recording breaker state. */
  private async runBrowser(url: string): Promise<FetchResult | null> {
    try {
      const result = await this.semaphore.run(() => this.browser.fetch(url));
      if (result.ok) this.breaker.recordSuccess();
      else this.breaker.recordFailure();
      return result;
    } catch {
      // FetchTool.fetch is contracted not to throw; guard anyway.
      this.breaker.recordFailure();
      return null;
    }
  }
}
