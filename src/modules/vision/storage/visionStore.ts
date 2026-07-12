// File: src/modules/vision/storage/visionStore.ts
// ============================================================================
// VISION STORE (persistence + cache)
// ============================================================================
// Owns the Vision subsystem's durable state and its hot cache, following the
// exact conventions the rest of DINA uses:
//   • MySQL via the shared `database` singleton. Like DIGIM, this module CREATES
//     ITS OWN TABLES during init (db.ts deliberately does not know about them).
//     All DDL passes skipSecurityValidation=true; all writes are parameterized.
//   • Redis via `redisManager` exact-cache API, keyed by content hash + task so
//     re-analysing the same image for the same task is a fast cache hit.
//   • Dedup by sha256: the same bytes analysed twice reuse one media row.
//
// Every method is written to DEGRADE, not crash: a storage failure logs and is
// swallowed so a DB hiccup can never break a live analysis. Persistence is a
// convenience, not the source of truth for the response.
// ============================================================================

import { database } from '../../../config/database/db';
import { redisManager } from '../../../config/redis';
import { getVisionConfig, VisionRuntimeConfig } from '../config/visionConfig';
import { ImageAnalysisResult, VideoAnalysisResult } from '../types';

export class VisionStore {
  private tablesReady = false;

  constructor(private readonly cfg: VisionRuntimeConfig = getVisionConfig()) {}

  /** Create the vision_* tables (idempotent). Safe to call on every startup. */
  async initSchema(): Promise<void> {
    if (!this.cfg.persistenceEnabled) {
      console.log('👁️ [visionStore] Persistence disabled — skipping schema creation');
      return;
    }

    const tables: Record<string, string> = {
      vision_media: `CREATE TABLE IF NOT EXISTS vision_media (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      vision_analysis: `CREATE TABLE IF NOT EXISTS vision_analysis (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    };

    for (const [name, sql] of Object.entries(tables)) {
      try {
        await database.query(sql, [], true);
        console.log(`✅ [visionStore] Ensured table: ${name}`);
      } catch (err) {
        console.error(`❌ [visionStore] Failed to create table ${name}:`, err);
        throw err;
      }
    }
    this.tablesReady = true;
  }

  // ------------------------------------------------------------------
  // CACHE (keyed by content hash + task; task-agnostic content dedup)
  // ------------------------------------------------------------------

  private cacheKey(sha256: string, task: string, model: string): string {
    return `vision:${sha256}:${task}:${model}`;
  }

  async getCachedImage(sha256: string, task: string, model: string): Promise<ImageAnalysisResult | null> {
    if (this.cfg.cacheTtlHours <= 0) return null;
    try {
      const cached = await redisManager.getExactCachedResponse(this.cacheKey(sha256, task, model));
      return cached ? ({ ...cached, cached: true } as ImageAnalysisResult) : null;
    } catch {
      return null;
    }
  }

  async cacheImage(result: ImageAnalysisResult): Promise<void> {
    if (this.cfg.cacheTtlHours <= 0) return;
    try {
      await redisManager.setExactCachedResponse(
        this.cacheKey(result.sha256, result.task, result.model),
        result,
        this.cfg.cacheTtlHours * 3600
      );
    } catch {
      /* cache write is best-effort */
    }
  }

  // ------------------------------------------------------------------
  // PERSISTENCE (best-effort; never throws to the caller)
  // ------------------------------------------------------------------

  /** Upsert a media row by (sha256, media_type); returns the media id. */
  async recordMedia(params: {
    id: string;
    sha256: string;
    mediaType: 'image' | 'video';
    mimeType?: string;
    byteLength?: number;
    width?: number | null;
    height?: number | null;
    frameCount?: number | null;
    userId?: string;
  }): Promise<string> {
    if (!this.cfg.persistenceEnabled || !this.tablesReady) return params.id;
    try {
      // Insert-or-get: rely on the UNIQUE (sha256, media_type) to dedup.
      await database.query(
        `INSERT INTO vision_media
           (id, sha256, media_type, mime_type, byte_length, width, height, frame_count, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          params.id,
          params.sha256,
          params.mediaType,
          params.mimeType ?? null,
          params.byteLength ?? null,
          params.width ?? null,
          params.height ?? null,
          params.frameCount ?? null,
          params.userId ?? null,
        ],
        true
      );

      const rows = await database.query(
        `SELECT id FROM vision_media WHERE sha256 = ? AND media_type = ? LIMIT 1`,
        [params.sha256, params.mediaType],
        true
      );
      return Array.isArray(rows) && rows[0]?.id ? rows[0].id : params.id;
    } catch (err) {
      console.warn(`⚠️ [visionStore] recordMedia degraded: ${(err as Error).message}`);
      return params.id;
    }
  }

  async recordImageAnalysis(analysisId: string, result: ImageAnalysisResult, userId?: string): Promise<void> {
    if (!this.cfg.persistenceEnabled || !this.tablesReady) return;
    try {
      await database.query(
        `INSERT INTO vision_analysis
           (id, media_id, sha256, media_type, task, model, caption, result_json, confidence, processing_time_ms, user_id)
         VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)`,
        [
          analysisId,
          result.mediaId,
          result.sha256,
          result.task,
          result.model,
          result.analysis.caption?.slice(0, 60000) ?? '',
          JSON.stringify(result.analysis),
          clamp01(result.analysis.confidence),
          Math.round(result.processingTimeMs),
          userId ?? null,
        ],
        true
      );
    } catch (err) {
      console.warn(`⚠️ [visionStore] recordImageAnalysis degraded: ${(err as Error).message}`);
    }
  }

  async recordVideoAnalysis(analysisId: string, result: VideoAnalysisResult, userId?: string): Promise<void> {
    if (!this.cfg.persistenceEnabled || !this.tablesReady) return;
    try {
      await database.query(
        `INSERT INTO vision_analysis
           (id, media_id, sha256, media_type, task, model, caption, result_json, confidence, processing_time_ms, user_id)
         VALUES (?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?)`,
        [
          analysisId,
          result.mediaId,
          result.mediaId, // videos have no single content hash; reuse mediaId
          result.task,
          result.model,
          result.analysis.summary?.slice(0, 60000) ?? '',
          JSON.stringify(result.analysis),
          clamp01(result.analysis.confidence),
          Math.round(result.processingTimeMs),
          userId ?? null,
        ],
        true
      );
    } catch (err) {
      console.warn(`⚠️ [visionStore] recordVideoAnalysis degraded: ${(err as Error).message}`);
    }
  }

  /** Retention sweep: delete media (and cascaded analyses) older than retentionDays. */
  async pruneOld(): Promise<{ deleted: number }> {
    if (!this.cfg.persistenceEnabled || !this.tablesReady) return { deleted: 0 };
    try {
      const res = await database.query(
        `DELETE FROM vision_media WHERE created_at < (NOW() - INTERVAL ? DAY)`,
        [this.cfg.retentionDays],
        true
      );
      const deleted = (res && (res.affectedRows ?? res[0]?.affectedRows)) || 0;
      return { deleted };
    } catch (err) {
      console.warn(`⚠️ [visionStore] pruneOld degraded: ${(err as Error).message}`);
      return { deleted: 0 };
    }
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
