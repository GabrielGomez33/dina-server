// File: migrations/008_intelligence_parent.ts
// ============================================================================
// DIGIM — INVESTIGATION PARENT LINK (multi-facet grouping)
// ============================================================================
// A multi-facet `investigate` decomposes one broad question into several sub-
// researches ("facets"), each stored as its own digim_intelligence row. Until
// now those facets were siblings with no link back to the investigation, so the
// console listed them as unrelated top-level items.
//
// This adds:
//   parent_id VARCHAR(36) NULL — the digim_intelligence.id of the investigation
//                                this row is a facet of. NULL = a standalone
//                                research or an investigation ROOT (the fused
//                                briefing). Facets point at the root's id.
//
// The frontend uses parent_id to nest facets under their investigation as a
// collapsible tree. Purely additive + idempotent; existing rows keep parent_id
// NULL and remain standalone. The app also adds this column to the
// digim_intelligence CREATE (src/modules/digim/index.ts) so a fresh DB gets it
// directly; here we ALTER it in for existing installs.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists, addColumnIfMissing, addIndexIfMissing } from './helpers';

const migration: Migration = {
  id: 8,
  name: 'intelligence_parent_link',
  async up(conn: Connection): Promise<void> {
    if (!(await tableExists(conn, 'digim_intelligence'))) {
      console.log('   • digim_intelligence absent — skipping (created already-correct by app)');
      return;
    }
    if (await addColumnIfMissing(conn, 'digim_intelligence', 'parent_id', 'parent_id VARCHAR(36) NULL DEFAULT NULL')) {
      console.log('   ✓ digim_intelligence.parent_id added');
    } else {
      console.log('   • digim_intelligence.parent_id already present');
    }
    // Index to fetch an investigation's facets and to group history efficiently.
    if (await addIndexIfMissing(conn, 'digim_intelligence', 'idx_parent', 'parent_id')) {
      console.log('   ✓ idx_parent added');
    }
  },
  async down(): Promise<void> {
    // Irreversible-by-choice: dropping parent_id would orphan the grouping.
    // Additive columns are safe to leave in place.
  },
};

export default migration;
