# Wiring `dina-saga` into dina-server (non-invasive)

All steps are additive; existing modules and routes are untouched. Apply in order.

## Step 0 — copy files to their mirrored paths

```
migrations/003_saga_core.ts            → migrations/003_saga_core.ts
src/modules/saga/**                    → src/modules/saga/**
test/saga/sagaFoundationTest.ts     → test/saga/sagaFoundationTest.ts
```

Add to `package.json` scripts (matches the `test:*` convention):

```json
"test:saga": "ts-node test/saga/sagaFoundationTest.ts",
```

## Step 1 — run the migration

```bash
npm run migrate:status   # 003 saga_core should show ⏳ pending
npm run migrate          # applies 003 (idempotent; safe to re-run)
```

## Step 2 — initialize the module in DinaCore (Phase 5)

In `src/core/orchestrator/index.ts`, after the Mirror phase in `initialize()`:

```ts
import { sagaModule } from '../../modules/saga';

// ── Phase 5: Saga Module ─────────────────────────────────
console.log('🎬 Phase 5/5 — Saga Module');
await sagaModule.initialize({
  db: database,                      // existing singleton satisfies DbPort
  jobs: sagaJobQueue,             // phase 2b: BullMQ adapter; until then a stub that records
});
```

(Until the phase-2b worker exists, pass a stub `JobQueuePort` that logs enqueues — the module is
fully functional for tenancy/projects/lifecycle either way.)

Add to `shutdown()`: `await sagaModule.shutdown();`

## Step 3 — add the orchestrator case (additive)

In `handleIncomingMessage`'s module switch:

```ts
case 'saga': {
  console.log('🎬 Processing SAGA request');
  const sessionInfo = {
    userId: message.security.user_id || 'anonymous',
    sessionId: message.security.session_id || 'default',
  };
  responsePayload = await sagaModule.handleSagaMessage(message as any, sessionInfo);
  break;
}
```

And add `'saga'` to the `availableModules` list in the default case.

## Step 4 — register the routes

In `src/api/routes/index.ts`, where `registerTruthStreamRoutes` is called:

```ts
import { registerSagaRoutes } from '../../modules/saga/sagaRoutes';
registerSagaRoutes(apiRouter, dina, createDinaMessage, mapTrustLevelToSecurityLevel);
```

Endpoints appear under the existing `/dina` base:
`https://theundergroundrailroad.world/dina/saga/:tenantId/...` — exactly the locked URL pattern.

## Step 5 — storage root

```bash
sudo mkdir -p /mnt/nvme_tugrrstorage2/Dina/SAGA/{tenants,tmp,models}
# ensure the dina-server user owns it
export SAGA_ROOT=/mnt/nvme_tugrrstorage2/Dina/SAGA   # add to the PM2 env block
```

## Verification

1. `npm run test:saga` → 97/97 green.
2. `npm run build` → clean compile.
3. Smoke (authenticated):
   `POST /dina/saga/tenants {"name":"Gabriel","slug":"gabriel"}` → tenantId; the caller is
   auto-owner.
   `POST /dina/saga/<tenantId>/projects {"slug":"first-project"}` → projectId + storageRoot
   inside `/mnt/nvme_tugrrstorage2/Dina/SAGA/tenants/<tenantId>/…`.
   `GET /dina/saga/status` → module version + full method list.
4. Negative smoke: repeat step 3 with a second (non-member) user → `403 FORBIDDEN`; malformed body →
   `400 INVALID_REQUEST`.

## Rollback

Routes/case/init are additive — comment them out and redeploy. Schema: `npm run migrate:down`
(drops the 7 `saga_*` tables in FK order; only run before real data exists).
