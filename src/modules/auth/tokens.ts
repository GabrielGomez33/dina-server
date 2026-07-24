// File: src/modules/auth/tokens.ts
// ============================================================================
// DINA AUTH — TOKEN MANAGER (JWT access + refresh, session ids)
// ============================================================================
// Two-token model, ported from mirror-server:
//   - access token  (short-lived, 15m): carries user identity + sessionId, sent
//     on every request as `Authorization: Bearer`. Signed with JWT_SECRET.
//   - refresh token (long-lived, 7d): carries only {id, sessionId}, exchanged at
//     /auth/refresh for a fresh access token. Signed with a SEPARATE
//     JWT_REFRESH_SECRET so a leaked access secret can't mint refresh tokens.
// The sessionId ties both tokens to a revocable row in `user_sessions`, so a
// logout (or logout-all) invalidates tokens immediately regardless of expiry.
// ============================================================================

import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { getAuthConfig } from './config';

// NOTE: `id` is DINA's user id — a VARCHAR(36) UUID string, not a number.
export interface AccessPayload {
  id: string;
  email: string;
  username: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

export interface RefreshPayload {
  id: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

/** 256-bit random session id (hex). One per device login. */
export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createAccessToken(payload: Omit<AccessPayload, 'iat' | 'exp'>): string {
  const cfg = getAuthConfig();
  const opts: SignOptions = {
    expiresIn: cfg.accessTokenExpiry as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: cfg.issuer, // `iss` scopes the token to DINA
  };
  return jwt.sign(payload, cfg.jwtSecret, opts);
}

export function createRefreshToken(payload: Omit<RefreshPayload, 'iat' | 'exp'>): string {
  const cfg = getAuthConfig();
  const opts: SignOptions = {
    expiresIn: cfg.refreshTokenExpiry as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: cfg.issuer,
  };
  return jwt.sign(payload, cfg.jwtRefreshSecret, opts);
}

/** Verify an access token. Throws on invalid/expired/wrong-issuer — callers map
 *  to 401. Pinning the issuer means a token minted by a different service (even
 *  one that somehow shared our secret) is rejected. */
export function verifyAccessToken(token: string): AccessPayload {
  const cfg = getAuthConfig();
  return jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'], issuer: cfg.issuer }) as AccessPayload;
}

/** Verify a refresh token. Throws on invalid/expired/wrong-issuer — callers map to 401. */
export function verifyRefreshToken(token: string): RefreshPayload {
  const cfg = getAuthConfig();
  return jwt.verify(token, cfg.jwtRefreshSecret, { algorithms: ['HS256'], issuer: cfg.issuer }) as RefreshPayload;
}
