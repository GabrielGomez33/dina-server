// File: migrations/001_digim_content_web_ready.ts
// ============================================================================
// MIGRATION 001 — Make digim_content web-research ready
// ============================================================================
//
// FOUNDATIONAL CORRECTIONS (DIGIM is not yet in production use, so now is the
// right time):
//
//   1. `source_id` was NOT NULL with a CASCADE foreign key. Ad-hoc web-gathered
//      documents don't belong to a configured feed, which forced an awkward
//      "system source" placeholder. We make `source_id` NULLABLE and switch the
//      FK to ON DELETE SET NULL, so a web document can stand on its own and
//      deleting a source no longer deletes its harvested content.
//
//   2. Add embedding-tracking columns so Phase 1 (semantic memory) can record
//      which content has been embedded into the Redis vector index, with what
//      model, and when — without storing the raw vector in MySQL (Redis is the
//      vector store; MySQL is the source of truth + bookkeeping).
//
// Idempotent: every step checks current state first (see ./helpers), so this is
// safe to run repeatedly. If the table doesn't exist yet, the running app will
// create it already-corrected (see digim/index.ts initializeDatabaseSchemas);
// this migration then becomes a no-op.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import {
  tableExists,
  columnExists,
  columnNullability,
  foreignKeysOnColumn,
  foreignKeyExists,
  addColumnIfMissing,
  addIndexIfMissing,
} from './helpers';

const FK_NAME = 'fk_digim_content_source';

const migration: Migration = {
  id: 1,
  name: 'digim_content_web_ready',

  async up(conn: Connection): Promise<void> {
    if (!(await tableExists(conn, 'digim_content'))) {
      console.log('   ℹ️ digim_content does not exist yet — the app will create it already-corrected on next boot. Skipping.');
      return;
    }

    // 1. Embedding-tracking columns (Phase 1 semantic memory bookkeeping).
    if (await addColumnIfMissing(
      conn, 'digim_content', 'embedding_status',
      `embedding_status ENUM('pending','embedded','failed','skipped') NOT NULL DEFAULT 'pending'`
    )) console.log('   ✅ added digim_content.embedding_status');

    if (await addColumnIfMissing(
      conn, 'digim_content', 'embedded_at', `embedded_at TIMESTAMP NULL`
    )) console.log('   ✅ added digim_content.embedded_at');

    if (await addColumnIfMissing(
      conn, 'digim_content', 'embedding_model', `embedding_model VARCHAR(100) NULL`
    )) console.log('   ✅ added digim_content.embedding_model');

    if (await addColumnIfMissing(
      conn, 'digim_content', 'embedding_ref', `embedding_ref VARCHAR(128) NULL`
    )) console.log('   ✅ added digim_content.embedding_ref (Redis vector id)');

    if (await addIndexIfMissing(
      conn, 'digim_content', 'idx_embedding_status', 'embedding_status, gathered_at'
    )) console.log('   ✅ added index idx_embedding_status');

    // 2. Make source_id nullable + FK ON DELETE SET NULL.
    if (await columnExists(conn, 'digim_content', 'source_id')) {
      // Drop any pre-existing FKs on source_id that aren't our named one
      // (the original schema used an auto-named CASCADE FK).
      const fks = await foreignKeysOnColumn(conn, 'digim_content', 'source_id');
      for (const fk of fks) {
        if (fk !== FK_NAME) {
          await conn.query(`ALTER TABLE \`digim_content\` DROP FOREIGN KEY \`${fk}\``);
          console.log(`   ✅ dropped legacy FK ${fk}`);
        }
      }

      if ((await columnNullability(conn, 'digim_content', 'source_id')) === 'NO') {
        await conn.query(`ALTER TABLE \`digim_content\` MODIFY COLUMN source_id VARCHAR(36) NULL`);
        console.log('   ✅ digim_content.source_id is now NULLABLE');
      }

      if (!(await foreignKeyExists(conn, 'digim_content', FK_NAME))) {
        // Only add if the referenced table exists.
        if (await tableExists(conn, 'digim_sources')) {
          await conn.query(
            `ALTER TABLE \`digim_content\`
               ADD CONSTRAINT \`${FK_NAME}\` FOREIGN KEY (source_id)
               REFERENCES digim_sources(id) ON DELETE SET NULL`
          );
          console.log(`   ✅ added FK ${FK_NAME} (ON DELETE SET NULL)`);
        } else {
          console.log('   ⚠️ digim_sources missing — skipped FK re-creation (app boot will handle it).');
        }
      }
    }
  },

  async down(conn: Connection): Promise<void> {
    // Reverse only the additive, safe parts. We intentionally do NOT revert
    // source_id back to NOT NULL — existing rows may hold NULLs and reverting
    // could fail/lose data. Nullability relaxation is forward-only by design.
    if (!(await tableExists(conn, 'digim_content'))) return;

    for (const col of ['embedding_ref', 'embedding_model', 'embedded_at', 'embedding_status']) {
      if (await columnExists(conn, 'digim_content', col)) {
        await conn.query(`ALTER TABLE \`digim_content\` DROP COLUMN \`${col}\``);
        console.log(`   ↩️ dropped digim_content.${col}`);
      }
    }
  },
};

export default migration;
