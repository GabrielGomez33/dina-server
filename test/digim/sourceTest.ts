// File: test/digim/sourceTest.ts
// ============================================================================
// DIGIM PHASE 2.3 — SOURCETOOL PURE-LOGIC EDGE CASES
// ============================================================================
// Hermetic (no network): exercises the RSS/Atom feed parser and the source
// registry's config-gated enablement. Live API/feed calls are verified on the
// box per docs/digim/PHASE2_3.md.
//
//   run:  npx ts-node test/digim/sourceTest.ts   (npm run test:sources)
// ============================================================================

import { parseFeed } from '../../src/modules/digim/web/sources/feedTool';
import { createSourceTools } from '../../src/modules/digim/web/sources/sourceRegistry';
import { DigimWebConfig } from '../../src/modules/digim/web/config/webConfig';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function section(t: string): void { console.log(`\n▶ ${t}`); }

function makeCfg(over: Partial<DigimWebConfig> = {}): DigimWebConfig {
  return { sources: [], feedUrls: [], sourceMaxResults: 5, ...over } as DigimWebConfig;
}

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
  <item><title>First Post</title><link>https://example.com/1</link>
    <description>Hello &amp; world</description>
    <pubDate>Wed, 02 Oct 2024 13:00:00 GMT</pubDate></item>
  <item><title><![CDATA[Second & Post]]></title><link>https://example.com/2</link>
    <description><![CDATA[<p>Body two here</p>]]></description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom One</title>
    <link href="https://a.org/x" rel="alternate"/>
    <summary>Summary one</summary>
    <updated>2024-10-02T13:00:00Z</updated></entry>
  <entry><title>Atom Two</title>
    <link href="https://a.org/self" rel="self"/>
    <link href="https://a.org/y" rel="alternate"/>
    <content>Content two body</content>
    <published>2024-01-01T00:00:00Z</published></entry>
</feed>`;

function main(): void {
  console.log('=== DIGIM Phase 2.3 — Source Edge Cases ===');

  // --------------------------------------------------------------------------
  section('parseFeed — RSS 2.0');
  const rss = parseFeed(RSS);
  ok(rss.length === 2, 'two RSS items parsed');
  ok(rss[0].url === 'https://example.com/1', 'RSS link extracted');
  ok(rss[0].title === 'First Post', 'RSS title extracted');
  ok(rss[0].summary === 'Hello & world', 'RSS description: entities decoded');
  ok(typeof rss[0].publishedAt === 'string' && rss[0].publishedAt!.startsWith('2024-10-02'), 'RSS pubDate → ISO');
  ok(rss[1].title === 'Second & Post', 'RSS title: CDATA unwrapped + entity');
  ok(rss[1].summary === 'Body two here', 'RSS description: CDATA + tags stripped');

  // --------------------------------------------------------------------------
  section('parseFeed — Atom');
  const atom = parseFeed(ATOM);
  ok(atom.length === 2, 'two Atom entries parsed');
  ok(atom[0].url === 'https://a.org/x', 'Atom alternate link extracted');
  ok(atom[0].summary === 'Summary one', 'Atom summary extracted');
  ok(atom[1].url === 'https://a.org/y', 'Atom prefers rel=alternate over rel=self');
  ok(atom[1].summary === 'Content two body', 'Atom falls back to <content>');

  // --------------------------------------------------------------------------
  section('parseFeed — malformed / empty degrade to []');
  ok(parseFeed('').length === 0, 'empty string → []');
  ok(parseFeed('<html><body>not a feed</body></html>').length === 0, 'non-feed HTML → []');
  ok(parseFeed('<rss><channel><item><title>no link</title></item></channel></rss>').length === 0, 'item without link dropped');

  // --------------------------------------------------------------------------
  section('createSourceTools — config-gated enablement');
  ok(createSourceTools(makeCfg({ sources: [] })).length === 0, 'no sources configured → none');
  ok(createSourceTools(makeCfg({ sources: ['wikipedia', 'hn'] })).map((t) => t.name).sort().join(',') === 'hn,wikipedia', 'wikipedia+hn enabled');
  ok(createSourceTools(makeCfg({ sources: ['feeds'], feedUrls: [] })).length === 0, "feeds enabled but no feed URLs → FeedTool stays off");
  ok(createSourceTools(makeCfg({ sources: ['feeds'], feedUrls: ['https://x/rss'] })).map((t) => t.name).join(',') === 'rss', 'feeds + feedUrls → FeedTool on');
  ok(createSourceTools(makeCfg({ sources: ['wikipedia', 'feeds'], feedUrls: ['https://x/rss'] })).length === 2, 'mixed sources enabled');

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ Phase 2.3 source pure-logic checks passed.');
  process.exit(0);
}

main();
