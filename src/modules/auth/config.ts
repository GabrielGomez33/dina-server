// File: src/modules/auth/config.ts
// ============================================================================
// DINA AUTH — CONFIGURATION + SIGNING SECRETS
// ============================================================================
// Secret resolution (first that applies wins):
//
//   1. JWT_SECRET (env) — the one value an operator sets, e.g.
//        openssl rand -hex 32
//      The refresh-signing key is DERIVED from it (HMAC) so a single secret is
//      enough; set JWT_REFRESH_SECRET too only if you want the two fully
//      independent. This is dina-server's OWN .env — grep confirms no other
//      module here reads JWT_SECRET, so there is no collision with mirror-server
//      (a separate app with a separate .env).
//
//   2. Self-managed fallback — if no JWT_SECRET is set, DINA generates strong
//      secrets on first use and persists them (0600) under the storage dir,
//      surviving restarts/deploys, so a fresh box boots with zero config.
//
// A bad/short secret surfaces as a clear 503 on the request (see
// authRoutes.asyncHandler), never a process crash. Resolution is cached.
// ============================================================================

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface AuthConfig {
  jwtSecret: string;
  jwtRefreshSecret: string;
  issuer: string; // JWT `iss` — scopes tokens to DINA so another service's token can't be replayed
  secretSource: 'env' | 'file' | 'generated';
  accessTokenExpiry: string; // e.g. '15m'
  refreshTokenExpiry: string; // e.g. '7d'
  refreshTokenTtlMs: number; // numeric mirror of refreshTokenExpiry for session rows
  bcryptRounds: number;
  appBaseUrl: string; // frontend base, used to build verify/reset links
  emailProvider: 'resend' | 'console';
  resendApiKey: string;
  emailFrom: string;
}

let cached: AuthConfig | null = null;

const MIN_SECRET_LEN = 32;
const ISSUER = 'dina-auth';

/** Deterministically derive a distinct refresh-signing key from the primary
 *  secret. HMAC output is independent of the input in a way that leaking the
 *  access key alone can't be inverted to the secret — and it's always distinct
 *  from the primary, so the two-key property holds with a single managed value. */
function deriveRefreshSecret(primary: string): string {
  return crypto.createHmac('sha256', primary).update('dina-auth/refresh/v1').digest('hex');
}

// ── Self-managed fallback (only used when JWT_SECRET is unset) ────────────────

function secretsFilePath(): string {
  const explicit = (process.env.DINA_AUTH_SECRETS_FILE || '').trim();
  if (explicit) return explicit;
  const root = (process.env.DINA_STORAGE_ROOT || '/var/www/dina-storage').trim();
  return path.join(root, 'auth', 'jwt-secrets.json');
}

interface PersistedSecrets {
  jwtSecret: string;
  jwtRefreshSecret: string;
  createdAt?: string;
}

function readSecretsFile(file: string): PersistedSecrets | null {
  try {
    if (!fs.existsSync(file)) return null;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedSecrets;
    if (
      p &&
      typeof p.jwtSecret === 'string' &&
      typeof p.jwtRefreshSecret === 'string' &&
      p.jwtSecret.length >= MIN_SECRET_LEN &&
      p.jwtRefreshSecret.length >= MIN_SECRET_LEN &&
      p.jwtSecret !== p.jwtRefreshSecret
    ) {
      return p;
    }
    console.warn(`[auth] secrets file ${file} exists but is invalid — regenerating.`);
    return null;
  } catch (err) {
    console.warn(`[auth] could not read secrets file ${file}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function generateAndPersist(file: string): PersistedSecrets {
  const secrets: PersistedSecrets = {
    jwtSecret: crypto.randomBytes(48).toString('hex'),
    jwtRefreshSecret: crypto.randomBytes(48).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    throw new Error(
      `[auth] no JWT_SECRET set and could not persist generated secrets to ${file} ` +
        `(${err instanceof Error ? err.message : err}). Set JWT_SECRET (e.g. \`openssl rand -hex 32\`) ` +
        `in the DINA .env, or make that path writable / set DINA_AUTH_SECRETS_FILE.`,
    );
  }
  return secrets;
}

// ── Resolution ───────────────────────────────────────────────────────────────

function resolveSecrets(): Pick<AuthConfig, 'jwtSecret' | 'jwtRefreshSecret' | 'secretSource'> {
  const primary = (process.env.JWT_SECRET || '').trim();

  if (primary) {
    if (primary.length < MIN_SECRET_LEN) {
      throw new Error(
        `[auth] JWT_SECRET must be at least ${MIN_SECRET_LEN} characters. Generate one with: openssl rand -hex 32`,
      );
    }
    const refreshEnv = (process.env.JWT_REFRESH_SECRET || '').trim();
    let jwtRefreshSecret: string;
    if (refreshEnv) {
      if (refreshEnv.length < MIN_SECRET_LEN) {
        throw new Error(`[auth] JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
      }
      if (refreshEnv === primary) {
        throw new Error('[auth] JWT_SECRET and JWT_REFRESH_SECRET must be different values.');
      }
      jwtRefreshSecret = refreshEnv;
    } else {
      // Derive a distinct refresh key so a single managed secret suffices.
      jwtRefreshSecret = deriveRefreshSecret(primary);
    }
    return { jwtSecret: primary, jwtRefreshSecret, secretSource: 'env' };
  }

  // No JWT_SECRET → self-managed persisted/generated secrets.
  const file = secretsFilePath();
  const existing = readSecretsFile(file);
  if (existing) {
    return { jwtSecret: existing.jwtSecret, jwtRefreshSecret: existing.jwtRefreshSecret, secretSource: 'file' };
  }
  const fresh = generateAndPersist(file);
  console.log(`[auth] no JWT_SECRET set — generated and persisted signing secrets → ${file}`);
  return { jwtSecret: fresh.jwtSecret, jwtRefreshSecret: fresh.jwtRefreshSecret, secretSource: 'generated' };
}

export function getAuthConfig(): AuthConfig {
  if (cached) return cached;

  const { jwtSecret, jwtRefreshSecret, secretSource } = resolveSecrets();
  const rounds = parseInt(process.env.AUTH_BCRYPT_ROUNDS || '12', 10);
  const provider = (process.env.AUTH_EMAIL_PROVIDER || 'console').toLowerCase();

  cached = {
    jwtSecret,
    jwtRefreshSecret,
    issuer: ISSUER,
    secretSource,
    accessTokenExpiry: process.env.AUTH_ACCESS_TOKEN_EXPIRY || '15m',
    refreshTokenExpiry: process.env.AUTH_REFRESH_TOKEN_EXPIRY || '7d',
    refreshTokenTtlMs: 7 * 24 * 60 * 60 * 1000, // 7d — keep in sync with the string above
    bcryptRounds: Number.isFinite(rounds) && rounds >= 10 && rounds <= 15 ? rounds : 12,
    appBaseUrl: (process.env.AUTH_APP_BASE_URL || 'https://www.theundergroundrailroad.world/dina').replace(/\/+$/, ''),
    emailProvider: provider === 'resend' ? 'resend' : 'console',
    resendApiKey: process.env.RESEND_API_KEY || '',
    emailFrom: process.env.AUTH_EMAIL_FROM || 'DINA <no-reply@theundergroundrailroad.world>',
  };
  return cached;
}

/** Test-only: reset the cache so a new env/file can be picked up. */
export function _resetAuthConfigCache(): void {
  cached = null;
}
