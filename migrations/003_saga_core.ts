// File: migrations/003_saga_core.ts
// ============================================================================
// MIGRATION 003 — dina-saga core schema (multi-tenant image/video generation)
// ============================================================================
//
// Foundation tables for the saga module ("dina-saga"): multi-tenant from
// day one (users → memberships → tenants → projects), soft-delete everywhere
// (deleted_at), TTL-based pruning for heavy assets (ttl_expires_at), quota
// accounting (bytes_used), and generation lineage (parent_generation_id) so
// seed/prompt/LoRA reproducibility is a first-class record.
//
// CONVENTIONS (match the existing schema):
//   • VARCHAR(36) UUID PKs, InnoDB, utf8mb4_unicode_ci.
//   • user identity = dina_users.dina_key (VARCHAR(64)) — reuse, don't duplicate.
//   • CREATE TABLE IF NOT EXISTS → idempotent; safe to re-run (framework rule).
//   • Forward-only for destructive shapes; down() drops only what up() created.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists } from './helpers';

const TABLES: Array<{ name: string; ddl: string }> = [
  {
    name: 'saga_tenants',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_tenants (
        id            VARCHAR(36)  NOT NULL PRIMARY KEY,
        name          VARCHAR(120) NOT NULL,
        slug          VARCHAR(80)  NOT NULL,
        plan          ENUM('free','pro','admin') NOT NULL DEFAULT 'free',
        quota_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 107374182400, -- 100 GB default
        gpu_priority  TINYINT UNSIGNED NOT NULL DEFAULT 5,           -- 1-10, queue ordering hook
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at    TIMESTAMP NULL,                                -- soft delete (30d recovery)
        UNIQUE KEY uq_saga_tenants_slug (slug),
        KEY idx_saga_tenants_deleted (deleted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
  {
    name: 'saga_memberships',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_memberships (
        id          VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id   VARCHAR(36) NOT NULL,
        user_id     VARCHAR(64) NOT NULL,                            -- dina_users.dina_key
        role        ENUM('owner','editor','viewer') NOT NULL DEFAULT 'viewer',
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_saga_membership (tenant_id, user_id),
        KEY idx_saga_memberships_user (user_id),
        CONSTRAINT fk_saga_memberships_tenant FOREIGN KEY (tenant_id)
          REFERENCES saga_tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
  {
    name: 'saga_projects',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_projects (
        id             VARCHAR(36)  NOT NULL PRIMARY KEY,
        tenant_id      VARCHAR(36)  NOT NULL,
        slug           VARCHAR(80)  NOT NULL,
        owner_user_id  VARCHAR(64)  NOT NULL,
        status         ENUM('active','archived') NOT NULL DEFAULT 'active',
        bytes_used     BIGINT UNSIGNED NOT NULL DEFAULT 0,           -- quota accounting
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP NULL,                               -- soft delete
        UNIQUE KEY uq_saga_projects_slug (tenant_id, slug),       -- per-tenant slugs (no global collisions)
        KEY idx_saga_projects_tenant (tenant_id, deleted_at),
        CONSTRAINT fk_saga_projects_tenant FOREIGN KEY (tenant_id)
          REFERENCES saga_tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
  {
    name: 'saga_manifests',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_manifests (
        id           VARCHAR(36) NOT NULL PRIMARY KEY,
        project_id   VARCHAR(36) NOT NULL,
        version      INT UNSIGNED NOT NULL,
        status       ENUM('draft','frozen','retired') NOT NULL DEFAULT 'draft',
        manifest_json JSON NOT NULL,                                 -- refs, tags, loras, style config
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        frozen_at    TIMESTAMP NULL,
        UNIQUE KEY uq_saga_manifests_version (project_id, version),
        KEY idx_saga_manifests_status (project_id, status),
        CONSTRAINT fk_saga_manifests_project FOREIGN KEY (project_id)
          REFERENCES saga_projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
  {
    name: 'saga_audio_tracks',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_audio_tracks (
        id              VARCHAR(36)  NOT NULL PRIMARY KEY,
        project_id      VARCHAR(36)  NOT NULL,
        filename        VARCHAR(255) NOT NULL,
        storage_path    VARCHAR(512) NOT NULL,                       -- under /mnt/saga/tenants/...
        bytes           BIGINT UNSIGNED NOT NULL DEFAULT 0,
        analysis_status ENUM('pending','analyzing','complete','failed') NOT NULL DEFAULT 'pending',
        analysis_json   JSON NULL,                                   -- beats/lyrics/vocal segments (cached compute)
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at      TIMESTAMP NULL,
        KEY idx_saga_audio_project (project_id, deleted_at),
        CONSTRAINT fk_saga_audio_project FOREIGN KEY (project_id)
          REFERENCES saga_projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
  {
    name: 'saga_generations',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_generations (
        id                   VARCHAR(36) NOT NULL PRIMARY KEY,
        project_id           VARCHAR(36) NOT NULL,
        kind                 ENUM('image','video','music_video','lipsync','upscale') NOT NULL,
        status               ENUM('pending','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending',
        params_json          JSON NOT NULL,                          -- prompt, model, loras, controlnets, dims
        seed                 BIGINT NULL,                            -- reproducibility
        model                VARCHAR(120) NULL,
        parent_generation_id VARCHAR(36) NULL,                       -- lineage (re-rolls, chained shots)
        audio_track_id       VARCHAR(36) NULL,                       -- music-video source track
        storage_path         VARCHAR(512) NULL,
        bytes                BIGINT UNSIGNED NOT NULL DEFAULT 0,
        promoted             TINYINT(1) NOT NULL DEFAULT 0,          -- promoted → exports (TTL-immune)
        ttl_expires_at       TIMESTAMP NULL,                         -- janitor prune deadline
        created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at         TIMESTAMP NULL,
        deleted_at           TIMESTAMP NULL,
        KEY idx_saga_gen_project (project_id, kind, created_at),
        KEY idx_saga_gen_ttl (ttl_expires_at, promoted, deleted_at),
        KEY idx_saga_gen_parent (parent_generation_id),
        CONSTRAINT fk_saga_gen_project FOREIGN KEY (project_id)
          REFERENCES saga_projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_saga_gen_parent FOREIGN KEY (parent_generation_id)
          REFERENCES saga_generations(id) ON DELETE SET NULL,
        CONSTRAINT fk_saga_gen_audio FOREIGN KEY (audio_track_id)
          REFERENCES saga_audio_tracks(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
  {
    name: 'saga_jobs',
    ddl: `
      CREATE TABLE IF NOT EXISTS saga_jobs (
        id            VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id     VARCHAR(36) NOT NULL,
        project_id    VARCHAR(36) NOT NULL,
        generation_id VARCHAR(36) NULL,
        kind          ENUM('caption','lora_train','image_gen','video_gen','audio_analyze','lipsync','assemble','janitor') NOT NULL,
        state         ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
        priority      TINYINT UNSIGNED NOT NULL DEFAULT 5,
        progress_json JSON NULL,                                     -- last JobProgress event snapshot
        error_text    TEXT NULL,
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at    TIMESTAMP NULL,
        finished_at   TIMESTAMP NULL,
        KEY idx_saga_jobs_state (state, kind, priority),
        KEY idx_saga_jobs_project (project_id, created_at),
        KEY idx_saga_jobs_generation (generation_id),
        CONSTRAINT fk_saga_jobs_tenant FOREIGN KEY (tenant_id)
          REFERENCES saga_tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_saga_jobs_project FOREIGN KEY (project_id)
          REFERENCES saga_projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_saga_jobs_generation FOREIGN KEY (generation_id)
          REFERENCES saga_generations(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  },
];

const migration: Migration = {
  id: 3,
  name: 'saga_core',

  async up(conn: Connection): Promise<void> {
    // Order matters (FK dependencies): tenants → memberships/projects → children.
    for (const t of TABLES) {
      const existed = await tableExists(conn, t.name);
      await conn.query(t.ddl);
      console.log(`   ${existed ? 'ℹ️ exists' : '✅ created'} ${t.name}`);
    }
  },

  async down(conn: Connection): Promise<void> {
    // Reverse FK order. Children first.
    const reverse = [...TABLES].reverse();
    for (const t of reverse) {
      if (await tableExists(conn, t.name)) {
        await conn.query(`DROP TABLE \`${t.name}\``);
        console.log(`   ↩️ dropped ${t.name}`);
      }
    }
  },
};

export default migration;
