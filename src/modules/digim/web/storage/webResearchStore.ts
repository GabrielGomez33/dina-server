// File: src/modules/digim/web/storage/webResearchStore.ts
// ============================================================================
// DIGIM WEB-RESEARCH — PERSISTENCE LAYER
// ============================================================================
//
// Owns all reads/writes for gathered content and synthesized intelligence.
// Reuses the EXISTING DIGIM schema (digim_sources / digim_content /
// digim_intelligence) created in src/modules/digim/index.ts — it adds NO new
// tables, so it cannot disrupt the existing schema evolution.
//
// FK NOTE: digim_content.source_id is NOT NULL with a FK to digim_sources.
// Ad-hoc web-gathered documents are attached to a single, stable system source
// ("DINA Web Research") which this store upserts on init. This satisfies the
// constraint without schema changes; the true origin URL/domain lives on the
// content row + metadata.
//
// SECURITY NOTE: writes use fully-parameterized (?) SQL, so they are injection-
// safe by construction. We pass skipSecurityValidation=true (matching the rest
// of the DIGIM module) because scraped article text legitimately contains
// substrings the DB security heuristic flags (e.g. the literal "javascript:"),
// which would otherwise cause false-positive rejections of valid content.
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { database as DB } from '../../../../config/database/db';
import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { ExtractedContent, GatheredDocument, QualityMetrics, WebInsight } from '../types';

export const WEB_RESEARCH_SOURCE_ID = 'd1611eb0-0000-4000-8000-000000000001';

export interface StoreContentInput {
  url: string;
  extracted: ExtractedContent;
  quality: QualityMetrics;
  provider: string;
  entities?: Array<{ text: string; type: string }>;
  topics?: Array<{ topic: string; relevance: number }>;
}

export interface StoreContentResult {
  id: string;
  duplicate: boolean;
}

export class WebResearchStore {
  private systemSourceReady = false;

  constructor(private cfg: DigimWebConfig = getDigimWebConfig()) {}

  /** Idempotently ensure the system source row exists (FK target). */
  async ensureSystemSource(): Promise<void> {
    if (this.systemSourceReady) return;
    try {
      await DB.query(
        `INSERT INTO digim_sources
           (id, name, category, subcategory, source_type, url, config, schedule_type, trust_level, is_active, metadata, created_by)
         VALUES (?, ?, 'documents', 'web-research', 'web', NULL, ?, 'manual', 0.60, TRUE, ?, 'system')
         ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
        [
          WEB_RESEARCH_SOURCE_ID,
          'DINA Web Research',
          JSON.stringify({ system: true }),
          JSON.stringify({ managed_by: 'digim-web-research' }),
        ],
        true
      );
      this.systemSourceReady = true;
    } catch (err) {
      // Non-fatal: the pipeline reports gather failures per-document. Log loudly.
      console.error(`❌ [webResearchStore] Failed to ensure system source: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Check whether a content hash already exists (cross-run dedup).
   * Returns the existing row id or null.
   */
  async findByHash(contentHash: string): Promise<string | null> {
    try {
      const rows = await DB.query(
        'SELECT id FROM digim_content WHERE content_hash = ? LIMIT 1',
        [contentHash],
        true
      );
      return Array.isArray(rows) && rows.length > 0 ? rows[0].id : null;
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] findByHash failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Persist one gathered document. Idempotent on content_hash: an existing hash
   * is treated as a duplicate (not re-inserted), and its id is returned.
   */
  async storeContent(input: StoreContentInput): Promise<StoreContentResult> {
    await this.ensureSystemSource();

    const existingId = await this.findByHash(input.extracted.contentHash);
    if (existingId) {
      return { id: existingId, duplicate: true };
    }

    const id = uuidv4();
    const e = input.extracted;
    const q = input.quality;
    try {
      await DB.query(
        `INSERT INTO digim_content
           (id, source_id, content_hash, title, content, url, author, published_at,
            quality_score, relevance_score, freshness_score, authority_score,
            processing_status, security_status, entities, topics, language, word_count, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', 'safe', ?, ?, ?, ?, ?)`,
        [
          id,
          WEB_RESEARCH_SOURCE_ID,
          e.contentHash,
          truncate(e.title, 500),
          e.text,
          truncate(input.url, 2000),
          e.author ? truncate(e.author, 250) : null,
          e.publishedAt ? toMysqlDate(e.publishedAt) : null,
          q.overall,
          q.relevance,
          q.freshness,
          q.authority,
          JSON.stringify(input.entities || []),
          JSON.stringify(input.topics || []),
          e.language || null,
          e.wordCount,
          JSON.stringify({
            provider: input.provider,
            extraction_method: e.method,
            uniqueness: q.uniqueness,
            completeness: q.completeness,
          }),
        ],
        true
      );
      return { id, duplicate: false };
    } catch (err) {
      // A concurrent insert of the same hash can still race → treat as duplicate.
      const msg = (err as Error).message || '';
      if (/duplicate/i.test(msg)) {
        const raced = await this.findByHash(input.extracted.contentHash);
        if (raced) return { id: raced, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Persist a synthesized intelligence result. Returns the new row id.
   */
  async storeIntelligence(params: {
    query: string;
    userId?: string;
    level: 'surface' | 'deep' | 'predictive';
    insight: WebInsight;
    sourceContentIds: string[];
    modelUsed: string;
    processingTimeMs: number;
  }): Promise<string> {
    const id = uuidv4();
    const queryHash = hashQuery(params.query, params.level);
    const ttlHours = this.cfg.intelligenceCacheTtlHours;
    const expiresAt =
      ttlHours > 0 ? toMysqlDate(new Date(Date.now() + ttlHours * 3600 * 1000).toISOString()) : null;

    try {
      await DB.query(
        `INSERT INTO digim_intelligence
           (id, query_hash, user_id, intelligence_type, query_text, source_content_ids,
            summary, insights, trends, predictions, confidence_score, raw_data,
            generated_content, processing_time_ms, model_used, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          queryHash,
          params.userId || null,
          params.level,
          params.query,
          JSON.stringify(params.sourceContentIds),
          truncate(params.insight.summary, 60000),
          JSON.stringify(params.insight.keyInsights || []),
          JSON.stringify(params.insight.trends || []),
          JSON.stringify([]),
          clamp01(params.insight.confidence),
          JSON.stringify({
            entities: params.insight.entities || [],
            topics: params.insight.topics || [],
            caveats: params.insight.caveats || [],
            sources: params.insight.sources || [],
          }),
          params.insight.summary,
          Math.round(params.processingTimeMs),
          truncate(params.modelUsed, 100),
          expiresAt,
        ],
        true
      );
      return id;
    } catch (err) {
      console.error(`❌ [webResearchStore] storeIntelligence failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Return a fresh (non-expired) cached intelligence row for a query, if any.
   * Enables cheap re-serving of recent research without re-gathering.
   */
  async getFreshIntelligence(query: string, level?: string): Promise<any | null> {
    if (this.cfg.intelligenceCacheTtlHours <= 0) return null;
    try {
      const rows = await DB.query(
        `SELECT * FROM digim_intelligence
         WHERE query_hash = ? AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY generated_at DESC LIMIT 1`,
        [hashQuery(query, level)],
        true
      );
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] getFreshIntelligence failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Mark a content row as embedded into the vector index (best-effort). */
  async markEmbedded(id: string, model: string, ref: string): Promise<void> {
    try {
      await DB.query(
        `UPDATE digim_content
         SET embedding_status = 'embedded', embedded_at = NOW(), embedding_model = ?, embedding_ref = ?
         WHERE id = ?`,
        [truncate(model, 100), truncate(ref, 128), id],
        true
      );
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] markEmbedded failed for ${id}: ${(err as Error).message}`);
    }
  }

  /** Mark a content row as having failed embedding (best-effort). */
  async markEmbeddingFailed(id: string): Promise<void> {
    try {
      await DB.query(`UPDATE digim_content SET embedding_status = 'failed' WHERE id = ?`, [id], true);
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] markEmbeddingFailed failed for ${id}: ${(err as Error).message}`);
    }
  }

  /** Content rows still awaiting embedding (for a backfill sweep). */
  async getPendingEmbeddingContent(limit = 50): Promise<any[]> {
    try {
      const rows = await DB.query(
        `SELECT id, title, content, url FROM digim_content
         WHERE embedding_status = 'pending'
         ORDER BY gathered_at DESC LIMIT ?`,
        [Math.max(1, Math.min(limit, 500))],
        true
      );
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] getPendingEmbeddingContent failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** IDs of content older than `retentionDays` (eligible for pruning). */
  async getExpiredContentIds(retentionDays: number, limit: number): Promise<string[]> {
    try {
      const rows = await DB.query(
        `SELECT id FROM digim_content
         WHERE gathered_at < (NOW() - INTERVAL ? DAY)
         ORDER BY gathered_at ASC LIMIT ?`,
        [Math.max(1, retentionDays), Math.max(1, Math.min(limit, 5000))],
        true
      );
      return Array.isArray(rows) ? rows.map((r) => r.id) : [];
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] getExpiredContentIds failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Delete content rows by id. Returns the number of rows removed. */
  async deleteContentByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    try {
      const placeholders = ids.map(() => '?').join(',');
      const result: any = await DB.query(
        `DELETE FROM digim_content WHERE id IN (${placeholders})`,
        ids,
        true
      );
      return typeof result?.affectedRows === 'number' ? result.affectedRows : ids.length;
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] deleteContentByIds failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Delete intelligence rows past their expiry. Returns rows removed. */
  async pruneExpiredIntelligence(): Promise<number> {
    try {
      const result: any = await DB.query(
        `DELETE FROM digim_intelligence WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
        [],
        true
      );
      return typeof result?.affectedRows === 'number' ? result.affectedRows : 0;
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] pruneExpiredIntelligence failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Load stored documents by id (for re-synthesis / inspection). */
  async getContentByIds(ids: string[]): Promise<any[]> {
    if (ids.length === 0) return [];
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = await DB.query(
        `SELECT * FROM digim_content WHERE id IN (${placeholders})`,
        ids,
        true
      );
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.warn(`⚠️ [webResearchStore] getContentByIds failed: ${(err as Error).message}`);
      return [];
    }
  }
}

// ----------------------------------------------------------------------------
// UTIL
// ----------------------------------------------------------------------------

export function hashQuery(query: string, level?: string): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ') + (level ? `::${level}` : '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

function toMysqlDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // 'YYYY-MM-DD HH:MM:SS' in UTC.
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Build a GatheredDocument view object (used by the pipeline for return values). */
export function toGatheredDocument(
  id: string,
  input: StoreContentInput,
  duplicate: boolean
): GatheredDocument {
  return {
    id,
    sourceId: WEB_RESEARCH_SOURCE_ID,
    contentHash: input.extracted.contentHash,
    title: input.extracted.title,
    content: input.extracted.text,
    url: input.url,
    author: input.extracted.author,
    publishedAt: input.extracted.publishedAt,
    gatheredAt: new Date().toISOString(),
    wordCount: input.extracted.wordCount,
    language: input.extracted.language,
    quality: input.quality,
    provider: input.provider,
    duplicate,
  };
}
