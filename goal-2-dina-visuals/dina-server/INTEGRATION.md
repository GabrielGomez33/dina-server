# Wiring `dina-visuals` into dina-server (non-invasive)

All steps are additive; existing modules and routes are untouched. Apply in order.

## Step 0 — copy files to their mirrored paths

```
migrations/003_visuals_core.ts            → migrations/003_visuals_core.ts
src/modules/visuals/**                    → src/modules/visuals/**
test/visuals/visualsFoundationTest.ts     → test/visuals/visualsFoundationTest.ts
```

Add to `package.json` scripts (matches the `test:*` convention):

```json
"test:visuals": "ts-node test/visuals/visualsFoundationTest.ts",
```

## Step 1 — run the migration

```bash
npm run migrate:status   # 003 visuals_core should show ⏳ pending
npm run migrate          # applies 003 (idempotent; safe to re-run)
```

## Step 2 — initialize the module in DinaCore (Phase 5)

In `src/core/orchestrator/index.ts`, after the Mirror phase in `initialize()`:

```ts
import { visualsModule } from '../../modules/visuals';

// ── Phase 5: Visuals Module ─────────────────────────────────
console.log('🎬 Phase 5/5 — Visuals Module');
await visualsModule.initialize({
  db: database,                      // existing singleton satisfies DbPort
  jobs: visualsJobQueue,             // phase 2b: BullMQ adapter; until then a stub that records
});
```

(Until the phase-2b worker exists, pass a stub `JobQueuePort` that logs enqueues — the module is
fully functional for tenancy/projects/lifecycle either way.)

Add to `shutdown()`: `await visualsModule.shutdown();`

## Step 3 — add the orchestrator case (additive)

In `handleIncomingMessage`'s module switch:

```ts
case 'visuals': {
  console.log('🎬 Processing VISUALS request');
  const sessionInfo = {
    userId: message.security.user_id || 'anonymous',
    sessionId: message.security.session_id || 'default',
  };
  responsePayload = await visualsModule.handleVisualsMessage(message as any, sessionInfo);
  break;
}
```

And add `'visuals'` to the `availableModules` list in the default case.

## Step 4 — register the routes

In `src/api/routes/index.ts`, where `registerTruthStreamRoutes` is called:

```ts
import { registerVisualsRoutes } from '../../modules/visuals/visualsRoutes';
registerVisualsRoutes(apiRouter, dina, createDinaMessage, mapTrustLevelToSecurityLevel);
```

Endpoints appear under the existing `/dina` base:
`https://theundergroundrailroad.world/dina/visuals/:tenantId/...` — exactly the locked URL pattern.

## Step 5 — storage root

```bash
sudo mkdir -p /mnt/visuals/{tenants,tmp,models}
# ensure the dina-server user owns it
export VISUALS_ROOT=/mnt/visuals   # add to the PM2 env block
```

## Verification

1. `npm run test:visuals` → 97/97 green.
2. `npm run build` → clean compile.
3. Smoke (authenticated):
   `POST /dina/visuals/tenants {"name":"Gabriel","slug":"gabriel"}` → tenantId; the caller is
   auto-owner.
   `POST /dina/visuals/<tenantId>/projects {"slug":"first-project"}` → projectId + storageRoot
   inside `/mnt/visuals/tenants/<tenantId>/…`.
   `GET /dina/visuals/status` → module version + full method list.
4. Negative smoke: repeat step 3 with a second (non-member) user → `403 FORBIDDEN`; malformed body →
   `400 INVALID_REQUEST`.

## Rollback

Routes/case/init are additive — comment them out and redeploy. Schema: `npm run migrate:down`
(drops the 7 `visuals_*` tables in FK order; only run before real data exists).
