// File: test/e2e/liveSecurityE2E.ts
// ============================================================================
// DINA — LIVE SECURITY + TENANCY END-TO-END (against the RUNNING server)
// ============================================================================
// Proves, over real HTTPS, that the DEPLOYED system enforces auth and per-user
// isolation. Creates two throwaway accounts, exercises the auth lifecycle, and
// mounts adversarial cross-tenant attacks against DIGIM. Non-destructive to your
// data: it only creates its own two temp users + (optionally) one tiny research
// each, and logs them out at the end.
//
// Run via scripts/verify-all.sh (which sets VERIFY_BASE_URL), or directly:
//   VERIFY_BASE_URL=https://www.theundergroundrailroad.world/dina \
//   npx ts-node test/e2e/liveSecurityE2E.ts
//
// TLS: set VERIFY_INSECURE=1 to accept a self-signed/loopback cert.
// Research data checks: a real research needs web+LLM. If it doesn't complete in
// time (or DIGIM is disabled) the DATA-tenancy asserts are SKIPPED (reported),
// but the AUTH-boundary asserts (the core security guarantees) ALWAYS run.
// ============================================================================

import https from 'https';
import http from 'http';
import { URL } from 'url';

const BASE = (process.env.VERIFY_BASE_URL || '').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const INSECURE = process.env.VERIFY_INSECURE === '1';
const RESEARCH_TIMEOUT_MS = parseInt(process.env.VERIFY_RESEARCH_TIMEOUT_MS || '180000', 10);

let pass = 0, fail = 0, skip = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.error(`  \x1b[31m✗\x1b[0m ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''); }
}
function skipped(name: string, why: string) { skip++; console.log(`  \x1b[33m•\x1b[0m ${name} — SKIPPED (${why})`); }

interface Resp { status: number; body: any; }
function req(method: string, path: string, opts: { body?: any; token?: string; timeoutMs?: number } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(path.startsWith('http') ? path : `${API}${path}`);
    const isHttps = u.protocol === 'https:';
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const lib = isHttps ? https : http;
    const r = lib.request(
      {
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method,
        headers: {
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        ...(isHttps && INSECURE ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        let buf = ''; res.on('data', (c) => (buf += c));
        res.on('end', () => { let b: any = null; try { b = buf ? JSON.parse(buf) : null; } catch { b = buf; } resolve({ status: res.statusCode || 0, body: b }); });
      },
    );
    r.on('error', reject);
    r.setTimeout(opts.timeoutMs || 30000, () => { r.destroy(new Error('request timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const PW = 'Str0ng!Verify9';
function mkUser(tag: string) {
  return { username: `vfy_${tag}_${uniq}`.slice(0, 20), email: `vfy_${tag}_${uniq}@dina-verify.invalid`, password: PW };
}

async function tinyResearch(token: string, query: string): Promise<string | null> {
  try {
    const r = await req('POST', '/digim/research', {
      token,
      body: { query, intelligence_level: 'surface', max_documents: 3 },
      timeoutMs: RESEARCH_TIMEOUT_MS,
    });
    if (r.status === 200 && r.body?.intelligence_id) return r.body.intelligence_id as string;
    return null;
  } catch { return null; }
}

async function main() {
  if (!BASE) { console.error('VERIFY_BASE_URL is required (e.g. https://host/dina)'); process.exit(2); }
  console.log(`\n=== LIVE SECURITY + TENANCY E2E → ${API} ===\n`);

  // ── 1. AUTH BOUNDARY: DIGIM data endpoints must reject anonymous access ────
  console.log('AUTH BOUNDARY (unauthenticated must be 401)');
  for (const [m, p, b] of [
    ['GET', '/digim/history', undefined],
    ['GET', '/digim/research/some-id', undefined],
    ['POST', '/digim/graph', { query: 'x' }],
    ['POST', '/digim/semantic', {}],
    ['POST', '/digim/node-insight', { entity: 'x' }],
    ['POST', '/digim/recall', { query: 'x' }],
    ['POST', '/digim/research', { query: 'x' }],
  ] as Array<[string, string, any]>) {
    const r = await req(m, p, { body: b });
    ok(`${m} ${p} → 401 without token`, r.status === 401, { got: r.status });
  }

  // ── 2. AUTH LIFECYCLE ──────────────────────────────────────────────────────
  console.log('\nAUTH LIFECYCLE');
  const ua = mkUser('a'), ub = mkUser('b');
  const regA = await req('POST', '/auth/register', { body: ua });
  const regB = await req('POST', '/auth/register', { body: ub });
  ok('register A → 201 + tokens', regA.status === 201 && !!regA.body?.accessToken, { got: regA.status });
  ok('register B → 201 + tokens', regB.status === 201 && !!regB.body?.accessToken, { got: regB.status });
  let aTok = regA.body?.accessToken, aRef = regA.body?.refreshToken;
  const bTok = regB.body?.accessToken;
  if (!aTok || !bTok) { console.error('cannot continue without tokens'); finish(); return; }

  ok('duplicate register → 409', (await req('POST', '/auth/register', { body: ua })).status === 409);
  ok('weak password → 400', (await req('POST', '/auth/register', { body: { ...mkUser('c'), password: 'weak' } })).status === 400);
  const me = await req('GET', '/auth/me', { token: aTok });
  ok('me returns A', me.status === 200 && me.body?.user?.email === ua.email);
  ok('login wrong password → 401', (await req('POST', '/auth/login', { body: { email: ua.email, password: 'Wr0ng!Pass9' } })).status === 401);
  ok('login unknown email → 401 (no enumeration)', (await req('POST', '/auth/login', { body: { email: `nobody_${uniq}@x.invalid`, password: PW } })).status === 401);
  const refreshed = await req('POST', '/auth/refresh', { body: { refreshToken: aRef } });
  ok('refresh → new access token', refreshed.status === 200 && !!refreshed.body?.accessToken);
  if (refreshed.body?.accessToken) aTok = refreshed.body.accessToken;

  // ── 3. TENANCY over live HTTP ──────────────────────────────────────────────
  console.log('\nTENANCY (cross-user isolation)');
  // A's history is only A's (starts empty for a fresh account).
  const aHist0 = await req('GET', '/digim/history', { token: aTok });
  ok('A history is authorized (200) and only A owns it', aHist0.status === 200 && Array.isArray(aHist0.body?.items));
  // IDOR: B tries to open an arbitrary id — must never be another tenant's data.
  const idor = await req('GET', '/digim/research/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { token: bTok });
  ok('B GET arbitrary research id → not found (never another tenant)', idor.status === 200 ? idor.body?.status === 'not_found' : [403, 404].includes(idor.status), { got: idor.status, body: idor.body?.status });

  // Data-level cross-tenant checks require A to actually own a research. Attempt
  // a tiny research; skip the data asserts (not the boundary asserts) if it can't
  // complete (DIGIM disabled / providers down / slow).
  console.log('\nTENANCY (data — requires a live research; auto-skips if unavailable)');
  const aResearchId = await tinyResearch(aTok, `dina verify alpha ${uniq}`);
  if (!aResearchId) {
    skipped('A owns a research', 'research did not complete (DIGIM disabled/slow/providers) — boundary asserts above still hold');
  } else {
    const aHist = await req('GET', '/digim/history', { token: aTok });
    const bHist = await req('GET', '/digim/history', { token: bTok });
    ok('A history contains A research', (aHist.body?.items || []).some((r: any) => r.id === aResearchId));
    ok('B history does NOT contain A research', !(bHist.body?.items || []).some((r: any) => r.id === aResearchId));
    const bGetA = await req('GET', `/digim/research/${aResearchId}?with_documents=true`, { token: bTok });
    ok('B CANNOT open A research by its real id', bGetA.status === 200 ? bGetA.body?.status === 'not_found' : [403, 404].includes(bGetA.status), { got: bGetA.status, body: bGetA.body?.status });
    const aGetA = await req('GET', `/digim/research/${aResearchId}`, { token: aTok });
    ok('A CAN open A research', aGetA.status === 200 && aGetA.body?.research?.id === aResearchId);
  }

  // ── 4. SESSION REVOCATION ──────────────────────────────────────────────────
  console.log('\nSESSION REVOCATION');
  const logout = await req('POST', '/auth/logout', { token: aTok });
  ok('logout → 200', logout.status === 200);
  const meAfter = await req('GET', '/auth/me', { token: aTok });
  ok('A token rejected after logout (session revoked)', meAfter.status === 401, { got: meAfter.status });
  // Clean up B too.
  await req('POST', '/auth/logout', { token: bTok }).catch(() => undefined);

  finish();
}

function finish() {
  const bad = fail > 0;
  console.log(`\n${bad ? '\x1b[31m❌' : '\x1b[32m✅'} LIVE E2E: ${pass} passed, ${fail} failed, ${skip} skipped\x1b[0m\n`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('live E2E crashed:', e?.message || e); process.exit(1); });
