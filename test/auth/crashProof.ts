// Prove the asyncHandler fix: with NO JWT secrets set, hitting /auth/register
// returns a clean 503 and the process stays alive (before the fix this threw an
// unhandled rejection that restarted the server → site-wide 502).
import http from 'http';
import express from 'express';
import { registerAuthRoutes } from '../../src/modules/auth';

// Force a configuration ERROR (a too-short JWT_SECRET) so register() throws
// inside its handler — the exact scenario that used to crash the process.
process.env.JWT_SECRET = 'too-short';
delete process.env.JWT_REFRESH_SECRET;

let crashed = false;
process.on('unhandledRejection', (e) => { crashed = true; console.error('UNHANDLED REJECTION:', e); });

async function main() {
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  registerAuthRoutes(apiRouter);
  app.use('/api/v1', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;

  const status: number = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'aaa', email: 'a@b.co', password: 'Str0ng!Pass9' });
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/v1/auth/register',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
    req.on('error', reject); req.write(body); req.end();
  });

  // Give any (buggy) unhandled rejection a tick to surface.
  await new Promise((r) => setTimeout(r, 200));
  server.close();

  const ok = status === 503 && !crashed;
  console.log(`register with a too-short JWT_SECRET → HTTP ${status}; process crashed: ${crashed}`);
  console.log(ok ? '✅ PASS: clean 503, process survived' : '❌ FAIL');
  process.exit(ok ? 0 : 1);
}
main();
