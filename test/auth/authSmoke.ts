// File: test/auth/authSmoke.ts
// ============================================================================
// DINA AUTH — LIVE SMOKE TEST
// ============================================================================
// Boots the real Express auth routes against a live MySQL (DB_* env), exercises
// the full flow end-to-end over HTTP, and asserts on status + body. Requires:
//   - a MySQL reachable via DB_* env with migration 004 applied
//   - JWT_SECRET / JWT_REFRESH_SECRET set (AUTH_EMAIL_PROVIDER=console)
// Injects a mysql2 pool into DINA's database singleton so we test the real
// stores without running the heavy full database.initialize().
// ============================================================================

import http from 'http';
import express from 'express';
import mysql from 'mysql2/promise';
import { database } from '../../src/config/database/db';
import { registerAuthRoutes } from '../../src/modules/auth';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

interface Resp {
  status: number;
  body: any;
}

function reqJson(port: number, method: string, path: string, body?: unknown, token?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  // 1. Inject a live pool into the singleton (skip heavy initialize()).
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'dina_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'dina',
    waitForConnections: true,
    connectionLimit: 4,
  });
  (database as any).pool = pool;
  (database as any).isConnected = true;

  // 2. Build the app exactly as production mounts it.
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  registerAuthRoutes(apiRouter);
  app.use('/api/v1', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port as number;
  const base = '/api/v1/auth';

  const uniq = process.env.SMOKE_UNIQ || 'x';
  const email = `smoke_${uniq}@dina.dev`;
  const username = `smoke_${uniq}`;
  const password = 'Str0ng!Pass9';

  try {
    console.log('REGISTER');
    const reg = await reqJson(port, 'POST', `${base}/register`, { username, email, password });
    check('register 201', reg.status === 201, reg);
    check('register returns tokens', !!reg.body?.accessToken && !!reg.body?.refreshToken);
    check('register user has uuid id', typeof reg.body?.user?.id === 'string' && reg.body.user.id.length >= 32, reg.body?.user?.id);
    const access = reg.body?.accessToken as string;
    const refresh = reg.body?.refreshToken as string;

    console.log('DUPLICATE REGISTER');
    const dup = await reqJson(port, 'POST', `${base}/register`, { username, email, password });
    check('duplicate register 409', dup.status === 409, dup);

    console.log('WEAK PASSWORD');
    const weak = await reqJson(port, 'POST', `${base}/register`, { username: username + '2', email: `2${email}`, password: 'weak' });
    check('weak password 400 WEAK_PASSWORD', weak.status === 400 && weak.body?.code === 'WEAK_PASSWORD', weak);

    console.log('ME (with access token)');
    const me1 = await reqJson(port, 'GET', `${base}/me`, undefined, access);
    check('me 200', me1.status === 200, me1);
    check('me returns same user', me1.body?.user?.email === email);

    console.log('ME (no token)');
    const me401 = await reqJson(port, 'GET', `${base}/me`);
    check('me without token 401', me401.status === 401, me401);

    console.log('LOGIN wrong password');
    const badLogin = await reqJson(port, 'POST', `${base}/login`, { email, password: 'Wr0ng!Pass9' });
    check('login wrong pw 401', badLogin.status === 401 && badLogin.body?.code === 'INVALID_CREDENTIALS', badLogin);

    console.log('LOGIN unknown email (timing-safe)');
    const noUser = await reqJson(port, 'POST', `${base}/login`, { email: `nope_${uniq}@dina.dev`, password });
    check('login unknown 401 (no enumeration)', noUser.status === 401 && noUser.body?.code === 'INVALID_CREDENTIALS', noUser);

    console.log('LOGIN correct');
    const login = await reqJson(port, 'POST', `${base}/login`, { email, password });
    check('login 200', login.status === 200, login);
    check('login returns tokens', !!login.body?.accessToken);
    const access2 = login.body?.accessToken as string;

    console.log('REFRESH');
    const ref = await reqJson(port, 'POST', `${base}/refresh`, { refreshToken: refresh });
    check('refresh 200 with new access', ref.status === 200 && !!ref.body?.accessToken, ref);

    console.log('CHECK-USERNAME (taken vs free)');
    const taken = await reqJson(port, 'GET', `${base}/check-username?username=${encodeURIComponent(username)}`);
    check('check-username taken → available:false', taken.status === 200 && taken.body?.available === false, taken);
    const free = await reqJson(port, 'GET', `${base}/check-username?username=free_${uniq}`);
    check('check-username free → available:true', free.status === 200 && free.body?.available === true, free);

    console.log('FORGOT PASSWORD (always 200, no enumeration)');
    const forgot = await reqJson(port, 'POST', `${base}/forgot-password`, { email });
    const forgotUnknown = await reqJson(port, 'POST', `${base}/forgot-password`, { email: `ghost_${uniq}@dina.dev` });
    check('forgot known 200', forgot.status === 200, forgot);
    check('forgot unknown 200 (same response)', forgotUnknown.status === 200 && JSON.stringify(forgot.body) === JSON.stringify(forgotUnknown.body));

    console.log('LOGOUT then session invalid');
    const logout = await reqJson(port, 'POST', `${base}/logout`, undefined, access2);
    check('logout 200', logout.status === 200, logout);
    // access2's session is now revoked → me with access2 must fail.
    const meAfter = await reqJson(port, 'GET', `${base}/me`, undefined, access2);
    check('me after logout 401 (session revoked)', meAfter.status === 401, meAfter);
    // But the FIRST session (access from register) is a different session → still valid.
    const meStill = await reqJson(port, 'GET', `${base}/me`, undefined, access);
    check('other session still valid after single logout', meStill.status === 200, meStill);

    console.log('LOGOUT-ALL then all sessions invalid');
    await reqJson(port, 'POST', `${base}/logout-all`, undefined, access);
    const meNone = await reqJson(port, 'GET', `${base}/me`, undefined, access);
    check('me after logout-all 401', meNone.status === 401, meNone);
  } finally {
    server.close();
    await pool.end();
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} auth smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
