// File: src/modules/digim/web/config/webConfig.ts
// ============================================================================
// DIGIM WEB-RESEARCH RUNTIME CONFIGURATION (single source of truth)
// ============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// DIGIM's web-gathering subsystem touches the outside world: it queries a
// search engine, fetches arbitrary URLs, extracts content, and drives an LLM
// to synthesise insights. Every knob that governs *how far* it reaches, *how
// hard* it hits a host, and *what it is allowed to talk to* lives here — driven
// by environment variables with conservative, safe-by-default values. This is
// the same pattern as `src/modules/llm/llmConfig.ts`: a pure, side-effect-free,
// frozen singleton so it can be imported from anywhere.
//
// ENTERPRISE / SAFETY NOTES
// -------------------------
// * The whole subsystem is DISABLED by default (`enabled=false`). Nothing
//   reaches the network until an operator explicitly sets DIGIM_WEB_ENABLED=true.
//   This guarantees "no disruption" when the code is first deployed.
// * Defaults are polite (crawl delay, bounded concurrency), bounded (size &
//   timeout caps), and closed (SSRF guard on, private ranges blocked).
// * The search provider is pluggable and defaults to `none` (a no-op provider)
//   so an unconfigured deploy degrades gracefully instead of throwing.
// * Nothing here performs I/O; importing it is free of side effects.
// ============================================================================

export type SearchProviderName = 'none' | 'searxng' | 'brave' | 'tavily';

export interface DigimWebConfig {
  // ---- Master switch ----
  /** When false (default) the whole web subsystem is inert — no network I/O. */
  enabled: boolean;

  // ---- Search provider selection ----
  /** Which search backend to use. 'none' = graceful no-op (returns no results). */
  searchProvider: SearchProviderName;
  /** Base URL of a self-hosted SearXNG instance (searchProvider='searxng'). */
  searxngBaseUrl: string;
  /** API key for Brave Search API (searchProvider='brave'). */
  braveApiKey: string;
  /** API key for Tavily (searchProvider='tavily'). */
  tavilyApiKey: string;
  /** Max results requested from the search provider per query. */
  maxSearchResults: number;
  /**
   * Search language/region for discovery. 'all' = worldwide/multilingual (best
   * for global coverage); or an IETF tag like 'en-US', 'fa-IR', 'ar'. Passed to
   * SearXNG's `language` param.
   */
  searchLanguage: string;

  // ---- Fetch / crawl governance ----
  /** How many URLs may be fetched concurrently within one gather run. */
  fetchConcurrency: number;
  /** Politeness delay (ms) enforced between two fetches to the SAME host. */
  perHostDelayMs: number;
  /** Per-request fetch timeout (ms). */
  fetchTimeoutMs: number;
  /** Hard cap on a single response body (bytes). Oversized bodies are rejected. */
  maxContentBytes: number;
  /** Max HTTP redirects followed (each hop re-validated by the SSRF guard). */
  maxRedirects: number;
  /** Retry attempts for a transient fetch failure (exponential backoff). */
  fetchRetries: number;
  /** User-Agent sent with every outbound request. */
  userAgent: string;
  /** How many of the gathered/ranked results to actually fetch+extract. */
  maxDocumentsPerGather: number;
  /** Minimum extracted word count for a document to be considered usable. */
  minWordCount: number;

  // ---- SSRF / URL safety ----
  /** Master SSRF guard toggle. Keep true in production. */
  ssrfGuardEnabled: boolean;
  /** When true, block requests that resolve to private/loopback/link-local IPs. */
  blockPrivateRanges: boolean;
  /** Optional host allowlist. When non-empty, ONLY these hosts may be fetched. */
  allowedHosts: string[];
  /** Host denylist — always blocked (applied even when allowlist is empty). */
  deniedHosts: string[];
  /** Outbound ports permitted (in addition to the scheme default 80/443). */
  allowedPorts: number[];

  // ---- Insight synthesis ----
  /** LLM model preference for synthesis (defaults to the analysis-tier model). */
  synthesisModel: string;
  /** Max tokens for a synthesis generation. */
  synthesisMaxTokens: number;
  /** Hard timeout (ms) for a single synthesis LLM call. */
  synthesisTimeoutMs: number;
  /** How many gathered documents feed a single synthesis prompt. */
  synthesisMaxDocuments: number;
  /** Per-document character budget injected into the synthesis prompt. */
  synthesisPerDocChars: number;

  // ---- Semantic memory (Phase 1) ----
  /** Embedding model for semantic memory (defaults to the LLM embed model). */
  embedModel: string;
  /** Max characters of a document fed to the embedder (token-limit guard). */
  embedMaxChars: number;
  /** Default number of memories retrieved per recall/research. */
  memoryTopK: number;
  /** Minimum cosine similarity for a memory to be considered relevant (0-1). */
  memoryMinScore: number;
  /**
   * STRICTER minimum score for prior memory that is injected into synthesis and
   * cited as a source. Higher than memoryMinScore so weakly-related recall
   * (e.g. an old unrelated article) is never cited for a fresh query.
   */
  memorySynthesisMinScore: number;
  /** Max prior-memory docs injected into a synthesis prompt. */
  memorySynthesisTopK: number;
  /** When true, gathered documents are embedded into semantic memory. */
  memoryEnabled: boolean;

  // ---- Caching / retention ----
  /** TTL (hours) for a cached intelligence result keyed by query hash. */
  intelligenceCacheTtlHours: number;
  /** Days to retain gathered content before it is eligible for cleanup. */
  contentRetentionDays: number;
  /** When true, a periodic sweep prunes aged content + expired intelligence. */
  retentionSweepEnabled: boolean;
  /** How often (hours) the retention sweep runs. */
  retentionSweepIntervalHours: number;
  /** Max content rows pruned per sweep pass (bounds each run). */
  retentionSweepBatch: number;

  // ---- Headless browser (Phase 2.2 — BrowserTool) ----
  /**
   * Master switch for headless-browser acquisition. When false (default) the
   * BrowserTool is never constructed/loaded and acquisition is byte-for-byte
   * the existing HTTP path — zero new dependency, zero new risk.
   */
  browserEnabled: boolean;
  /**
   * Escalation policy once enabled:
   *   'off'     — HTTP only (browser present but unused).
   *   'on-miss' — HTTP first; escalate to the browser only on a JS shell / 403.
   *   'always'  — browser first (debugging / special jobs), HTTP fallback.
   */
  browserMode: 'off' | 'on-miss' | 'always';
  /**
   * WebSocket endpoint of a containerized browser service (Playwright server or
   * browserless), e.g. ws://localhost:3000. The heavy, risky Chromium lives in
   * a hardened, network-segregated container; DINA connects as a thin client.
   * Empty → BrowserTool is unavailable (graceful HTTP-only).
   */
  browserWsEndpoint: string;
  /** Navigation timeout (ms) for a single page load. */
  browserNavTimeoutMs: number;
  /** Playwright waitUntil condition. 'domcontentloaded' is safest (won't hang). */
  browserWaitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** Visible-text floor below which an HTTP page is considered a thin SPA shell. */
  browserThinTextChars: number;
  /** Max sub-requests a single page may make before further ones are aborted. */
  browserMaxRequestsPerPage: number;
  /** Resource types aborted at the browser layer (bandwidth + attack surface). */
  browserBlockedResourceTypes: string[];
  /** Max concurrent browser pages — SEPARATE from (and lower than) HTTP concurrency. */
  browserConcurrency: number;
  /** Escalate to the browser when HTTP returns 403/429 (bot/JS wall). */
  browserOn403: boolean;
  /**
   * Circuit breaker: after this many consecutive browser failures, stop
   * escalating (fall back to HTTP-only) until the cooldown elapses. Protects the
   * box from a wedged/slow browser service.
   */
  browserBreakerThreshold: number;
  /** Circuit-breaker cooldown (ms) before probing the browser again. */
  browserBreakerCooldownMs: number;
}

// ----------------------------------------------------------------------------
// ENV PARSING HELPERS (defensive — never throw on bad input)
// ----------------------------------------------------------------------------

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim().length > 0 ? v.trim() : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a comma-separated env var into a de-duplicated, trimmed, lower-cased list. */
function envCsv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return dedupe(fallback);
  const parts = v.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  return parts.length > 0 ? dedupe(parts) : dedupe(fallback);
}

/** Parse a comma-separated env var of integers (ports). Invalid entries dropped. */
function envIntCsv(name: string, fallback: number[]): number[] {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return Array.from(new Set(fallback));
  const parts = v
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535);
  return parts.length > 0 ? Array.from(new Set(parts)) : Array.from(new Set(fallback));
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)));
}

function parseProvider(name: string, fallback: SearchProviderName): SearchProviderName {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === 'none' || v === 'searxng' || v === 'brave' || v === 'tavily') return v;
  return fallback;
}

function parseBrowserMode(name: string, fallback: 'off' | 'on-miss' | 'always'): 'off' | 'on-miss' | 'always' {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === 'off' || v === 'on-miss' || v === 'always') return v;
  return fallback;
}

function parseWaitUntil(
  name: string,
  fallback: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
): 'load' | 'domcontentloaded' | 'networkidle' | 'commit' {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === 'load' || v === 'domcontentloaded' || v === 'networkidle' || v === 'commit') return v;
  return fallback;
}

// ----------------------------------------------------------------------------
// CONFIG SINGLETON (frozen) — built once at first access.
// ----------------------------------------------------------------------------

function buildConfig(): DigimWebConfig {
  // Reuse the LLM analysis model as the synthesis default so the two configs
  // stay coherent, but allow an explicit override.
  const synthesisModel = envStr('DIGIM_WEB_SYNTHESIS_MODEL', envStr('DINA_ANALYSIS_MODEL', 'mistral:7b'));

  return Object.freeze({
    enabled: envBool('DIGIM_WEB_ENABLED', false),

    searchProvider: parseProvider('DIGIM_WEB_SEARCH_PROVIDER', 'none'),
    searxngBaseUrl: envStr('DIGIM_WEB_SEARXNG_URL', 'http://localhost:8080'),
    braveApiKey: envStr('DIGIM_WEB_BRAVE_API_KEY', ''),
    tavilyApiKey: envStr('DIGIM_WEB_TAVILY_API_KEY', ''),
    maxSearchResults: clampInt(envInt('DIGIM_WEB_MAX_SEARCH_RESULTS', 10), 1, 50),
    searchLanguage: envStr('DIGIM_WEB_SEARCH_LANGUAGE', 'all'),

    fetchConcurrency: clampInt(envInt('DIGIM_WEB_FETCH_CONCURRENCY', 4), 1, 16),
    perHostDelayMs: clampInt(envInt('DIGIM_WEB_PER_HOST_DELAY_MS', 1000), 0, 60000),
    fetchTimeoutMs: clampInt(envInt('DIGIM_WEB_FETCH_TIMEOUT_MS', 15000), 1000, 120000),
    maxContentBytes: clampInt(envInt('DIGIM_WEB_MAX_CONTENT_BYTES', 5 * 1024 * 1024), 16 * 1024, 64 * 1024 * 1024),
    maxRedirects: clampInt(envInt('DIGIM_WEB_MAX_REDIRECTS', 3), 0, 10),
    fetchRetries: clampInt(envInt('DIGIM_WEB_FETCH_RETRIES', 2), 0, 5),
    userAgent: envStr('DIGIM_WEB_USER_AGENT', 'DINA-DIGIM/1.0 (+https://dina.local; research-bot)'),
    maxDocumentsPerGather: clampInt(envInt('DIGIM_WEB_MAX_DOCUMENTS', 8), 1, 50),
    minWordCount: clampInt(envInt('DIGIM_WEB_MIN_WORD_COUNT', 60), 0, 5000),

    ssrfGuardEnabled: envBool('DIGIM_WEB_SSRF_GUARD', true),
    blockPrivateRanges: envBool('DIGIM_WEB_BLOCK_PRIVATE_RANGES', true),
    allowedHosts: envCsv('DIGIM_WEB_ALLOWED_HOSTS', []),
    deniedHosts: envCsv('DIGIM_WEB_DENIED_HOSTS', []),
    allowedPorts: envIntCsv('DIGIM_WEB_ALLOWED_PORTS', [80, 443]),

    synthesisModel,
    synthesisMaxTokens: clampInt(envInt('DIGIM_WEB_SYNTHESIS_MAX_TOKENS', 1200), 128, 8192),
    synthesisTimeoutMs: clampInt(envInt('DIGIM_WEB_SYNTHESIS_TIMEOUT_MS', 240000), 5000, 600000),
    synthesisMaxDocuments: clampInt(envInt('DIGIM_WEB_SYNTHESIS_MAX_DOCUMENTS', 6), 1, 20),
    synthesisPerDocChars: clampInt(envInt('DIGIM_WEB_SYNTHESIS_PER_DOC_CHARS', 2000), 200, 12000),

    embedModel: envStr('DIGIM_WEB_EMBED_MODEL', envStr('DINA_EMBED_MODEL', 'mxbai-embed-large')),
    embedMaxChars: clampInt(envInt('DIGIM_WEB_EMBED_MAX_CHARS', 6000), 200, 20000),
    memoryTopK: clampInt(envInt('DIGIM_WEB_MEMORY_TOPK', 8), 1, 50),
    memoryMinScore: clamp01f(envFloat('DIGIM_WEB_MEMORY_MIN_SCORE', 0.2)),
    memorySynthesisMinScore: clamp01f(envFloat('DIGIM_WEB_MEMORY_SYNTHESIS_MIN_SCORE', 0.45)),
    memorySynthesisTopK: clampInt(envInt('DIGIM_WEB_MEMORY_SYNTHESIS_TOPK', 4), 0, 20),
    memoryEnabled: envBool('DIGIM_WEB_MEMORY_ENABLED', true),

    intelligenceCacheTtlHours: clampInt(envInt('DIGIM_WEB_INTEL_CACHE_TTL_HOURS', 6), 0, 720),
    contentRetentionDays: clampInt(envInt('DIGIM_WEB_CONTENT_RETENTION_DAYS', 30), 1, 3650),
    retentionSweepEnabled: envBool('DIGIM_WEB_RETENTION_SWEEP', true),
    retentionSweepIntervalHours: clampInt(envInt('DIGIM_WEB_RETENTION_SWEEP_HOURS', 24), 1, 720),
    retentionSweepBatch: clampInt(envInt('DIGIM_WEB_RETENTION_BATCH', 500), 1, 5000),

    browserEnabled: envBool('DIGIM_WEB_BROWSER_ENABLED', false),
    browserMode: parseBrowserMode('DIGIM_WEB_BROWSER_MODE', 'on-miss'),
    browserWsEndpoint: envStr('DIGIM_WEB_BROWSER_WS_ENDPOINT', ''),
    browserNavTimeoutMs: clampInt(envInt('DIGIM_WEB_BROWSER_NAV_TIMEOUT_MS', 20000), 1000, 120000),
    browserWaitUntil: parseWaitUntil('DIGIM_WEB_BROWSER_WAIT_UNTIL', 'domcontentloaded'),
    browserThinTextChars: clampInt(envInt('DIGIM_WEB_BROWSER_THIN_TEXT_CHARS', 500), 0, 100000),
    browserMaxRequestsPerPage: clampInt(envInt('DIGIM_WEB_BROWSER_MAX_REQUESTS', 80), 1, 2000),
    browserBlockedResourceTypes: envCsv('DIGIM_WEB_BROWSER_BLOCK_RESOURCES', ['image', 'media', 'font', 'stylesheet']),
    browserConcurrency: clampInt(envInt('DIGIM_WEB_BROWSER_CONCURRENCY', 2), 1, 16),
    browserOn403: envBool('DIGIM_WEB_BROWSER_ON_403', true),
    browserBreakerThreshold: clampInt(envInt('DIGIM_WEB_BROWSER_BREAKER_THRESHOLD', 3), 1, 100),
    browserBreakerCooldownMs: clampInt(envInt('DIGIM_WEB_BROWSER_BREAKER_COOLDOWN_MS', 60000), 1000, 3600000),
  });
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function clamp01f(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

let _config: DigimWebConfig | null = null;

/** Returns the process-wide, immutable DIGIM web-research runtime config. */
export function getDigimWebConfig(): DigimWebConfig {
  if (!_config) {
    _config = buildConfig();
    logConfigOnce(_config);
  }
  return _config;
}

/**
 * TEST-ONLY: force a rebuild of the config from the current environment.
 * Never call this in production code paths — it exists so edge-case tests can
 * flip env vars and observe the effect without a fresh process.
 */
export function __rebuildDigimWebConfigForTests(): DigimWebConfig {
  _config = buildConfig();
  return _config;
}

let _logged = false;
function logConfigOnce(cfg: DigimWebConfig): void {
  if (_logged) return;
  _logged = true;
  console.log('🌐 [digimWebConfig] Web-research runtime configuration loaded:');
  console.log(`   • enabled=${cfg.enabled}  provider=${cfg.searchProvider}  maxResults=${cfg.maxSearchResults}`);
  console.log(`   • fetch: concurrency=${cfg.fetchConcurrency} timeout=${cfg.fetchTimeoutMs}ms maxBytes=${cfg.maxContentBytes} redirects=${cfg.maxRedirects}`);
  console.log(`   • ssrfGuard=${cfg.ssrfGuardEnabled} blockPrivate=${cfg.blockPrivateRanges} allowHosts=[${cfg.allowedHosts.join(', ')}] ports=[${cfg.allowedPorts.join(', ')}]`);
  console.log(`   • synthesis: model=${cfg.synthesisModel} maxTokens=${cfg.synthesisMaxTokens} docs=${cfg.synthesisMaxDocuments}`);
  if (cfg.browserEnabled) {
    console.log(`   • browser: mode=${cfg.browserMode} endpoint=${cfg.browserWsEndpoint || '(none)'} concurrency=${cfg.browserConcurrency} navTimeout=${cfg.browserNavTimeoutMs}ms`);
  }
  if (!cfg.enabled) {
    console.log('   • ℹ️ DIGIM web-research is DISABLED (set DIGIM_WEB_ENABLED=true to activate).');
  } else if (cfg.searchProvider === 'none') {
    console.log('   • ⚠️ Web-research enabled but search provider is "none" — gathering will yield no results until DIGIM_WEB_SEARCH_PROVIDER is set.');
  }
}
