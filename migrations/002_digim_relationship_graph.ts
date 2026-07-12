// File: migrations/002_digim_relationship_graph.ts
// ============================================================================
// MIGRATION 002 — DIGIM RELATIONSHIP GRAPH (Phase 2.4b data model)
// ============================================================================
// ONE canonical graph that feeds all three views (network / temporal / semantic):
//
//   digim_entities              nodes — people/orgs/places/EVENTS/concepts.
//                               `occurred_at` (nullable) makes events first-class
//                               on a time axis; `mention_count` = node weight;
//                               `embedding_ref` = link to its vector (semantic view).
//   digim_relationships         edges — subject —predicate→ object, with
//                               corroboration_count (weight) + confidence.
//   digim_relationship_sources  provenance — which source asserted each edge
//                               (drives corroboration).
//
// Idempotent: CREATE TABLE IF NOT EXISTS + a tableExists guard for clean logging.
// MySQL DDL auto-commits, so each statement stands alone. ROW_FORMAT=DYNAMIC so
// the wide unique keys stay under the index-length limit.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists } from './helpers';

async function createTable(conn: Connection, name: string, ddl: string): Promise<void> {
  if (await tableExists(conn, name)) {
    console.log(`   ℹ️ ${name} already exists — skipping`);
    return;
  }
  await conn.query(ddl);
  console.log(`   ✅ created ${name}`);
}

const migration: Migration = {
  id: 2,
  name: 'digim_relationship_graph',

  async up(conn: Connection): Promise<void> {
    await createTable(conn, 'digim_entities', `
      CREATE TABLE IF NOT EXISTS digim_entities (
        id CHAR(36) NOT NULL,
        canonical_key VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        type ENUM('person','organization','location','event','technology','concept','other') NOT NULL DEFAULT 'other',
        occurred_at DATETIME NULL DEFAULT NULL,
        mention_count INT UNSIGNED NOT NULL DEFAULT 1,
        embedding_ref VARCHAR(128) NULL DEFAULT NULL,
        first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_entity_canonical (canonical_key),
        KEY idx_entity_type (type),
        KEY idx_entity_occurred (occurred_at),
        KEY idx_entity_mentions (mention_count)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
    `);

    await createTable(conn, 'digim_relationships', `
      CREATE TABLE IF NOT EXISTS digim_relationships (
        id CHAR(36) NOT NULL,
        subject_id CHAR(36) NOT NULL,
        predicate VARCHAR(120) NOT NULL,
        object_id CHAR(36) NOT NULL,
        corroboration_count INT UNSIGNED NOT NULL DEFAULT 1,
        confidence DECIMAL(4,3) NOT NULL DEFAULT 0.500,
        occurred_at DATETIME NULL DEFAULT NULL,
        first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_edge (subject_id, predicate, object_id),
        KEY idx_edge_subject (subject_id),
        KEY idx_edge_object (object_id),
        KEY idx_edge_occurred (occurred_at),
        CONSTRAINT fk_rel_subject FOREIGN KEY (subject_id) REFERENCES digim_entities(id) ON DELETE CASCADE,
        CONSTRAINT fk_rel_object FOREIGN KEY (object_id) REFERENCES digim_entities(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
    `);

    await createTable(conn, 'digim_relationship_sources', `
      CREATE TABLE IF NOT EXISTS digim_relationship_sources (
        id CHAR(36) NOT NULL,
        relationship_id CHAR(36) NOT NULL,
        source_url VARCHAR(1024) NOT NULL,
        source_content_id CHAR(36) NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_rel_source (relationship_id, source_url(191)),
        KEY idx_rel_source_rel (relationship_id),
        CONSTRAINT fk_relsrc_rel FOREIGN KEY (relationship_id) REFERENCES digim_relationships(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
    `);
  },

  async down(conn: Connection): Promise<void> {
    // Drop in FK-dependency order (children first).
    await conn.query('DROP TABLE IF EXISTS digim_relationship_sources');
    console.log('   ✅ dropped digim_relationship_sources');
    await conn.query('DROP TABLE IF EXISTS digim_relationships');
    console.log('   ✅ dropped digim_relationships');
    await conn.query('DROP TABLE IF EXISTS digim_entities');
    console.log('   ✅ dropped digim_entities');
  },
};

export default migration;
