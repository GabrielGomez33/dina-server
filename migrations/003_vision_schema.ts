// File: migrations/003_vision_schema.ts
// ============================================================================
// MIGRATION 003 — DINA Vision (DIVIS) schema
// ============================================================================
// NOTE: numbered 003 because migration 002 is owned by DIGIM
// (002_digim_relationship_graph.ts). Migration ids must be unique — the runner
// rejects duplicates — so the Vision schema takes the next free id.
// ============================================================================
//
// Creates the two tables the Vision subsystem uses to persist analysed media
// and their structured results:
//
//   • vision_media    — one row per unique piece of media (dedup by sha256 +
//                       media_type). Holds intrinsic facts (mime, bytes, dims,
//                       frame count) but never the pixels themselves.
//   • vision_analysis — one row per analysis run (task + model), FK to media
//                       with ON DELETE CASCADE, holding the structured JSON
//                       result + a denormalised caption/confidence for querying.
//
// These are the SAME definitions the running app creates on boot in
// visionStore.initSchema() (following the DIGIM "module owns its tables"
// pattern). Running this migration provisions the schema WITHOUT needing to
// boot the server with DINA_VISION_ENABLED=true — useful for DB-first deploys.
//
// Idempotent: guarded by tableExists, so re-running is a no-op. If the app has
// already created the tables, this migration simply skips them.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists } from './helpers';

const VISION_MEDIA_SQL = `CREATE TABLE IF NOT EXISTS vision_media (
  id VARCHAR(36) PRIMARY KEY,
  sha256 CHAR(64) NOT NULL,
  media_type ENUM('image','video') NOT NULL,
  mime_type VARCHAR(64),
  byte_length BIGINT UNSIGNED,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  frame_count INT UNSIGNED NULL,
  user_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vision_media_sha (sha256, media_type),
  INDEX idx_vision_media_user (user_id, created_at),
  INDEX idx_vision_media_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const VISION_ANALYSIS_SQL = `CREATE TABLE IF NOT EXISTS vision_analysis (
  id VARCHAR(36) PRIMARY KEY,
  media_id VARCHAR(36) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  media_type ENUM('image','video') NOT NULL,
  task VARCHAR(32) NOT NULL,
  model VARCHAR(100),
  caption MEDIUMTEXT,
  result_json LONGTEXT NOT NULL,
  confidence DECIMAL(5,4) DEFAULT 0.0000,
  processing_time_ms INT UNSIGNED,
  user_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vision_analysis_media (media_id),
  INDEX idx_vision_analysis_sha_task (sha256, task),
  INDEX idx_vision_analysis_user (user_id, created_at),
  INDEX idx_vision_analysis_created (created_at),
  CONSTRAINT fk_vision_analysis_media FOREIGN KEY (media_id)
    REFERENCES vision_media(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const migration: Migration = {
  id: 3,
  name: 'vision_schema',

  async up(conn: Connection): Promise<void> {
    if (!(await tableExists(conn, 'vision_media'))) {
      await conn.query(VISION_MEDIA_SQL);
      console.log('   ✅ created vision_media');
    } else {
      console.log('   ℹ️ vision_media already exists — skipping');
    }

    if (!(await tableExists(conn, 'vision_analysis'))) {
      await conn.query(VISION_ANALYSIS_SQL);
      console.log('   ✅ created vision_analysis');
    } else {
      console.log('   ℹ️ vision_analysis already exists — skipping');
    }
  },

  async down(conn: Connection): Promise<void> {
    // Drop analysis first (it FKs media). Guarded so re-running is safe.
    if (await tableExists(conn, 'vision_analysis')) {
      await conn.query('DROP TABLE `vision_analysis`');
      console.log('   ↩️ dropped vision_analysis');
    }
    if (await tableExists(conn, 'vision_media')) {
      await conn.query('DROP TABLE `vision_media`');
      console.log('   ↩️ dropped vision_media');
    }
  },
};

export default migration;
