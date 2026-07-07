// File: digim-web-research/tests/edgeCases.ts
// ============================================================================
// DIGIM WEB-RESEARCH — EDGE-CASE TEST HARNESS
// ============================================================================
//
// A dependency-light, hermetic test harness for the pure logic of the
// web-research subsystem. It imports ONLY the leaf modules (no DB, Redis, LLM
// or network), so it runs fast and deterministically:
//
//   run:  npx ts-node digim-web-research/tests/edgeCases.ts
//
// Focus is the security-critical SSRF guard plus the content extractor, quality
// scorer, search-provider factory, and config parsing. Network-dependent paths
// (live fetch, live search, LLM synthesis) are covered by the manual runbook in
// digim-web-research/EDGE_CASES.md, not here.
// ============================================================================

import {
  checkUrlSafety,
  isPrivateAddress,
} from '../../src/modules/digim/web/security/urlGuard';
import { ContentExtractor } from '../../src/modules/digim/web/gatherers/contentExtractor';
import { QualityScorer } from '../../src/modules/digim/web/scoring/qualityScorer';
import { createSearchProvider } from '../../src/modules/digim/web/gatherers/searchProvider';
import {
  __rebuildDigimWebConfigForTests,
  DigimWebConfig,
} from '../../src/modules/digim/web/config/webConfig';

// ----------------------------------------------------------------------------
// Tiny assertion framework
// ----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  ❌ ${name}`);
  }
}

function eq(actual: unknown, expected: unknown, name: string): void {
  ok(actual === expected, `${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function section(title: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▶ ${title}`);
  await fn();
}

/** Build a config with the SSRF guard on and private ranges blocked. */
function guardedConfig(overrides: Record<string, string> = {}): DigimWebConfig {
  const env: Record<string, string> = {
    DIGIM_WEB_ENABLED: 'true',
    DIGIM_WEB_SSRF_GUARD: 'true',
    DIGIM_WEB_BLOCK_PRIVATE_RANGES: 'true',
    ...overrides,
  };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  const cfg = __rebuildDigimWebConfigForTests();
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return cfg;
}

// ----------------------------------------------------------------------------
// TESTS
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== DIGIM Web-Research Edge-Case Harness ===');

  await section('isPrivateAddress — IPv4 blocked ranges', () => {
    const blocked = [
      '127.0.0.1', '127.53.1.9', '10.0.0.1', '10.255.255.255', '172.16.0.1',
      '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
      '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1',
      '255.255.255.255', '192.0.2.1', '203.0.113.9',
    ];
    for (const ip of blocked) ok(isPrivateAddress(ip) === true, `blocked ${ip}`);
  });

  await section('isPrivateAddress — IPv4 public allowed', () => {
    const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1'];
    for (const ip of allowed) ok(isPrivateAddress(ip) === false, `public ${ip}`);
  });

  await section('isPrivateAddress — IPv6 blocked + mapped', () => {
    const blocked = [
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
      '2001:db8::1', '64:ff9b::7f00:1',
    ];
    for (const ip of blocked) ok(isPrivateAddress(ip) === true, `blocked ${ip}`);
    const allowed = ['2606:4700:4700::1111', '::ffff:8.8.8.8'];
    for (const ip of allowed) ok(isPrivateAddress(ip) === false, `public ${ip}`);
  });

  await section('isPrivateAddress — malformed fails closed', () => {
    ok(isPrivateAddress('not-an-ip') === true, 'garbage → blocked');
    ok(isPrivateAddress('999.999.999.999') === true, 'out-of-range v4 → blocked');
    ok(isPrivateAddress('') === true, 'empty → blocked');
  });

  const cfg = guardedConfig();

  await section('checkUrlSafety — scheme / creds / port', async () => {
    eq((await checkUrlSafety('ftp://example.com/x', cfg)).reason, 'bad_scheme', 'ftp blocked');
    eq((await checkUrlSafety('file:///etc/passwd', cfg)).reason, 'bad_scheme', 'file blocked');
    eq((await checkUrlSafety('javascript:alert(1)', cfg)).reason, 'bad_scheme', 'javascript blocked');
    eq((await checkUrlSafety('http://user:pass@8.8.8.8/', cfg)).reason, 'embedded_credentials', 'creds blocked');
    eq((await checkUrlSafety('not a url', cfg)).reason, 'parse_error', 'garbage blocked');
    eq((await checkUrlSafety('http://8.8.8.8:22/', cfg)).reason, 'port_not_allowed', 'port 22 blocked');
  });

  await section('checkUrlSafety — private IP literals blocked (no DNS)', async () => {
    eq((await checkUrlSafety('http://127.0.0.1/', cfg)).reason, 'private_address', 'loopback blocked');
    eq((await checkUrlSafety('http://169.254.169.254/latest/meta-data/', cfg)).reason, 'private_address', 'metadata blocked');
    eq((await checkUrlSafety('http://10.0.0.5/', cfg)).reason, 'private_address', '10/8 blocked');
    eq((await checkUrlSafety('http://[::1]/', cfg)).reason, 'private_address', 'ipv6 loopback blocked');
    eq((await checkUrlSafety('http://192.168.0.1/', cfg)).reason, 'private_address', '192.168 blocked');
  });

  await section('checkUrlSafety — public IP literal allowed', async () => {
    const r = await checkUrlSafety('https://8.8.8.8/', cfg);
    ok(r.safe === true, 'public IP allowed');
  });

  await section('checkUrlSafety — allow/deny lists', async () => {
    const denyCfg = guardedConfig({ DIGIM_WEB_DENIED_HOSTS: 'evil.com' });
    // Deny check happens before DNS, so a denied host short-circuits.
    eq((await checkUrlSafety('https://sub.evil.com/', denyCfg)).reason, 'host_denied', 'denylist suffix match');

    const allowCfg = guardedConfig({ DIGIM_WEB_ALLOWED_HOSTS: 'example.com' });
    eq((await checkUrlSafety('https://8.8.8.8/', allowCfg)).reason, 'host_not_allowed', 'non-allowlisted host blocked');
  });

  await section('checkUrlSafety — guard disabled passes through', async () => {
    const off = guardedConfig({ DIGIM_WEB_SSRF_GUARD: 'false' });
    const r = await checkUrlSafety('http://127.0.0.1/', off);
    ok(r.safe === true, 'guard off → loopback allowed (documented)');
  });

  await section('ContentExtractor — main content + boilerplate removal', () => {
    const extractor = new ContentExtractor();
    const html = `<!doctype html><html lang="en"><head>
      <title>Test Article &amp; More</title>
      <meta name="author" content="Jane Doe">
      <meta property="article:published_time" content="2025-01-15T10:00:00Z">
      </head><body>
      <nav>Home About Contact login signup</nav>
      <header>Site header junk</header>
      <script>var x = 'javascript:alert(1)';</script>
      <style>.a{color:red}</style>
      <article>
        <h1>Test Article &amp; More</h1>
        <p>This is the first substantial paragraph with enough words to be kept by the density heuristic.</p>
        <p>Here is a second meaningful paragraph, also long enough to survive the filter cleanly.</p>
      </article>
      <aside>Related links sidebar noise</aside>
      <footer>Copyright junk footer</footer>
      </body></html>`;
    const out = extractor.extract(html, 'text/html', 'https://example.com/test');
    eq(out.title, 'Test Article & More', 'title decoded');
    eq(out.author, 'Jane Doe', 'author from meta');
    eq(out.language, 'en', 'lang from html');
    ok(out.publishedAt === '2025-01-15T10:00:00.000Z', 'published date normalized');
    ok(out.text.includes('first substantial paragraph'), 'kept paragraph 1');
    ok(out.text.includes('second meaningful paragraph'), 'kept paragraph 2');
    ok(!out.text.toLowerCase().includes('sidebar noise'), 'dropped aside');
    ok(!out.text.toLowerCase().includes('footer'), 'dropped footer');
    ok(!out.text.includes('javascript:alert'), 'dropped script content');
    ok(out.wordCount > 15, 'word count computed');
    ok(/^[0-9a-f]{64}$/.test(out.contentHash), 'sha256 content hash');
  });

  await section('ContentExtractor — identical text → identical hash (dedup)', () => {
    const extractor = new ContentExtractor();
    const a = extractor.extract('<html><body><p>The quick brown fox jumps over the lazy dog repeatedly today.</p></body></html>');
    const b = extractor.extract('<html><body><article><p>The quick brown fox jumps over the lazy dog repeatedly today.</p></article></body></html>');
    eq(a.contentHash, b.contentHash, 'same normalized text → same hash');
  });

  await section('ContentExtractor — empty / malformed HTML', () => {
    const extractor = new ContentExtractor();
    const empty = extractor.extract('', 'text/html', 'https://example.com/foo-bar');
    ok(empty.wordCount === 0, 'empty → 0 words');
    ok(empty.title.length > 0, 'title falls back to URL slug');
    const malformed = extractor.extract('<html><body><p>Unclosed paragraph with several words here', 'text/html');
    ok(malformed.text.includes('Unclosed paragraph') || malformed.wordCount >= 0, 'malformed handled without throwing');
    const plain = extractor.extract('Just some plain text content here.', 'text/plain');
    ok(plain.text.includes('plain text content'), 'plain text passthrough');
  });

  await section('ContentExtractor — polish: strip refs/edit brackets + nav/hatnotes', () => {
    const extractor = new ContentExtractor();
    // Real Wikipedia structure: hatnotes are <div class="hatnote"> / role="note"
    // (NOT <p>), references are <sup class="reference">, plus inline [ ... ] artifacts.
    const html = `<html><body><article>
      <div class="hatnote navigation-not-searchable">This article is about rechargeable batteries. For non-rechargeable cells, see primary battery.</div>
      <div role="note">"Li-ion" redirects here. For other uses, see lithium.</div>
      <div class="shortdescription">Type of rechargeable battery</div>
      <p>Lithium-ion batteries reached 300 Wh/kg in commercial cells<sup class="reference">[1]</sup> and continue to improve steadily each year as manufacturers refine cathode and anode materials for greater usable capacity.[ citation needed ] Newer chemistries push energy density higher in laboratory prototypes under active development.</p>
      <p>Researchers demonstrated a solid electrolyte that improves safety and energy density substantially compared with conventional liquid electrolytes, reducing flammability and enabling higher voltage operation in next generation automotive cells.[ edit ]</p>
      </article></body></html>`;
    const out = extractor.extract(html, 'text/html', 'https://example.com/x');
    ok(!/\[\s*1\s*\]/.test(out.text), 'citation [1] stripped');
    ok(!/citation needed/i.test(out.text), '[citation needed] stripped');
    ok(!/\[\s*edit\s*\]/i.test(out.text), '[edit] stripped');
    ok(!/redirects here/i.test(out.text), '"redirects here" hatnote <div> dropped');
    ok(!/this article is about/i.test(out.text), '"this article is about" hatnote <div> dropped');
    ok(!/type of rechargeable battery/i.test(out.text), 'shortdescription <div> dropped');
    ok(out.text.includes('300 Wh/kg'), 'real content retained (energy density)');
    ok(out.text.includes('solid electrolyte'), 'real content retained (solid electrolyte)');
  });

  await section('QualityScorer — bounded, sensible facets', () => {
    const scorer = new QualityScorer();
    const q = scorer.score({
      query: 'renewable energy storage',
      url: 'https://www.nature.com/articles/x',
      extracted: {
        title: 'Advances in renewable energy storage',
        text: 'renewable energy storage '.repeat(120),
        wordCount: 240,
        contentHash: 'x',
        method: 'heuristic',
        publishedAt: new Date().toISOString(),
      },
      sourceTrust: 0.6,
    });
    for (const [k, v] of Object.entries(q)) {
      ok(v >= 0 && v <= 1, `facet ${k} in [0,1] (=${v})`);
    }
    ok(q.relevance > 0.5, 'relevance high for matching query');
    ok(q.authority >= 0.85, 'nature.com authority boosted');
    ok(q.freshness > 0.9, 'fresh doc high freshness');

    const dup = scorer.score({
      query: 'x',
      url: 'http://blogspot.example.blogspot.com/x',
      extracted: { title: 't', text: 'short', wordCount: 3, contentHash: 'x', method: 'heuristic' },
      duplicate: true,
    });
    ok(dup.uniqueness <= 0.2, 'duplicate penalized');
    ok(dup.completeness < 0.1, 'tiny doc low completeness');
  });

  await section('SearchProvider factory — graceful defaults', () => {
    const noneCfg = guardedConfig({ DIGIM_WEB_SEARCH_PROVIDER: 'none' });
    eq(createSearchProvider(noneCfg).name, 'none', 'none provider');

    // searxng without URL → still returns searxng name only if URL present;
    // default URL is localhost so it IS configured (name searxng).
    const searxCfg = guardedConfig({ DIGIM_WEB_SEARCH_PROVIDER: 'searxng' });
    eq(createSearchProvider(searxCfg).name, 'searxng', 'searxng selected');

    const braveCfg = guardedConfig({ DIGIM_WEB_SEARCH_PROVIDER: 'brave' });
    eq(createSearchProvider(braveCfg).name, 'brave', 'brave selected');
  });

  await section('SearchProvider none — returns [] without network', async () => {
    const noneCfg = guardedConfig({ DIGIM_WEB_SEARCH_PROVIDER: 'none' });
    const results = await createSearchProvider(noneCfg).search('anything', 5);
    ok(Array.isArray(results) && results.length === 0, 'none → empty results');
  });

  await section('Config — clamping & defaults', () => {
    const c = guardedConfig({
      DIGIM_WEB_FETCH_CONCURRENCY: '9999',
      DIGIM_WEB_MAX_SEARCH_RESULTS: '-5',
      DIGIM_WEB_FETCH_TIMEOUT_MS: 'notanumber',
    });
    ok(c.fetchConcurrency <= 16, 'concurrency clamped to max');
    ok(c.maxSearchResults >= 1, 'search results clamped to min');
    ok(c.fetchTimeoutMs === 15000, 'invalid timeout → default');
    ok(c.enabled === true, 'enabled parsed');
    ok(c.allowedPorts.includes(80) && c.allowedPorts.includes(443), 'default ports');
  });

  // --------------------------------------------------------------------------
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ All edge-case checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Harness crashed:', err);
  process.exit(1);
});
