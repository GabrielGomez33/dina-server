// File: src/modules/auth/config.ts
// ============================================================================
// DINA AUTH — CONFIGURATION (env-driven, validated once at load)
// ============================================================================
// Centralises every auth-related environment variable behind a typed accessor
// so the rest of the module never touches process.env directly. Secrets are
// resolved lazily and validated the first time auth is used, so importing the
// module never crashes a boot that doesn't need auth — but the first real auth
// call fails loudly and clearly if a secret is missing.
// ============================================================================

export interface AuthConfig {
  jwtSecret: string;
  jwtRefreshSecret: string;
  accessTokenExpiry: string; // e.g. '15m'
  refreshTokenExpiry: string; // e.g. '7d'
  refreshTokenTtlMs: number; // numeric mirror of refreshTokenExpiry for session rows
  bcryptRounds: number;
  // Absolute base URL of the DINA frontend, used to build verify/reset links.
  appBaseUrl: string;
  // Email delivery
  emailProvider: 'resend' | 'console';
  resendApiKey: string;
  emailFrom: string;
}

let cached: AuthConfig | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `[auth] Missing required environment variable ${name}. ` +
        `Set it in the DINA server .env (see .env.example) before using authentication.`,
    );
  }
  return v.trim();
}

/**
 * Resolve and validate auth config. Cached after first success. Throws a clear
 * error if a required secret is absent — call this at the top of any auth entry
 * point so misconfiguration surfaces as a 500 with a precise message, never as
 * a silently-insecure token signed with `undefined`.
 */
export function getAuthConfig(): AuthConfig {
  if (cached) return cached;

  const jwtSecret = requireEnv('JWT_SECRET');
  const jwtRefreshSecret = requireEnv('JWT_REFRESH_SECRET');
  if (jwtSecret === jwtRefreshSecret) {
    throw new Error('[auth] JWT_SECRET and JWT_REFRESH_SECRET must be different values.');
  }
  if (jwtSecret.length < 32 || jwtRefreshSecret.length < 32) {
    throw new Error('[auth] JWT secrets must be at least 32 characters. Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  }

  const rounds = parseInt(process.env.AUTH_BCRYPT_ROUNDS || '12', 10);
  const provider = (process.env.AUTH_EMAIL_PROVIDER || 'console').toLowerCase();

  cached = {
    jwtSecret,
    jwtRefreshSecret,
    accessTokenExpiry: process.env.AUTH_ACCESS_TOKEN_EXPIRY || '15m',
    refreshTokenExpiry: process.env.AUTH_REFRESH_TOKEN_EXPIRY || '7d',
    refreshTokenTtlMs: 7 * 24 * 60 * 60 * 1000, // 7d — keep in sync with above
    bcryptRounds: Number.isFinite(rounds) && rounds >= 10 && rounds <= 15 ? rounds : 12,
    appBaseUrl: (process.env.AUTH_APP_BASE_URL || 'https://www.theundergroundrailroad.world/dina').replace(/\/+$/, ''),
    emailProvider: provider === 'resend' ? 'resend' : 'console',
    resendApiKey: process.env.RESEND_API_KEY || '',
    emailFrom: process.env.AUTH_EMAIL_FROM || 'DINA <no-reply@theundergroundrailroad.world>',
  };
  return cached;
}

/** Test-only: reset the cache so a new env can be picked up. */
export function _resetAuthConfigCache(): void {
  cached = null;
}
