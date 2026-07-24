// File: test/auth/configTest.ts
// ============================================================================
// DINA AUTH — SIGNING-SECRET RESOLUTION TESTS (no DB, no network)
// ============================================================================
// Proves the JWT_SECRET-primary model with self-managed fallback:
//   - JWT_SECRET set → used; refresh key derived (distinct) unless overridden
//   - JWT_SECRET too short → clear error (caught upstream → 503, never a crash)
//   - no JWT_SECRET → generate + persist (0600); a restart reuses the SAME
//     secrets (live sessions survive)
//   - explicit JWT_REFRESH_SECRET honored; equal-to-primary rejected
// ============================================================================

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAuthConfig, _resetAuthConfigCache } from '../../src/modules/auth/config';

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-auth-'));
const secretsFile = path.join(tmpRoot, 'auth', 'jwt-secrets.json');

function clearEnv(): void {
  delete process.env.JWT_SECRET;
  delete process.env.JWT_REFRESH_SECRET;
  process.env.DINA_AUTH_SECRETS_FILE = secretsFile;
}
function fresh() {
  _resetAuthConfigCache();
  return getAuthConfig();
}
function expectThrow(name: string, setup: () => void): void {
  setup();
  _resetAuthConfigCache();
  try {
    getAuthConfig();
    t(name + ' (should have thrown)', false);
  } catch (e) {
    t(name, e instanceof Error && /\[auth\]/.test(e.message), e instanceof Error ? e.message : e);
  }
}

const S = crypto.randomBytes(32).toString('hex'); // 64 chars, like `openssl rand -hex 32`
const S2 = crypto.randomBytes(32).toString('hex');

// ── 1. JWT_SECRET primary, refresh derived ──────────────────────────────────
clearEnv();
process.env.JWT_SECRET = S;
const envCfg = fresh();
t('JWT_SECRET is used', envCfg.jwtSecret === S && envCfg.secretSource === 'env');
t('refresh key derived + distinct from primary', envCfg.jwtRefreshSecret !== S && envCfg.jwtRefreshSecret.length >= 32);
t('derivation is deterministic', (() => { _resetAuthConfigCache(); return getAuthConfig().jwtRefreshSecret === envCfg.jwtRefreshSecret; })());

// ── 2. explicit JWT_REFRESH_SECRET honored ──────────────────────────────────
clearEnv();
process.env.JWT_SECRET = S;
process.env.JWT_REFRESH_SECRET = S2;
const bothCfg = fresh();
t('explicit refresh secret honored', bothCfg.jwtRefreshSecret === S2);

// ── 3. validation errors are clear (→ 503 upstream, never a crash) ──────────
expectThrow('short JWT_SECRET → throws', () => { clearEnv(); process.env.JWT_SECRET = 'short'; });
expectThrow('refresh equal to primary → throws', () => { clearEnv(); process.env.JWT_SECRET = S; process.env.JWT_REFRESH_SECRET = S; });
expectThrow('short explicit refresh → throws', () => { clearEnv(); process.env.JWT_SECRET = S; process.env.JWT_REFRESH_SECRET = 'x'; });

// ── 4. no JWT_SECRET → generate + persist, restart reuses same ──────────────
clearEnv();
if (fs.existsSync(secretsFile)) fs.rmSync(secretsFile);
const gen = fresh();
t('no JWT_SECRET → generated', gen.secretSource === 'generated' && gen.jwtSecret.length >= 32 && gen.jwtSecret !== gen.jwtRefreshSecret);
t('generated file persisted 0600', fs.existsSync(secretsFile) && (fs.statSync(secretsFile).mode & 0o777) === 0o600);
clearEnv();
const reload = fresh();
t('restart reuses persisted secrets (sessions survive)', reload.secretSource === 'file' && reload.jwtSecret === gen.jwtSecret && reload.jwtRefreshSecret === gen.jwtRefreshSecret);

// ── cleanup ─────────────────────────────────────────────────────────────────
clearEnv();
delete process.env.JWT_SECRET;
_resetAuthConfigCache();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${failed === 0 ? '✅' : '❌'} auth config: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
