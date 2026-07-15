# SAGA — Live Verification Log

Record of what was proven on the live `tugrr-portal` box, per phase. Infrastructure values (concrete
paths, user ids, tenant ids) are redacted — the record is the *outcomes*, not the secrets.

## Phase 1 — Foundation live (dark launch) — ✅ SIGNED OFF 2026-07-15

**Pre-deploy gates (on the box):** proof harnesses green — gpu 43 / saga 97 / render 29 / routes 38;
`npm run type-check` + `npm run build` clean; migration `003_saga_core` applied (7 `saga_*` tables);
database backed up before and after the migration (`--single-transaction --no-tablespaces`).

**Deploy:** `dina-server` reloaded clean under pm2. Startup log confirmed:
```
🛡️ GPU Arbiter registered (enforcement: off — dark launch)
🎬 Phase 5/5 — SAGA Module → ✅ SAGA ready (execution engine: Phase 2)
```

**Live API checks — all passed:**

| Check | Request | Result |
|---|---|---|
| Status, unauthenticated | `GET /saga/status` | `200` (non-sensitive module/version/method list) |
| Create tenant | `POST /saga/tenants` (plan=admin) | success; quota resolved to 3.5 TB; `saga_memberships` row role=`owner` |
| **Authz boundary** | `POST /saga/<non-member-tenant>/projects` | **`403 FORBIDDEN`** — not a member (the security boundary, proven live) |
| Create project | `POST /saga/<tenant>/projects` | success; row persisted `status=active`; `storageRoot` under `$SAGA_ROOT/tenants/<t>/projects/<p>` |
| Input validation | `POST /saga/tenants {"name":""}` | `400 INVALID_REQUEST` |
| No-regression | `@Dina` chat | unchanged (arbiter `off` → byte-identical LLM path) |

**Bug found & fixed during Phase 1:** the route response extractor was copied from the mirror
double-wrap pattern and mis-classified SAGA's single-wrap `{success,data}` shape, returning HTTP 500
on every SAGA request. Root-caused, fixed (`extractSagaResult`), and covered by a new
`routeContractTest` (38 assertions reconstructing the exact orchestrator envelope). Commit `b94d6c6`.
Lesson logged: the HTTP→DUMP→extraction round-trip now has explicit test coverage; module-handler
unit tests alone were insufficient.

**Known follow-ups (non-blocking, tracked separately):**
- **Arbiter go-live** — flip `DINA_GPU_ARBITER=on` + reload when single-GPU load-balancing is wanted;
  rollback is the same flip back to `off`.
- **Pre-existing mirror debt** — `mirror_user_context` / `mirror_user_metadata` tables missing on this
  box (a mirror migration never run here; errors predate SAGA). Unrelated to SAGA; fix on its own.
- **Phase 0 engine** — ComfyUI + starter models (runbook steps K–P) still to be installed before
  Phase 2 can render for real.
