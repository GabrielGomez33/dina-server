// File: test/digim/migrationTest.ts
// ============================================================================
// MIGRATION 001 — LOGIC / IDEMPOTENCY / ROLLBACK HARNESS
// ============================================================================
//
// A live MySQL server could not be started in the CI sandbox (the container's
// seccomp policy kills the DB server on startup). Rather than skip verification,
// this harness drives the REAL migration code (migrations/001 + migrations/
// helpers) against a MockConnection that (a) answers INFORMATION_SCHEMA probes
// from a simulated schema state and (b) records + applies the DDL the migration
// emits. That lets us assert the migration's decision logic precisely:
//
//   • legacy schema        → emits the exact corrective DDL, in order
//   • re-run (idempotent)  → emits ZERO DDL the second time
//   • already-migrated     → emits ZERO DDL
//   • missing table        → skips cleanly
//   • down()               → drops exactly the embedding columns
//
//   run:  npx ts-node test/digim/migrationTest.ts   (or: npm run test:migration)
//
// NOTE: this validates the migration's branching (where bugs live). Operators
// should still run `npm run migrate` once against a real database — the expected
// output is documented in docs/digim/PHASE0.md.
// ============================================================================

import migration from '../../migrations/001_digim_content_web_ready';

// ----------------------------------------------------------------------------
// Simulated schema state + mock connection
// ----------------------------------------------------------------------------

interface ColMeta { nullable: 'YES' | 'NO'; }
interface SchemaState {
  tableExists: boolean;
  columns: Map<string, ColMeta>;
  indexes: Set<string>;
  fks: Set<string>; // FK constraint names on digim_content.source_id
}

class MockConnection {
  public ddl: string[] = [];
  constructor(public st: SchemaState) {}

  async query(sql: string, params: any[] = []): Promise<[any[], any[]]> {
    const s = sql.replace(/\s+/g, ' ').trim();

    // --- INFORMATION_SCHEMA probes ---
    if (s.includes('information_schema.tables')) {
      return [[{ c: this.st.tableExists ? 1 : 0 }], []];
    }
    if (s.includes('information_schema.columns') && s.includes('COUNT(*) AS c')) {
      const col = params[1];
      return [[{ c: this.st.columns.has(col) ? 1 : 0 }], []];
    }
    if (s.includes('information_schema.columns') && s.includes('is_nullable')) {
      const col = params[1];
      const meta = this.st.columns.get(col);
      // NOTE: UPPERCASE key — mirrors real MySQL, which returns bare
      // information_schema column names uppercased (the bug that slipped past
      // the mock the first time). Helpers must read case-insensitively.
      return [meta ? [{ IS_NULLABLE: meta.nullable }] : [], []];
    }
    if (s.includes('information_schema.statistics')) {
      const idx = params[1];
      return [[{ c: this.st.indexes.has(idx) ? 1 : 0 }], []];
    }
    if (s.includes('key_column_usage')) {
      // UPPERCASE key — see note above.
      return [[...this.st.fks].map((n) => ({ CONSTRAINT_NAME: n })), []];
    }
    if (s.includes('table_constraints')) {
      const name = params[1];
      return [[{ c: this.st.fks.has(name) ? 1 : 0 }], []];
    }

    // --- Anything else is DDL: record + apply to simulated state ---
    this.ddl.push(s);
    this.applyDdl(s);
    return [[], []];
  }

  private applyDdl(s: string): void {
    let m: RegExpMatchArray | null;
    if ((m = s.match(/ADD COLUMN (\w+)/))) {
      this.st.columns.set(m[1], { nullable: /NOT NULL/.test(s) ? 'NO' : 'YES' });
    } else if ((m = s.match(/ADD INDEX `([^`]+)`/))) {
      this.st.indexes.add(m[1]);
    } else if ((m = s.match(/DROP FOREIGN KEY `([^`]+)`/))) {
      this.st.fks.delete(m[1]);
    } else if (/MODIFY COLUMN source_id .*NULL/.test(s)) {
      const c = this.st.columns.get('source_id');
      if (c) c.nullable = 'YES';
    } else if ((m = s.match(/ADD CONSTRAINT `([^`]+)`/))) {
      this.st.fks.add(m[1]);
    } else if ((m = s.match(/DROP COLUMN `([^`]+)`/))) {
      this.st.columns.delete(m[1]);
    }
  }
}

// ----------------------------------------------------------------------------
// Assertions
// ----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function section(t: string): void { console.log(`\n▶ ${t}`); }

const EMBED_COLS = ['embedding_status', 'embedded_at', 'embedding_model', 'embedding_ref'];

function legacyState(): SchemaState {
  return {
    tableExists: true,
    columns: new Map<string, ColMeta>([
      ['id', { nullable: 'NO' }],
      ['source_id', { nullable: 'NO' }],
      ['content_hash', { nullable: 'NO' }],
      ['title', { nullable: 'YES' }],
      ['content', { nullable: 'YES' }],
      ['url', { nullable: 'YES' }],
      ['gathered_at', { nullable: 'YES' }],
    ]),
    indexes: new Set<string>(),
    fks: new Set<string>(['digim_content_ibfk_1']), // legacy auto-named CASCADE FK
  };
}

function migratedState(): SchemaState {
  const cols = new Map<string, ColMeta>([
    ['id', { nullable: 'NO' }],
    ['source_id', { nullable: 'YES' }],
    ['content_hash', { nullable: 'NO' }],
  ]);
  for (const c of EMBED_COLS) cols.set(c, { nullable: c === 'embedding_status' ? 'NO' : 'YES' });
  return {
    tableExists: true,
    columns: cols,
    indexes: new Set<string>(['idx_embedding_status']),
    fks: new Set<string>(['fk_digim_content_source']),
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== Migration 001 Logic Harness (mock connection) ===');

  // 1) Legacy → migrate: exact corrective DDL, in order.
  section('legacy schema → up() emits correct DDL, in order');
  const legacy = legacyState();
  const c1 = new MockConnection(legacy);
  await migration.up(c1 as any);

  const ddl = c1.ddl;
  const embedAdds = ddl.filter((d) => /ADD COLUMN embedding|ADD COLUMN embedded/.test(d));
  ok(embedAdds.length === 4, `added 4 embedding columns (got ${embedAdds.length})`);
  ok(ddl.some((d) => /ADD INDEX `idx_embedding_status`/.test(d)), 'added idx_embedding_status');
  ok(ddl.some((d) => /DROP FOREIGN KEY `digim_content_ibfk_1`/.test(d)), 'dropped legacy CASCADE FK');
  ok(ddl.some((d) => /MODIFY COLUMN source_id VARCHAR\(36\) NULL/.test(d)), 'made source_id NULLABLE');
  ok(ddl.some((d) => /ADD CONSTRAINT `fk_digim_content_source`.*ON DELETE SET NULL/.test(d)), 'added FK ON DELETE SET NULL');

  // Ordering: embedding columns added before the FK rewrite; DROP FK before MODIFY before ADD CONSTRAINT.
  const idxDropFk = ddl.findIndex((d) => /DROP FOREIGN KEY/.test(d));
  const idxModify = ddl.findIndex((d) => /MODIFY COLUMN source_id/.test(d));
  const idxAddFk = ddl.findIndex((d) => /ADD CONSTRAINT `fk_digim_content_source`/.test(d));
  ok(idxDropFk < idxModify && idxModify < idxAddFk, 'FK rewrite order: DROP → MODIFY → ADD');

  // Resulting simulated state is correct.
  ok(legacy.columns.get('source_id')?.nullable === 'YES', 'post: source_id nullable');
  ok([...EMBED_COLS].every((c) => legacy.columns.has(c)), 'post: embedding columns present');
  ok(legacy.fks.has('fk_digim_content_source') && !legacy.fks.has('digim_content_ibfk_1'), 'post: only our FK remains');

  // 2) Idempotency: re-run on the resulting state → ZERO DDL.
  section('re-run on migrated state → idempotent (no DDL)');
  const c1b = new MockConnection(legacy); // legacy has been mutated into migrated state
  await migration.up(c1b as any);
  ok(c1b.ddl.length === 0, `second run emitted no DDL (got ${c1b.ddl.length})`);

  // 3) Already-migrated fresh state → ZERO DDL.
  section('already-migrated schema → up() is a no-op');
  const c2 = new MockConnection(migratedState());
  await migration.up(c2 as any);
  ok(c2.ddl.length === 0, `no DDL on already-migrated schema (got ${c2.ddl.length})`);

  // 4) Missing table → skip cleanly.
  section('missing digim_content → up() skips without DDL');
  const c3 = new MockConnection({ tableExists: false, columns: new Map(), indexes: new Set(), fks: new Set() });
  await migration.up(c3 as any);
  ok(c3.ddl.length === 0, `no DDL when table absent (got ${c3.ddl.length})`);

  // 5) Partial state: only column already exists, FK still legacy → only the missing bits change.
  section('partial schema → only missing changes applied');
  const partial = migratedState();
  partial.columns.set('source_id', { nullable: 'NO' }); // pretend nullability not yet applied
  partial.fks = new Set(['digim_content_ibfk_1']); // legacy FK still present
  const c5 = new MockConnection(partial);
  await migration.up(c5 as any);
  ok(c5.ddl.every((d) => !/ADD COLUMN/.test(d)), 'no duplicate column adds (cols already present)');
  ok(c5.ddl.some((d) => /DROP FOREIGN KEY `digim_content_ibfk_1`/.test(d)), 'still fixes the FK');
  ok(c5.ddl.some((d) => /MODIFY COLUMN source_id/.test(d)), 'still relaxes nullability');

  // 6) down(): drops exactly the embedding columns, leaves source_id nullable.
  section('down() → drops embedding columns only');
  const migrated = migratedState();
  const c4 = new MockConnection(migrated);
  await migration.down!(c4 as any);
  const drops = c4.ddl.filter((d) => /DROP COLUMN/.test(d));
  ok(drops.length === 4, `dropped 4 embedding columns (got ${drops.length})`);
  ok(EMBED_COLS.every((c) => !migrated.columns.has(c)), 'post-down: embedding columns gone');
  ok(migrated.columns.get('source_id')?.nullable === 'YES', 'post-down: source_id stays nullable (forward-only)');

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ Migration 001 logic verified (legacy, idempotent, already-migrated, missing, partial, rollback).');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Harness crashed:', err);
  process.exit(1);
});
