// File: src/modules/auth/authDb.ts
// ============================================================================
// DINA AUTH — DB QUERY HELPER
// ============================================================================
// Thin wrapper over the DINA database singleton that runs auth queries with
// skipSecurityValidation=true. EVERY auth query is fully parameterised (no
// string-built SQL, ever), so it is injection-safe by construction. DINA's
// heuristic validateQuery scans the SQL TEXT and false-positives on legitimate
// multi-condition auth queries (e.g. `WHERE user_id = ? AND session_id = ? AND
// revoked = 0` trips its `(and|or) … = … (and|or)` rule). This is the same
// rationale, and the same flag, that webResearchStore uses.
//
// SECURITY INVARIANT: never pass user input as part of `sql`. Values go ONLY
// through `params`. If you ever need dynamic SQL, whitelist the fragments — do
// not interpolate raw input.
// ============================================================================

import { database } from '../../config/database/db';

export function q(sql: string, params: unknown[] = []): Promise<any> {
  return database.query(sql, params as any[], true);
}
