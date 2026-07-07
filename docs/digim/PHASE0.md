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

## Next: Phase 1 — Semantic memory

Embed gathered content with `mxbai-embed-large` → store in the Redis vector
index → hybrid retrieval (vector + keyword + recency + authority) → RAG-grounded
synthesis with prompt-injection fencing. The `embedding_*` columns and the KNN
search method (to be added to `redis.ts`) are the seams this phase plugs into.
