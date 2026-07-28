// File: migrations/009_graph_temporal_sort.ts
// ============================================================================
// DIGIM — DEEP-TIME TIMELINE COLUMNS (sortable across all of history)
// ============================================================================
// The knowledge graph must place events on a timeline that spans ALL of history,
// not just the MySQL DATETIME window (1000–9999 CE). A human-species / deep-
// history graph carries dates like "300,000 years ago", "10,000 BCE", "3200 BC",
// or "18th century" — none of which fit a DATETIME column, so `occurred_at` was
// silently NULL for exactly the events a timeline most needs.
//
// This adds two ADDITIVE, nullable columns to BOTH graph tables:
//
//   occurred_sort  DOUBLE      NULL — signed decimal year (CE positive, BCE /
//                                     prehistoric negative). "3200 BCE" → -3200,
//                                     "300,000 years ago" → ~-297975, "1990" →
//                                     1990. The timeline axis sorts/positions by
//                                     THIS, so it is unbounded either direction.
//   occurred_label VARCHAR(160) NULL — clean human string for display
//                                     ("300,000 years ago", "3200 BCE").
//
// `occurred_at` (DATETIME) is KEPT and still populated for in-range CE dates, so
// nothing that already works regresses; out-of-range events now carry a real
// sort/label instead of being dropped. Populated going forward by
// graphStore.normalizeTemporal (parseTemporal). Run digim:backfill-graph to
// re-extract existing islands so old graphs gain sort/label too.
//
// Purely additive + idempotent. The graph tables are created by migration 002;
// this migration runs after it (id-ordered), so a fresh DB gets the base tables
// then these columns, and an existing install gets them ALTERed in — both paths
// converge. Indexes occurred_sort for fast timeline ordering.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists, addColumnIfMissing, addIndexIfMissing } from './helpers';

const TABLES = ['digim_entities', 'digim_relationships'] as const;

const migration: Migration = {
  id: 9,
  name: 'graph_temporal_sort',
  async up(conn: Connection): Promise<void> {
    for (const table of TABLES) {
      if (!(await tableExists(conn, table))) {
        console.log(`   • ${table} absent — skipping (created already-correct by app)`);
        continue;
      }
      if (await addColumnIfMissing(conn, table, 'occurred_sort', 'occurred_sort DOUBLE NULL DEFAULT NULL')) {
        console.log(`   ✓ ${table}.occurred_sort added`);
      } else {
        console.log(`   • ${table}.occurred_sort already present`);
      }
      if (await addColumnIfMissing(conn, table, 'occurred_label', 'occurred_label VARCHAR(160) NULL DEFAULT NULL')) {
        console.log(`   ✓ ${table}.occurred_label added`);
      } else {
        console.log(`   • ${table}.occurred_label already present`);
      }
      // Timeline ordering is owner+research scoped, then sorted by occurred_sort.
      if (await addIndexIfMissing(conn, table, 'idx_occurred_sort', 'owner_id, research_id, occurred_sort')) {
        console.log(`   ✓ ${table}.idx_occurred_sort added`);
      }
    }
  },
  async down(): Promise<void> {
    // Irreversible-by-choice: additive nullable columns are safe to leave in
    // place; dropping them would discard recovered deep-time positions.
  },
};

export default migration;
