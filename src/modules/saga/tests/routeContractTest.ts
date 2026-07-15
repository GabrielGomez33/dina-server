// File: src/modules/saga/tests/routeContractTest.ts
// ============================================================================
// DINA SAGA — ROUTE CONTRACT PROOF HARNESS
// ============================================================================
// Proves the HTTP→DUMP→extraction round-trip that a prior version got wrong:
// the route extractor was copied from the mirror pattern (which double-wraps a
// createDinaResponse and carries a `.status`), but SAGA handlers return a plain
// { success, data|error } that the orchestrator wraps ONCE. The mismatch turned
// EVERY saga response into HTTP 500. This harness reconstructs the exact
// orchestrator envelope and asserts the extractor + status mapping are correct.
//
//   run:  npx ts-node src/modules/saga/tests/routeContractTest.ts
// ============================================================================

import { extractSagaResult, httpStatusFor, SagaResult } from '../sagaRoutes';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

/**
 * Faithful reproduction of core/protocol createDinaResponse — so the envelope
 * shapes here are EXACTLY what handleIncomingMessage hands the route, not an
 * approximation. (payload is wrapped as { data: payload }.)
 */
function createDinaResponse(opts: { status: 'success' | 'error'; payload: any; error?: any }): any {
  return {
    id: 'res-1',
    request_id: 'req-1',
    timestamp: 'now',
    status: opts.status,
    payload: { data: opts.payload },
    error: opts.error,
    metrics: { processing_time_ms: 1 },
  };
}

/** How the orchestrator's `case 'saga'` path builds the response: the module's
 *  SagaHandlerResult becomes the payload of a status:'success' DinaResponse. */
function orchestratorSuccessEnvelope(handlerResult: SagaResult): any {
  return createDinaResponse({ status: 'success', payload: handlerResult });
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — ROUTE CONTRACT PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. Success envelope unwraps to the handler payload (the 500 regression)', () => {
    // saga_get_status returns { success:true, data:{ module, version, methods } }
    const env = orchestratorSuccessEnvelope({ success: true, data: { module: 'saga', version: '0.1.0', methods: ['saga_get_status'] } });
    const r = extractSagaResult(env);
    eq(r.success, true, 'status endpoint is classified success, not error (regression guard)');
    eq((r.data as any)?.module, 'saga', 'handler data survives extraction intact');
    ok(r.error === undefined, 'no phantom error attached to a success');
  });

  await section('2. Handler error codes map to the right HTTP status', () => {
    const cases: Array<[string, number]> = [
      ['INVALID_REQUEST', 400],
      ['NO_AUTH', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['NOT_CANCELLABLE', 409],
      ['QUOTA_EXCEEDED', 413],
      ['MODULE_NOT_READY', 503],
      ['PROCESSING_ERROR', 500],
      ['SOMETHING_UNKNOWN', 500],
    ];
    for (const [code, want] of cases) {
      const env = orchestratorSuccessEnvelope({ success: false, error: { code, message: 'x' } });
      const r = extractSagaResult(env);
      eq(r.success, false, `${code} extracted as failure`);
      eq(r.error?.code, code, `${code} code preserved`);
      eq(httpStatusFor(r.error!.code), want, `${code} → HTTP ${want}`);
    }
  });

  await section('3. Orchestrator-level failure (handler threw / protocol invalid)', () => {
    const env = createDinaResponse({
      status: 'error',
      payload: { status: 'error', message: 'Invalid DINA message' },
      error: { code: 'PROCESSING_ERROR', message: 'Invalid DINA message' },
    });
    const r = extractSagaResult(env);
    eq(r.success, false, 'orchestrator error is a failure');
    eq(r.error?.code, 'PROCESSING_ERROR', 'mapped to PROCESSING_ERROR');
    eq(httpStatusFor(r.error!.code), 500, 'orchestrator error → HTTP 500');
    ok((r.error?.message || '').includes('Invalid DINA message'), 'underlying message surfaced');
  });

  await section('4. Defensive — an unrecognised envelope is a server fault, not a silent 200', () => {
    eq(extractSagaResult({}).success, false, 'empty response → failure');
    eq(extractSagaResult({ payload: {} }).error?.code, 'INTERNAL', 'missing payload.data → INTERNAL');
    eq(extractSagaResult(null).success, false, 'null response → failure (no throw)');
    eq(httpStatusFor(extractSagaResult({ payload: { data: 42 } }).error!.code), 500, 'non-result payload → 500');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
