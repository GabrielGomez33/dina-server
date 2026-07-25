// File: src/modules/digim/web/graph/graphStore.ts
// ============================================================================
// DIGIM RELATIONSHIP GRAPH — STORE (Phase 2.4b)
// ============================================================================
//
// Persistence for the canonical graph (digim_entities / digim_relationships /
// digim_relationship_sources). Owns ONLY storage/query — extraction (LLM) and
// rendering (views) are separate concerns.
//
// ROBUSTNESS
//   • Entity + edge upserts are RACE-SAFE: SELECT → INSERT → on duplicate-key
//     (a concurrent insert of the same canonical entity/edge) re-SELECT instead
//     of failing. Corroboration is recomputed from the sources table so it can't
//     drift.
//   • Every method is guarded: a graph failure logs and returns a safe value —
//     it must never break the research pipeline it hangs off.
//   • Row → type mapping is pure + exported, so shape handling is unit-tested
//     without a database (the live round-trip is verified on the box).
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { database as DB } from '../../../../config/database/db';
import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { canonicalizeEntityName, normalizePredicate, normalizeEntityType } from './entityResolution';
import { suggestView } from './graphView';
import { GraphNode, GraphEdge, Subgraph, EntityInput, RelationshipInput } from './graphTypes';

const DUP_ERR = new Set(['ER_DUP_ENTRY', 'ER_DUP_KEY']);
function isDuplicateError(err: any): boolean {
  return !!err && (DUP_ERR.has(err.code) || /duplicate/i.test(err?.message || ''));
}

/** Write scope — every entity/edge/source row is tagged with the owning account
 *  and the research (island) that produced it. Both required for writes. */
export interface GraphScope {
  ownerId: string;
  researchId: string;
}

/** Read scope — 'island' shows one research; 'all' shows the owner's whole graph
 *  across researches. ownerId is ALWAYS required (the tenancy boundary). */
export interface GraphReadScope {
  ownerId: string;
  researchId?: string | null;
  mode?: 'island' | 'all';
}

export class GraphStore {
  constructor(private cfg: DigimWebConfig = getDigimWebConfig()) {}

  // --------------------------------------------------------------------------
  // ENTITY UPSERT (race-safe)
  // --------------------------------------------------------------------------

  /** Resolve an entity to its row id WITHIN the (owner, research) island,
   *  creating/reinforcing it. Dedup is per-island — each research has its own
   *  "Iran" node, so unrelated researches never share/reinforce entities. */
  async upsertEntity(input: EntityInput, scope: GraphScope): Promise<string | null> {
    if (!scope?.ownerId || !scope?.researchId) return null; // writes require a full scope
    const key = canonicalizeEntityName(input.name);
    if (!key) return null;
    const type = normalizeEntityType(input.type || 'other');
    const occurredAt = normalizeDate(input.occurredAt);
    const embeddingRef = input.embeddingRef || null;

    try {
      const existing = await this.findEntityIdByKey(key, scope);
      if (existing) {
        await DB.query(
          `UPDATE digim_entities
             SET mention_count = mention_count + 1,
                 last_seen = CURRENT_TIMESTAMP,
                 occurred_at = COALESCE(occurred_at, ?),
                 embedding_ref = COALESCE(embedding_ref, ?)
           WHERE id = ?`,
          [occurredAt, embeddingRef, existing],
          true
        );
        return existing;
      }

      const id = uuidv4();
      try {
        await DB.query(
          `INSERT INTO digim_entities (id, owner_id, research_id, canonical_key, name, type, occurred_at, embedding_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, scope.ownerId, scope.researchId, key, (input.name || key).slice(0, 255), type, occurredAt, embeddingRef],
          true
        );
        return id;
      } catch (err) {
        // A concurrent insert of the same canonical entity IN THIS ISLAND won the
        // race — adopt it.
        if (isDuplicateError(err)) {
          const raced = await this.findEntityIdByKey(key, scope);
          if (raced) {
            await DB.query(`UPDATE digim_entities SET mention_count = mention_count + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [raced], true);
            return raced;
          }
        }
        throw err;
      }
    } catch (err) {
      console.warn(`⚠️ [graphStore] upsertEntity('${key}') failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async findEntityIdByKey(key: string, scope: GraphScope): Promise<string | null> {
    const rows = await DB.query(
      `SELECT id FROM digim_entities WHERE canonical_key = ? AND owner_id = ? AND research_id = ? LIMIT 1`,
      [key, scope.ownerId, scope.researchId],
      true,
    );
    return Array.isArray(rows) && rows.length > 0 ? String(rows[0].id) : null;
  }

  // --------------------------------------------------------------------------
  // RELATIONSHIP UPSERT (race-safe; corroboration recomputed from sources)
  // --------------------------------------------------------------------------

  async upsertRelationship(input: RelationshipInput, scope: GraphScope): Promise<string | null> {
    if (!scope?.ownerId || !scope?.researchId) return null;
    const predicate = normalizePredicate(input.predicate);
    try {
      const subjectId = await this.upsertEntity(input.subject, scope);
      const objectId = await this.upsertEntity(input.object, scope);
      if (!subjectId || !objectId || subjectId === objectId) return null; // no self-loops / bad ends

      const confidence = clamp01(typeof input.confidence === 'number' ? input.confidence : 0.5);
      const occurredAt = normalizeDate(input.occurredAt);

      let edgeId = await this.findEdgeId(subjectId, predicate, objectId);
      if (edgeId) {
        await DB.query(
          `UPDATE digim_relationships
             SET last_seen = CURRENT_TIMESTAMP,
                 confidence = GREATEST(confidence, ?),
                 occurred_at = COALESCE(occurred_at, ?)
           WHERE id = ?`,
          [confidence, occurredAt, edgeId],
          true
        );
      } else {
        edgeId = uuidv4();
        try {
          await DB.query(
            `INSERT INTO digim_relationships (id, owner_id, research_id, subject_id, predicate, object_id, confidence, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [edgeId, scope.ownerId, scope.researchId, subjectId, predicate, objectId, confidence, occurredAt],
            true
          );
        } catch (err) {
          if (isDuplicateError(err)) {
            edgeId = await this.findEdgeId(subjectId, predicate, objectId);
          } else {
            throw err;
          }
        }
      }
      if (!edgeId) return null;

      // Record provenance (idempotent on (edge, url)) and recompute corroboration.
      if (input.sourceUrl) {
        await this.addSource(edgeId, input.sourceUrl, input.sourceContentId || null, scope);
        await this.recomputeCorroboration(edgeId);
      }
      return edgeId;
    } catch (err) {
      console.warn(`⚠️ [graphStore] upsertRelationship failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async findEdgeId(subjectId: string, predicate: string, objectId: string): Promise<string | null> {
    const rows = await DB.query(
      `SELECT id FROM digim_relationships WHERE subject_id = ? AND predicate = ? AND object_id = ? LIMIT 1`,
      [subjectId, predicate, objectId],
      true
    );
    return Array.isArray(rows) && rows.length > 0 ? String(rows[0].id) : null;
  }

  private async addSource(edgeId: string, url: string, contentId: string | null, scope: GraphScope): Promise<void> {
    // INSERT IGNORE: a repeat (edge, url) — the same source re-asserting the same
    // relationship — is a no-op at the DB layer, so it neither errors nor logs.
    // Corroboration is counted DISTINCT source_url, so this stays correct.
    try {
      await DB.query(
        `INSERT IGNORE INTO digim_relationship_sources (id, owner_id, research_id, relationship_id, source_url, source_content_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), scope.ownerId, scope.researchId, edgeId, url.slice(0, 1024), contentId],
        true
      );
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
    }
  }

  private async recomputeCorroboration(edgeId: string): Promise<void> {
    await DB.query(
      `UPDATE digim_relationships r
         SET corroboration_count = (
           SELECT COUNT(DISTINCT source_url) FROM digim_relationship_sources WHERE relationship_id = r.id
         )
       WHERE r.id = ?`,
      [edgeId],
      true
    );
  }

  // --------------------------------------------------------------------------
  // QUERY — subgraph around a focus, with the recommended view
  // --------------------------------------------------------------------------

  async getSubgraph(focus: string, scope: GraphReadScope, opts?: { maxNodes?: number }): Promise<Subgraph> {
    const maxNodes = clampInt(opts?.maxNodes ?? this.cfg.graphMaxNodes, 1, 500);
    const empty: Subgraph = { focus, matchedFocus: false, nodes: [], edges: [], suggestedView: 'network' };
    // TENANCY BOUNDARY: no owner → empty graph (fail closed). Untagged/legacy
    // rows (owner_id NULL) are never returned to any user.
    if (!scope?.ownerId) return empty;
    const key = canonicalizeEntityName(focus);

    // Scope predicate + args shared by seed/fallback/edge/node queries. 'island'
    // (default when a researchId is given) restricts to one research; 'all' shows
    // the owner's whole graph across researches.
    const island = scope.mode !== 'all' && !!scope.researchId;
    const scopeSql = island ? 'owner_id = ? AND research_id = ?' : 'owner_id = ?';
    const scopeArgs: any[] = island ? [scope.ownerId, scope.researchId] : [scope.ownerId];

    try {
      // Seed entities: exact canonical match OR name contains the focus text.
      let matchedFocus = true;
      let seedIds: string[] = [];
      if (key) {
        const seeds = await DB.query(
          `SELECT id FROM digim_entities WHERE (canonical_key = ? OR name LIKE ?) AND ${scopeSql} ORDER BY mention_count DESC LIMIT 25`,
          [key, `%${focus.slice(0, 80)}%`, ...scopeArgs],
          true
        );
        seedIds = (Array.isArray(seeds) ? seeds : []).map((r: any) => String(r.id));
      }
      // Fallback: no focus match → the most-connected entities IN SCOPE (overview),
      // so a query over a populated in-scope graph is never empty.
      if (seedIds.length === 0) {
        matchedFocus = false;
        const top = await DB.query(
          `SELECT id FROM digim_entities WHERE ${scopeSql} ORDER BY mention_count DESC LIMIT 25`,
          [...scopeArgs],
          true
        );
        seedIds = (Array.isArray(top) ? top : []).map((r: any) => String(r.id));
        if (seedIds.length === 0) return empty; // in-scope graph truly empty
      }

      // 1-hop edges touching the seed set, WITHIN SCOPE. LIMIT is inlined, not
      // bound (mysql2 rejects a parameterized LIMIT); maxNodes is clampInt-
      // validated, so the inlined integer is injection-safe.
      const edgeLimit = maxNodes * 4;
      const edgeRows = await DB.query(
        `SELECT * FROM digim_relationships
          WHERE (subject_id IN (${placeholders(seedIds)}) OR object_id IN (${placeholders(seedIds)})) AND ${scopeSql}
          ORDER BY corroboration_count DESC, confidence DESC
          LIMIT ${edgeLimit}`,
        [...seedIds, ...seedIds, ...scopeArgs],
        true
      );
      const edges: GraphEdge[] = (Array.isArray(edgeRows) ? edgeRows : []).map(rowToEdge);

      // Collect every node id referenced, capped. Node fetch is ALSO owner-scoped
      // (defense in depth — an edge can only reference in-scope entities anyway).
      const nodeIds = Array.from(new Set<string>([...seedIds, ...edges.flatMap((e) => [e.subjectId, e.objectId])])).slice(0, maxNodes);
      const nodeRows = nodeIds.length
        ? await DB.query(`SELECT * FROM digim_entities WHERE id IN (${placeholders(nodeIds)}) AND owner_id = ?`, [...nodeIds, scope.ownerId], true)
        : [];
      const nodes: GraphNode[] = (Array.isArray(nodeRows) ? nodeRows : []).map(rowToNode);

      // Keep only edges whose BOTH ends survived the node cap.
      const kept = new Set(nodes.map((n) => n.id));
      const prunedEdges = edges.filter((e) => kept.has(e.subjectId) && kept.has(e.objectId));

      // Attach provenance URLs to each surviving edge.
      await this.attachSources(prunedEdges);

      return { focus, matchedFocus, nodes, edges: prunedEdges, suggestedView: suggestView(nodes, prunedEdges) };
    } catch (err) {
      console.warn(`⚠️ [graphStore] getSubgraph('${focus}') failed: ${(err as Error).message}`);
      return empty;
    }
  }

  private async attachSources(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const ids = edges.map((e) => e.id);
    const rows = await DB.query(
      `SELECT relationship_id, source_url FROM digim_relationship_sources WHERE relationship_id IN (${placeholders(ids)})`,
      ids,
      true
    );
    const byEdge = new Map<string, string[]>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const list = byEdge.get(String(r.relationship_id)) || [];
      list.push(String(r.source_url));
      byEdge.set(String(r.relationship_id), list);
    }
    for (const e of edges) e.sources = byEdge.get(e.id) || [];
  }

  /** Node/edge counts. Scoped to an owner when given (per-user totals); an
   *  unscoped call (no ownerId) returns SYSTEM-WIDE counts for status/telemetry
   *  only — never expose these to an end user. */
  async getStats(scope?: { ownerId?: string | null }): Promise<{ entities: number; relationships: number }> {
    try {
      const where = scope?.ownerId ? 'WHERE owner_id = ?' : '';
      const args = scope?.ownerId ? [scope.ownerId] : [];
      const e = await DB.query(`SELECT COUNT(*) AS c FROM digim_entities ${where}`, args, true);
      const r = await DB.query(`SELECT COUNT(*) AS c FROM digim_relationships ${where}`, args, true);
      return {
        entities: Array.isArray(e) && e[0] ? Number(e[0].c) : 0,
        relationships: Array.isArray(r) && r[0] ? Number(r[0].c) : 0,
      };
    } catch {
      return { entities: 0, relationships: 0 };
    }
  }
}

// ============================================================================
// PURE HELPERS (exported for hermetic testing)
// ============================================================================

export function rowToNode(row: any): GraphNode {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    type: String(row.type ?? 'other'),
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
    mentionCount: Number(row.mention_count ?? 1),
    embeddingRef: row.embedding_ref ?? null,
  };
}

export function rowToEdge(row: any): GraphEdge {
  return {
    id: String(row.id),
    subjectId: String(row.subject_id),
    predicate: String(row.predicate ?? 'related_to'),
    objectId: String(row.object_id),
    corroborationCount: Number(row.corroboration_count ?? 1),
    confidence: Number(row.confidence ?? 0.5),
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
  };
}

function placeholders(arr: unknown[]): string {
  return arr.map(() => '?').join(',');
}

function normalizeDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  // MySQL DATETIME format 'YYYY-MM-DD HH:MM:SS'.
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(Math.round(v), min), max);
}
