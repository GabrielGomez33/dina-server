// File: test/digim/toolTest.ts
// ============================================================================
// DIGIM PHASE 2.2 — FETCHTOOL / BROWSER ESCALATION PURE-LOGIC EDGE CASES
// ============================================================================
// Hermetic (no Chromium/network/Playwright): exercises the escalation policy
// end-to-end with MOCK tools. The real headless-browser drive needs a running
// containerized browser and is verified live per ops/PLAYWRIGHT_RUNBOOK.md.
//
//   run:  npx ts-node test/digim/toolTest.ts   (npm run test:tools)
// ============================================================================

import { assessThinContent } from '../../src/modules/digim/web/tools/thinContent';
import { classifyResourceType } from '../../src/modules/digim/web/tools/browserTool';
import {
  resolveMode,
  shouldEscalate,
  FetchToolRegistry,
} from '../../src/modules/digim/web/tools/fetchRegistry';
import { FetchTool } from '../../src/modules/digim/web/tools/fetchTool';
import { DigimWebConfig } from '../../src/modules/digim/web/config/webConfig';
import { FetchResult } from '../../src/modules/digim/web/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function section(t: string): void { console.log(`\n▶ ${t}`); }

// ----------------------------------------------------------------------------
// TEST FIXTURES
// ----------------------------------------------------------------------------

const BLOCKED = ['image', 'media', 'font', 'stylesheet'];

/** A minimal config carrying only the fields the tool layer reads. */
function makeCfg(over: Partial<DigimWebConfig> = {}): DigimWebConfig {
  return {
    browserEnabled: true,
    browserMode: 'on-miss',
    browserThinTextChars: 500,
    browserOn403: true,
    browserConcurrency: 2,
    browserBreakerThreshold: 3,
    browserBreakerCooldownMs: 60000,
    browserBlockedResourceTypes: BLOCKED,
    ...over,
  } as DigimWebConfig;
}

const RICH_HTML = `<html><body><article>${'word '.repeat(300)}</article></body></html>`;
const SPA_SHELL = '<html><body><div id="__next"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>';
const SHORT_STATIC = '<html><body><p>Hi there, short note.</p></body></html>';

function httpResult(over: Partial<FetchResult> = {}): FetchResult {
  return {
    requestedUrl: 'https://x.test', finalUrl: 'https://x.test', status: 200,
    contentType: 'text/html', body: RICH_HTML, byteLength: RICH_HTML.length,
    fetchedAt: new Date().toISOString(), ok: true, redirects: 0, tool: 'http', ...over,
  };
}

/** Configurable mock FetchTool that counts calls. */
class MockTool implements FetchTool {
  calls = 0;
  constructor(
    public readonly name: string,
    public readonly cost: 'cheap' | 'expensive',
    private available: boolean,
    private responder: (url: string) => Promise<FetchResult>
  ) {}
  isAvailable(): boolean { return this.available; }
  async fetch(url: string): Promise<FetchResult> { this.calls++; return this.responder(url); }
  setAvailable(v: boolean): void { this.available = v; }
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== DIGIM Phase 2.2 — Tool Escalation Edge Cases ===');

  // --------------------------------------------------------------------------
  section('assessThinContent — SPA shell vs real article vs short-static');
  ok(assessThinContent(SPA_SHELL, 500).thin === true, 'SPA shell → thin');
  ok(assessThinContent(SPA_SHELL, 500).spaSignature === true, 'SPA shell → framework marker detected');
  ok(assessThinContent(RICH_HTML, 500).thin === false, 'rich article → not thin');
  ok(assessThinContent('', 500).thin === true, 'empty body → thin');
  ok(assessThinContent(SHORT_STATIC, 500).thin === false, 'short static (no SPA marker) → NOT escalated');
  ok(assessThinContent('<html><body><div id="root"></div><script></script><script></script><script></script><script></script><script></script></body></html>', 500).thin === true, 'react root + script-heavy → thin');

  // --------------------------------------------------------------------------
  section('classifyResourceType — block list is enforced, case-insensitive');
  ok(classifyResourceType('image', BLOCKED) === 'block', 'image blocked');
  ok(classifyResourceType('stylesheet', BLOCKED) === 'block', 'stylesheet blocked');
  ok(classifyResourceType('IMAGE', BLOCKED) === 'block', 'block is case-insensitive');
  ok(classifyResourceType('document', BLOCKED) === 'allow', 'document allowed');
  ok(classifyResourceType('script', BLOCKED) === 'allow', 'script allowed (needed to render)');
  ok(classifyResourceType('xhr', BLOCKED) === 'allow', 'xhr allowed');

  // --------------------------------------------------------------------------
  section('resolveMode — the browser can never be forced on illegitimately');
  ok(resolveMode('always', makeCfg({ browserEnabled: false }), true) === 'off', 'globally disabled → off (even if requested always)');
  ok(resolveMode('on-miss', makeCfg(), false) === 'off', 'browser unavailable → off');
  ok(resolveMode(undefined, makeCfg({ browserMode: 'on-miss' }), true) === 'on-miss', 'default from config');
  ok(resolveMode('always', makeCfg({ browserMode: 'on-miss' }), true) === 'always', 'per-request override honored');
  ok(resolveMode('bogus' as any, makeCfg({ browserMode: 'on-miss' }), true) === 'on-miss', 'invalid request falls back to config default');

  // --------------------------------------------------------------------------
  section('shouldEscalate — the escalation trigger');
  ok(shouldEscalate(httpResult({ body: RICH_HTML }), makeCfg()) === false, 'ok + rich → no escalation');
  ok(shouldEscalate(httpResult({ body: SPA_SHELL }), makeCfg()) === true, 'ok + SPA shell → escalate');
  ok(shouldEscalate(httpResult({ ok: false, status: 403, body: '' }), makeCfg()) === true, '403 → escalate (bot wall)');
  ok(shouldEscalate(httpResult({ ok: false, status: 429, body: '' }), makeCfg()) === true, '429 → escalate');
  ok(shouldEscalate(httpResult({ ok: false, status: 404, body: '' }), makeCfg()) === false, '404 → no escalation');
  ok(shouldEscalate(httpResult({ ok: false, status: 403, body: '' }), makeCfg({ browserOn403: false })) === false, '403 with on403=off → no escalation');

  // --------------------------------------------------------------------------
  section('FetchToolRegistry.acquire — full policy with mock tools');

  // 1) Globally disabled → browser never touched.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: SPA_SHELL }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', body: RICH_HTML }));
    const reg = new FetchToolRegistry(http, browser, makeCfg({ browserEnabled: false }));
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'http' && browser.calls === 0, 'disabled: HTTP only, browser untouched');
  }

  // 2) on-miss + rich HTTP → no escalation.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: RICH_HTML }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', body: RICH_HTML }));
    const reg = new FetchToolRegistry(http, browser, makeCfg());
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'http' && browser.calls === 0 && !r.escalated, 'on-miss + rich: no escalation');
  }

  // 3) on-miss + thin HTTP → escalate, escalated flag set.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: SPA_SHELL }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', body: RICH_HTML }));
    const reg = new FetchToolRegistry(http, browser, makeCfg());
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'browser' && browser.calls === 1 && r.escalated === true, 'on-miss + shell: escalated to browser');
  }

  // 4) on-miss + 403 HTTP → escalate.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ ok: false, status: 403, body: '' }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', body: RICH_HTML }));
    const reg = new FetchToolRegistry(http, browser, makeCfg());
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'browser' && r.escalated === true, 'on-miss + 403: escalated');
  }

  // 5) always → browser first, escalated:false.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: RICH_HTML }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', body: RICH_HTML }));
    const reg = new FetchToolRegistry(http, browser, makeCfg({ browserMode: 'always' }));
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'browser' && browser.calls === 1 && http.calls === 0 && !r.escalated, 'always: browser-first, HTTP not called');
  }

  // 6) browser unavailable → HTTP only even on a shell.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: SPA_SHELL }));
    const browser = new MockTool('browser', 'expensive', false, async () => httpResult({ tool: 'browser', body: RICH_HTML }));
    const reg = new FetchToolRegistry(http, browser, makeCfg());
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'http' && browser.calls === 0, 'unavailable browser: graceful HTTP-only');
  }

  // 7) always mode, browser fails → HTTP fallback.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: RICH_HTML }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', ok: false, status: 0, body: '', error: 'boom' }));
    const reg = new FetchToolRegistry(http, browser, makeCfg({ browserMode: 'always' }));
    const r = await reg.acquire('https://x.test');
    ok(r.tool === 'http' && r.ok === true, 'always + browser fail: falls back to HTTP');
  }

  // 8) circuit breaker opens after threshold consecutive browser failures.
  {
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: SPA_SHELL }));
    const browser = new MockTool('browser', 'expensive', true, async () => httpResult({ tool: 'browser', ok: false, status: 0, body: '', error: 'down' }));
    const reg = new FetchToolRegistry(http, browser, makeCfg({ browserBreakerThreshold: 2, browserBreakerCooldownMs: 60000 }));
    await reg.acquire('https://x.test'); // browser fail #1
    await reg.acquire('https://x.test'); // browser fail #2 → breaker opens
    await reg.acquire('https://x.test'); // breaker open → browser skipped
    ok(browser.calls === 2, 'breaker: browser stops being called after threshold failures');
  }

  // 9) breaker resets on a browser success (no premature opening).
  {
    let calls = 0;
    const http = new MockTool('http', 'cheap', true, async () => httpResult({ body: SPA_SHELL }));
    const browser = new MockTool('browser', 'expensive', true, async () => {
      calls++;
      // fail, succeed, fail — never two consecutive failures.
      return calls === 2 ? httpResult({ tool: 'browser', body: RICH_HTML }) : httpResult({ tool: 'browser', ok: false, status: 0, body: '', error: 'x' });
    });
    const reg = new FetchToolRegistry(http, browser, makeCfg({ browserBreakerThreshold: 2, browserBreakerCooldownMs: 60000 }));
    await reg.acquire('https://x.test'); // fail (count 1)
    await reg.acquire('https://x.test'); // success → reset
    await reg.acquire('https://x.test'); // fail (count 1 again, not 2)
    ok(browser.calls === 3, 'breaker: success resets the failure counter (stays closed)');
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ Phase 2.2 tool-escalation pure-logic checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
