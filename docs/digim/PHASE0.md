# Phase 0 — Foundation Corrections

Before building semantic memory and the tool ecosystem, we corrected the
foundations while DIGIM is still unused (the cheapest time to move a wall). This
phase adds a real migration system, fixes latent schema bugs, and prepares the
ground for Phase 1 (semantic memory).

## 1. Env-driven migration runner (`npm run migrate`)

DINA had no formal migration mechanism — schema was auto-created at boot. That's
fine for base tables but gives no disciplined way to *evolve* schema. Added a
small, robust, env-driven runner (same spirit as the rest of DINA):

| Command | What it does |
|---|---|
| `npm run migrate` | Apply all pending migrations |
| `npm run migrate:status` | Show applied vs pending (needs DB) |
| `npm run migrate:list` | List discovered migrations (offline, no DB) |
| `npm run migrate:down` | Roll back the most recently applied migration |
| `ts-node scripts/migrate.ts up --dry-run` | Preview pending without applying |

- Files: `scripts/migrate.ts` (runner), `migrations/types.ts` (the `Migration`
  interface), `migrations/helpers.ts` (idempotency helpers via
  `INFORMATION_SCHEMA`), `migrations/001_*.ts` (first migration).
- Uses the existing `DB_*` env vars (same as `db.ts`/`test-db.js`).
- Tracks applied migrations in a `schema_migrations` table.
- **Idempotent by design:** MySQL DDL auto-commits and can't be rolled back in a
  transaction, so every migration checks current state before changing it and is
  safe to re-run. A migration is recorded only after its `up()` succeeds.

## 2. Migration 001 — `digim_content` web-ready + embedding tracking

Foundational corrections to `digim_content`:

- **`source_id` is now NULLABLE** with an FK `ON DELETE SET NULL` (was `NOT NULL`
  + `ON DELETE CASCADE`). Ad-hoc web documents no longer *require* a configured
  source, and deleting a source no longer deletes its harvested content.
- **Embedding-tracking columns** for Phase 1 semantic memory:
  `embedding_status` (`pending|embedded|failed|skipped`), `embedded_at`,
  `embedding_model`, `embedding_ref` (the Redis vector id), plus an index. The
  raw vectors live in Redis; MySQL just tracks *what's been embedded*.

The app's own DDL (`digim/index.ts → initializeDatabaseSchemas`) was updated to
match, so **fresh deploys are created already-corrected** and the migration is a
no-op there; the migration exists to fix **already-deployed** databases.

## 3. Latent bug fix — first-boot crash on a fresh database

`db.ts`'s `createIntelligentSchema()` listed the `digim_*` tables in its build
loop, but `createTable()` has **no definitions** for them — so on a brand-new
database, boot would throw *"No definition found for table digim_sources"* and
the server would fail to start. This would have bitten the next scale-up to a
fresh environment. Fixed by removing the `digim_*` entries from that list; DIGIM
creates its own tables during its init phase.

## 4. Redis Stack / RediSearch ops (semantic-memory prerequisite)

Added `ops/REDIS_STACK_RUNBOOK.md` and `ops/install-redis-stack.sh`. Semantic
memory's fast native vector search needs the RediSearch module (Redis Stack).
`redis.ts` already detects it (`FT._LIST`) and falls back to in-process
similarity when absent, so this is a scale-up step, not a blocker. The vector
index is `DIM 1024 / COSINE`, which already matches `mxbai-embed-large`.

## 5. Docs relocated out of the repo root

Moved the delivery docs from a root `digim-web-research/` folder to `docs/digim/`
and the edge-case harness to `test/digim/webEdgeCases.ts` (`npm run test:digim`),
so a normal `git pull` picks everything up — no parallel tree, no copy-paste.

## What Phase 0 did NOT change

- No new npm dependencies.
- No change to existing runtime behavior (the web subsystem stays gated off by
  `DIGIM_WEB_ENABLED`).
- The `webResearchStore` needed no change — the schema additions are
  backward-compatible (new columns are nullable/defaulted; `source_id` is still
  populated, just no longer forced).

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit` (src + migration/ops/test files) | ✅ clean, 0 errors |
| `npm run migrate:list` (offline discovery + typecheck) | ✅ discovers 001 |
| `npm run test:digim` (web-research edge cases) | ✅ 90/90 |
| `npm run test:migration` (migration 001 logic harness) | ✅ 18/18 |
| Latent `db.ts` first-boot fix | ✅ confirmed (0 `digim_*` entries remain in the builder array) |
| Corrected `digim_content` DDL in `digim/index.ts` | ✅ confirmed (nullable source_id, named FK SET NULL, embedding cols) |

**On live-DB testing:** a real MySQL/MariaDB server could **not** be started in
the CI sandbox — the container's seccomp policy kills the DB server on startup
(InnoDB's io_uring/AIO), and even a plain `mysqld` foreground start is
terminated before it logs anything. So migration 001 was verified with
`test/digim/migrationTest.ts`, which drives the **real** migration code against a
mock connection that answers `INFORMATION_SCHEMA` probes and records the DDL
emitted. It exercises every branch — legacy→migrate (exact DDL + ordering),
idempotent re-run (zero DDL), already-migrated (no-op), missing table (skip),
partial state, and `down()` rollback.

**Operators should still run it once against a real database.** Expected:

```
$ npm run migrate:status        # 001 shown as ⏳ pending
$ npm run migrate               # applies 001, logs each ALTER, records it
$ npm run migrate               # "✅ No pending migrations" (idempotent)
$ npm run migrate:status        # 001 shown as ✅ applied
```

After applying, `digim_content.source_id` is nullable, the FK is
`fk_digim_content_source ON DELETE SET NULL`, and the four `embedding_*` columns
exist with `idx_embedding_status`.

## Next: Phase 1 — Semantic memory

Embed gathered content with `mxbai-embed-large` → store in the Redis vector
index → hybrid retrieval (vector + keyword + recency + authority) → RAG-grounded
synthesis with prompt-injection fencing. The `embedding_*` columns and the KNN
search method (to be added to `redis.ts`) are the seams this phase plugs into.
