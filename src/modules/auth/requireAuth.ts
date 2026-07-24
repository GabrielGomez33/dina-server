// File: src/modules/auth/requireAuth.ts
// ============================================================================
// DINA AUTH — requireAuth MIDDLEWARE
// ============================================================================
// Protects user-facing endpoints. Two gates, both must pass:
//   1. A valid, unexpired access token in `Authorization: Bearer <jwt>`.
//   2. The token's sessionId still maps to a live (unexpired, non-revoked) row
//      in user_sessions — so logout/logout-all take effect immediately, before
//      the JWT would naturally expire.
// On success it attaches `req.authUser` for handlers to use. This is DISTINCT
// from DINA's service-level `authenticate` middleware (trust levels / service
// keys); this one is about human end-users of the DINA console.
// ============================================================================

import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, AccessPayload } from './tokens';
import { validateSession } from './sessionStore';

export interface AuthedRequest extends Request {
  authUser?: {
    id: string; // VARCHAR(36) UUID
    email: string;
    username: string;
    sessionId: string;
  };
}

/** Extract a bearer token from the Authorization header, else null. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export const requireAuth = async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_TOKEN' });
    return;
  }

  let payload: AccessPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.', code: 'INVALID_TOKEN' });
    return;
  }

  if (!payload?.id || !payload?.sessionId) {
    res.status(401).json({ error: 'Malformed token.', code: 'INVALID_TOKEN' });
    return;
  }

  try {
    const live = await validateSession(payload.id, payload.sessionId);
    if (!live) {
      res.status(401).json({ error: 'Session expired or revoked.', code: 'INVALID_SESSION' });
      return;
    }
  } catch (err) {
    // A DB hiccup must NOT be treated as "authenticated" — fail closed.
    console.error('[auth] session validation error:', err instanceof Error ? err.message : err);
    res.status(503).json({ error: 'Auth backend unavailable.', code: 'AUTH_UNAVAILABLE' });
    return;
  }

  req.authUser = {
    id: payload.id,
    email: payload.email,
    username: payload.username,
    sessionId: payload.sessionId,
  };
  next();
};

/** Soft variant: attaches req.authUser when a valid session is present but never
 *  blocks. Useful for endpoints that personalise when logged in but stay public. */
export const optionalAuth = async (req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> => {
  const token = bearerToken(req);
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    if (payload?.id && payload?.sessionId && (await validateSession(payload.id, payload.sessionId))) {
      req.authUser = {
        id: payload.id,
        email: payload.email,
        username: payload.username,
        sessionId: payload.sessionId,
      };
    }
  } catch {
    /* ignore — optional */
  }
  next();
};
