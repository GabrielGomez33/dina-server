// File: src/modules/auth/index.ts
// ============================================================================
// DINA AUTH — public surface
// ============================================================================
// The auth module owns user identity for the DINA console against the SHARED
// `users` table (see migrations/004_auth_users.ts and userStore.ts). Import from
// here rather than reaching into individual files.
// ============================================================================

export { registerAuthRoutes } from './authRoutes';
export { requireAuth, optionalAuth, bearerToken } from './requireAuth';
export type { AuthedRequest } from './requireAuth';
export { cleanExpiredSessions } from './sessionStore';
export { getAuthConfig } from './config';
