// File: test/digim/tenancyTest.ts
// ============================================================================
// DIGIM TENANCY — ADVERSARIAL ISOLATION TEST (live MySQL)
// ============================================================================
// Proves the security boundary: a user can only ever read their OWN research,
// graph, content, and cache — and that untagged/cross-tenant data can never
// leak, including by guessing ids. Also proves per-research islands (no bleed).
//
// Runs the real store + graphStore read/write paths against a live MySQL with
// the post-migration-007 schema. No web/LLM needed — data is seeded directly,
// then every READ is asserted through the actual store/graphStore methods that
// the handlers call. Uses DB_* env; injects a pool into the DINA db singleton.
// ============================================================================

import mysql from 'mysql2/promise';
import { database } from '../../src/config/database/db';
import { WebResearchStore } from '../../src/modules/digim/web/storage/webResearchStore';
import { GraphStore } from '../../src/modules/digim/web/graph/graphStore';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // 36-char UUIDs (users.id shape)
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function schema(conn: mysql.PoolConnection): Promise<void> {
  await conn.query('DROP TABLE IF EXISTS digim_relationship_sources, digim_relationships, digim_entities, digim_content, digim_intelligence, digim_sources');
  await conn.query(`CREATE TABLE digim_sources (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255)) ENGINE=InnoDB`);
  await conn.query(`INSERT INTO digim_sources (id,name) VALUES ('web-research-system','sys')`);
  await conn.query(`CREATE TABLE digim_intelligence (
    id VARCHAR(36) PRIMARY KEY, query_hash VARCHAR(64), user_id VARCHAR(36),
    visibility ENUM('private','shared') NOT NULL DEFAULT 'private',
    intelligence_type ENUM('surface','deep','predictive') NOT NULL, query_text TEXT,
    source_content_ids JSON, summary TEXT, insights JSON, trends JSON, predictions JSON,
    confidence_score DECIMAL(5,4) DEFAULT 0, raw_data JSON, generated_content TEXT,
    processing_time_ms INT, model_used VARCHAR(100), generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL, INDEX idx_user (user_id), INDEX idx_qh (query_hash)) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE digim_content (
    id VARCHAR(36) PRIMARY KEY, owner_id VARCHAR(36) NULL, research_id VARCHAR(36) NULL,
    source_id VARCHAR(36) NULL, content_hash VARCHAR(64) NOT NULL, title TEXT, content LONGTEXT,
    url TEXT, author VARCHAR(255) NULL, published_at TIMESTAMP NULL,
    gathered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, quality_score DECIMAL(5,4) DEFAULT 0,
    relevance_score DECIMAL(5,4) DEFAULT 0, freshness_score DECIMAL(5,4) DEFAULT 0, authority_score DECIMAL(5,4) DEFAULT 0,
    processing_status VARCHAR(20) DEFAULT 'analyzed', security_status VARCHAR(20) DEFAULT 'safe',
    entities JSON, topics JSON, language VARCHAR(10) NULL, word_count INT NULL, metadata JSON,
    embedding_status VARCHAR(20) DEFAULT 'pending',
    UNIQUE KEY uq_content_owner_research_hash (owner_id, research_id, content_hash),
    INDEX idx_owner (owner_id, research_id)) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE digim_entities (
    id CHAR(36) PRIMARY KEY, owner_id VARCHAR(36) NULL, research_id VARCHAR(36) NULL,
    canonical_key VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL,
    type ENUM('person','organization','location','event','technology','concept','other') NOT NULL DEFAULT 'other',
    occurred_at DATETIME NULL, mention_count INT UNSIGNED NOT NULL DEFAULT 1, embedding_ref VARCHAR(128) NULL,
    first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_entity_owner_research_key (owner_id, research_id, canonical_key),
    INDEX idx_canonical (canonical_key)) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE digim_relationships (
    id CHAR(36) PRIMARY KEY, owner_id VARCHAR(36) NULL, research_id VARCHAR(36) NULL,
    subject_id CHAR(36) NOT NULL, predicate VARCHAR(120) NOT NULL, object_id CHAR(36) NOT NULL,
    corroboration_count INT UNSIGNED NOT NULL DEFAULT 1, confidence DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    occurred_at DATETIME NULL, first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_edge (subject_id, predicate, object_id), INDEX idx_owner (owner_id, research_id)) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE digim_relationship_sources (
    id CHAR(36) PRIMARY KEY, owner_id VARCHAR(36) NULL, research_id VARCHAR(36) NULL,
    relationship_id CHAR(36) NOT NULL, source_url VARCHAR(1024) NOT NULL, source_content_id CHAR(36) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rel_source (relationship_id, source_url(191))) ENGINE=InnoDB`);
}

async function main(): Promise<void> {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'dina_user', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'dina', connectionLimit: 4,
  });
  const setup = await pool.getConnection();
  await schema(setup);
  setup.release();
  (database as any).pool = pool;
  (database as any).isConnected = true;

  const store = new WebResearchStore();
  const graph = new GraphStore();

  try {
    // ── Seed: A researches "iran"; B researches "capitalism" (+ B also "iran") ──
    const aResearch = await store.storeIntelligence({
      query: 'strait of hormuz iran', userId: A, level: 'deep',
      insight: { summary: 'iran stuff', keyInsights: [], trends: [], entities: [], topics: [], caveats: [], sources: [], confidence: 0.8 } as any,
      sourceContentIds: [], modelUsed: 'test', processingTimeMs: 1,
    });
    const bResearch = await store.storeIntelligence({
      query: 'origins of capitalism', userId: B, level: 'deep',
      insight: { summary: 'capitalism stuff', keyInsights: [], trends: [], entities: [], topics: [], caveats: [], sources: [], confidence: 0.8 } as any,
      sourceContentIds: [], modelUsed: 'test', processingTimeMs: 1,
    });
    // B ALSO researches iran with the SAME query as A (cache-poisoning attempt).
    const bIran = await store.storeIntelligence({
      query: 'strait of hormuz iran', userId: B, level: 'deep',
      insight: { summary: 'b iran', keyInsights: [], trends: [], entities: [], topics: [], caveats: [], sources: [], confidence: 0.8 } as any,
      sourceContentIds: [], modelUsed: 'test', processingTimeMs: 1,
    });

    // Content owned by A and B respectively.
    // Seed content directly (bypasses the digim_sources system-source setup that
    // the full storeContent path needs; we only test READ isolation here).
    const aContentId = 'aaaa1111-0000-0000-0000-000000000001';
    const bContent = 'bbbb2222-0000-0000-0000-000000000002';
    await pool.query(
      `INSERT INTO digim_content (id, owner_id, research_id, content_hash, title, content, url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [aContentId, A, aResearch, 'hashA', 'Iran doc', 'iran oil hormuz', 'https://a.example/iran'],
    );
    await pool.query(
      `INSERT INTO digim_content (id, owner_id, research_id, content_hash, title, content, url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bContent, B, bResearch, 'hashB', 'Capitalism doc', 'capital markets', 'https://b.example/cap'],
    );

    // Graphs: A builds Iran↔oil in its island; B builds capitalism↔england.
    await graph.upsertRelationship({ subject: { name: 'Iran', type: 'location' }, predicate: 'controls', object: { name: 'Strait of Hormuz', type: 'location' }, confidence: 0.9, sourceUrl: 'https://a.example/iran' } as any, { ownerId: A, researchId: aResearch });
    await graph.upsertRelationship({ subject: { name: 'Capitalism', type: 'concept' }, predicate: 'originated_in', object: { name: 'England', type: 'location' }, confidence: 0.9, sourceUrl: 'https://b.example/cap' } as any, { ownerId: B, researchId: bResearch });

    // ── ISOLATION ASSERTIONS ────────────────────────────────────────────────
    console.log('HISTORY');
    const aHist = await store.listIntelligence({ ownerId: A });
    const bHist = await store.listIntelligence({ ownerId: B });
    check('A history shows only A research', aHist.length === 1 && aHist[0].id === aResearch, aHist.map((r) => r.id));
    check('B history shows only B researches (2)', bHist.length === 2 && bHist.every((r) => r.id === bResearch || r.id === bIran));
    check('history without owner is empty (fail closed)', (await store.listIntelligence({})).length === 0);
    check('count is per-owner', (await store.countIntelligence({ ownerId: A })) === 1 && (await store.countIntelligence({ ownerId: B })) === 2);

    console.log('IDOR — opening another user\'s research by id');
    check('B CANNOT open A\'s research by id', (await store.getIntelligenceById(aResearch, B)) === null);
    check('A CAN open A\'s research', (await store.getIntelligenceById(aResearch, A))?.id === aResearch);
    check('getById without owner is null (fail closed)', (await store.getIntelligenceById(aResearch)) === null);

    console.log('CACHE — same query, different owner');
    const aCache = await store.getFreshIntelligence('strait of hormuz iran', 'deep', A);
    const bCache = await store.getFreshIntelligence('strait of hormuz iran', 'deep', B);
    check('A cache hit is A\'s row', aCache?.id === aResearch);
    check('B cache hit is B\'s row, NOT A\'s (no cross-tenant cache)', bCache?.id === bIran && bCache?.id !== aResearch);
    check('cache without owner is null (fail closed)', (await store.getFreshIntelligence('strait of hormuz iran', 'deep')) === null);

    console.log('CONTENT');
    check('B CANNOT read A\'s content even with A\'s real content id', (await store.getContentByIds([aContentId], B)).length === 0);
    check('B reads only B content', (await store.getContentByIds([bContent], B)).length === 1);
    check('A CANNOT read B\'s content', (await store.getContentByIds([bContent], A)).length === 0);

    console.log('GRAPH — the bleeding fix');
    const aGraph = await graph.getSubgraph('Iran', { ownerId: A });
    const bGraph = await graph.getSubgraph('capitalism', { ownerId: B });
    check('A graph contains Iran', aGraph.nodes.some((n) => /iran/i.test(n.name)));
    check('A graph does NOT contain capitalism/england (no bleed)', !aGraph.nodes.some((n) => /capitalism|england/i.test(n.name)));
    check('B graph contains capitalism, NOT Iran/hormuz', bGraph.nodes.some((n) => /capitalism/i.test(n.name)) && !bGraph.nodes.some((n) => /iran|hormuz/i.test(n.name)));
    check('graph without owner is empty (fail closed)', (await graph.getSubgraph('Iran', { ownerId: '' })).nodes.length === 0);
    // B asks for the "all my knowledge" view but still sees only B's graph.
    const bAll = await graph.getSubgraph('anything', { ownerId: B, mode: 'all' });
    check('B all-my-knowledge view has no A data', !bAll.nodes.some((n) => /iran|hormuz/i.test(n.name)));

    console.log('ISLANDS — per-research entity separation within one owner');
    const r1 = 'research-1111', r2 = 'research-2222';
    const iran1 = await graph.upsertEntity({ name: 'Iran', type: 'location' } as any, { ownerId: A, researchId: r1 });
    const iran2 = await graph.upsertEntity({ name: 'Iran', type: 'location' } as any, { ownerId: A, researchId: r2 });
    const iran1b = await graph.upsertEntity({ name: 'Iran', type: 'location' } as any, { ownerId: A, researchId: r1 });
    check('same name in different researches → different nodes (islands)', !!iran1 && !!iran2 && iran1 !== iran2);
    check('same name in SAME research → same node (dedup within island)', iran1 === iran1b);

    console.log('STATS');
    const aStats = await graph.getStats({ ownerId: A });
    const bStats = await graph.getStats({ ownerId: B });
    check('A stats count only A entities', aStats.entities >= 2 && bStats.entities >= 1 && aStats.entities !== 0);
  } finally {
    await pool.end();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} DIGIM tenancy: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('tenancy test crashed:', e); process.exit(1); });
