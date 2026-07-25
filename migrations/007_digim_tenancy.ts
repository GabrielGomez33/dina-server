// File: migrations/007_digim_tenancy.ts
// ============================================================================
// DIGIM — PER-USER TENANCY + PER-RESEARCH ISLANDS
// ============================================================================
// Adds ownership + research scoping to the DIGIM data model so (a) a user only
// ever sees their own research/graph/embeddings, and (b) each research is an
// isolated "island" — entities from one research no longer bleed into another.
//
//   owner_id    VARCHAR(36)  — FK-by-convention to users.id (the console account)
//   research_id VARCHAR(36)  — the digim_intelligence.id that produced the row
//   visibility  ENUM         — on digim_intelligence, for future sharing
//
// Entity uniqueness changes from GLOBAL `canonical_key` to
// `(owner_id, research_id, canonical_key)` — the structural fix for bleeding:
// each (user, research) gets its OWN "Iran" node instead of one shared global one.
//
// Idempotent + additive (addColumnIfMissing, guarded index swaps). Tables created
// by the app at boot (digim_content, digim_intelligence) are also updated in
// src/modules/digim/index.ts so a fresh DB gets these columns directly; here we
// ALTER them for existing installs. Every step is guarded by tableExists, so on a
// fresh DB where `migrate` runs before the app boots, the app-created tables are
// simply skipped (they'll be created already-correct).
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists, columnExists, indexExists, addColumnIfMissing } from './helpers';

async function addOwnerCols(conn: Connection, table: string, withResearch = true): Promise<void> {
  if (!(await tableExists(conn, table))) {
    console.log(`   • ${table} absent — skipping (created already-correct by app/earlier migration)`);
    return;
  }
  if (await addColumnIfMissing(conn, table, 'owner_id', 'owner_id VARCHAR(36) NULL DEFAULT NULL')) {
    console.log(`   ✓ ${table}.owner_id added`);
  }
  if (withResearch && (await addColumnIfMissing(conn, table, 'research_id', 'research_id VARCHAR(36) NULL DEFAULT NULL'))) {
    console.log(`   ✓ ${table}.research_id added`);
  }
  // Composite index for owner/island scoping (non-unique).
  const idx = `idx_${table.replace(/^digim_/, '')}_owner`;
  if (!(await indexExists(conn, table, idx))) {
    const cols = withResearch ? '(owner_id, research_id)' : '(owner_id)';
    await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${idx}\` ${cols}`);
    console.log(`   ✓ ${table}.${idx} added`);
  }
}

const migration: Migration = {
  id: 7,
  name: 'digim_tenancy',

  async up(conn: Connection): Promise<void> {
    // ── content / relationships / sources: owner + research scoping ─────────
    await addOwnerCols(conn, 'digim_content');
    await addOwnerCols(conn, 'digim_relationships');
    await addOwnerCols(conn, 'digim_relationship_sources');

    // digim_content dedups by content_hash. Globally-unique content_hash would
    // let a second research reference the FIRST owner's row (cross-tenant leak),
    // so make dedup per-(owner, research): each research keeps its own copy of a
    // gathered doc. Drop the inline global UNIQUE, keep a plain lookup index, add
    // the composite UNIQUE. Guarded/idempotent.
    if (await tableExists(conn, 'digim_content')) {
      // The inline `content_hash VARCHAR(64) UNIQUE` created a unique index named
      // `content_hash`. Drop it only if it is UNIQUE (non_unique = 0).
      const [uniqRows] = await conn.query(
        `SELECT index_name FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'digim_content'
           AND column_name = 'content_hash' AND non_unique = 0`,
      );
      for (const r of uniqRows as Array<Record<string, any>>) {
        const name = String(Object.values(r)[0]);
        if (name && name !== 'uq_content_owner_research_hash') {
          await conn.query(`ALTER TABLE \`digim_content\` DROP INDEX \`${name}\``);
          console.log(`   ✓ dropped global unique index ${name} on digim_content.content_hash`);
        }
      }
      if (!(await indexExists(conn, 'digim_content', 'idx_content_hash'))) {
        await conn.query('ALTER TABLE `digim_content` ADD INDEX `idx_content_hash` (content_hash)');
        console.log('   ✓ added idx_content_hash (lookup)');
      }
      if (!(await indexExists(conn, 'digim_content', 'uq_content_owner_research_hash'))) {
        await conn.query(
          'ALTER TABLE `digim_content` ADD UNIQUE KEY `uq_content_owner_research_hash` (owner_id, research_id, content_hash)',
        );
        console.log('   ✓ added uq_content_owner_research_hash (owner_id, research_id, content_hash)');
      }
    }

    // ── digim_intelligence: it already has user_id (the owner). Add visibility.
    if (await tableExists(conn, 'digim_intelligence')) {
      if (
        await addColumnIfMissing(
          conn,
          'digim_intelligence',
          'visibility',
          "visibility ENUM('private','shared') NOT NULL DEFAULT 'private'",
        )
      ) {
        console.log('   ✓ digim_intelligence.visibility added');
      }
    } else {
      console.log('   • digim_intelligence absent — skipping (app creates it already-correct)');
    }

    // ── digim_entities: owner + research + uniqueness swap ───────────────────
    if (await tableExists(conn, 'digim_entities')) {
      if (await addColumnIfMissing(conn, 'digim_entities', 'owner_id', 'owner_id VARCHAR(36) NULL DEFAULT NULL')) {
        console.log('   ✓ digim_entities.owner_id added');
      }
      if (await addColumnIfMissing(conn, 'digim_entities', 'research_id', 'research_id VARCHAR(36) NULL DEFAULT NULL')) {
        console.log('   ✓ digim_entities.research_id added');
      }
      // Swap the GLOBAL canonical uniqueness for a per-(owner,research) one.
      // Safe because legacy data is purged before this runs (hard-delete choice),
      // so no existing rows can collide on the new key.
      if (await indexExists(conn, 'digim_entities', 'uq_entity_canonical')) {
        await conn.query('ALTER TABLE `digim_entities` DROP INDEX `uq_entity_canonical`');
        console.log('   ✓ dropped global uq_entity_canonical');
      }
      if (!(await indexExists(conn, 'digim_entities', 'uq_entity_owner_research_key'))) {
        await conn.query(
          'ALTER TABLE `digim_entities` ADD UNIQUE KEY `uq_entity_owner_research_key` (owner_id, research_id, canonical_key)',
        );
        console.log('   ✓ added uq_entity_owner_research_key (owner_id, research_id, canonical_key)');
      }
      // Keep a plain lookup index on canonical_key for name searches.
      if (!(await indexExists(conn, 'digim_entities', 'idx_entity_canonical'))) {
        await conn.query('ALTER TABLE `digim_entities` ADD INDEX `idx_entity_canonical` (canonical_key)');
        console.log('   ✓ added idx_entity_canonical');
      }
    } else {
      console.log('   • digim_entities absent — skipping (earlier migration creates it)');
    }

    // Sanity note for operators.
    if (await columnExists(conn, 'digim_entities', 'owner_id')) {
      console.log('   ↳ tenancy columns in place. Untagged (owner_id NULL) rows are invisible to all users on read.');
    }
  },

  // Additive; down() is a guarded no-op (owner columns now scope live data, and
  // reverting uniqueness could allow duplicate keys). Manual only.
  async down(_conn: Connection): Promise<void> {
    console.log('   ⚠ down() is a no-op for 007_digim_tenancy (scopes live data; reverting risks duplicates).');
  },
};

export default migration;
