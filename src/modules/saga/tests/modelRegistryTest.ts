// File: src/modules/saga/tests/modelRegistryTest.ts
// ============================================================================
// DINA SAGA — MODEL REGISTRY PROOF HARNESS
// ============================================================================
// Proves the registry's safety invariants actually hold — most importantly the
// one that prevents a real, detrimental scheduling mistake: a HEAVY (video)
// model must never be schedulable as a SHARED GPU lease (would OOM against
// Ollama). Also proves catalog↔template coherence: every profile can bind its
// template with the files/defaults it declares.
//
//   run:  npx ts-node src/modules/saga/tests/modelRegistryTest.ts
// ============================================================================

import {
  classifyVram, validateProfile, listProfiles, resolveProfile,
  ModelRegistryError, ModelProfile, VRAM_LIGHT_MAX_MB, VRAM_MEDIUM_MAX_MB,
} from '../core/modelRegistry';
import { getTemplate, bindWorkflow } from '../systems/workflowTemplates';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw, none)`); }
  catch (e) { ok(e instanceof ModelRegistryError, `${name} (threw ${(e as Error).name})`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

/** A known-good base we mutate to violate exactly one invariant per test. */
const GOOD: ModelProfile = {
  id: 'probe', jobKind: 'image_gen', engine: 'comfyui', templateId: 'image-basic@1',
  files: { checkpoint: 'x.safetensors' }, estVramMb: 7000, vramClass: 'light', leaseMode: 'shared',
  defaults: { steps: 20 },
};

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — MODEL REGISTRY PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. classifyVram — thresholds are exact (boundary-correct)', () => {
    eq(classifyVram(VRAM_LIGHT_MAX_MB), 'light', '8000 is the top of light (inclusive)');
    eq(classifyVram(VRAM_LIGHT_MAX_MB + 1), 'medium', '8001 tips into medium');
    eq(classifyVram(VRAM_MEDIUM_MAX_MB), 'medium', '16000 is the top of medium (inclusive)');
    eq(classifyVram(VRAM_MEDIUM_MAX_MB + 1), 'heavy', '16001 tips into heavy');
  });

  await section('2. the shipped catalog is entirely valid (fail-fast held at import)', () => {
    const all = listProfiles();
    ok(all.length >= 3, 'catalog has profiles');
    for (const p of all) validateProfile(p); // must not throw
    ok(true, 'every catalog profile passes every invariant');
  });

  await section('3. THE critical guard — a heavy model may not be a shared lease', () => {
    throws(() => validateProfile({ ...GOOD, id: 'bad-heavy-shared', estVramMb: 18000, vramClass: 'heavy', leaseMode: 'shared' }),
      'heavy + shared is rejected (the OOM-against-Ollama case)');
    // …and the corrected version is accepted
    validateProfile({ ...GOOD, id: 'ok-heavy-excl', templateId: 'video-i2v-wan@1', jobKind: 'video_gen',
      files: { diffusionModel: 'a', textEncoder: 'b', vae: 'c' }, defaults: {}, estVramMb: 18000, vramClass: 'heavy', leaseMode: 'exclusive' });
    ok(true, 'heavy + exclusive is accepted');
  });

  await section('4. other invariants reject their bad profile', () => {
    throws(() => validateProfile({ ...GOOD, id: 'mismatch', estVramMb: 18000 /* heavy */, vramClass: 'light' }),
      'vramClass disagreeing with estVramMb is rejected');
    throws(() => validateProfile({ ...GOOD, id: 'light-excl', leaseMode: 'exclusive' }),
      'light + exclusive is rejected (wasteful eviction)');
    throws(() => validateProfile({ ...GOOD, id: 'no-template', templateId: 'does-not-exist@9' }),
      'unknown templateId is rejected');
    throws(() => validateProfile({ ...GOOD, id: 'bad-file-key', files: { notAnInput: 'x' } }),
      'a file key the template does not declare is rejected');
    throws(() => validateProfile({ ...GOOD, id: 'bad-default-key', defaults: { notAnInput: 1 } }),
      'a default key the template does not declare is rejected');
    throws(() => validateProfile({ ...GOOD, id: 'wrong-kind', jobKind: 'video_gen' /* but template is image */ }),
      'jobKind disagreeing with the template is rejected');
  });

  await section('5. resolveProfile — by id, by kind, and the failure modes', () => {
    eq(resolveProfile({ id: 'animagine-xl-4' }).templateId, 'image-basic@1', 'resolve by id');
    eq(resolveProfile({ jobKind: 'image_gen' }).id, 'animagine-xl-4', 'resolve by kind returns the kind default');
    eq(resolveProfile({ jobKind: 'video_gen' }).id, 'wan2.2-ti2v-5b', 'video default is the Wan profile');
    throws(() => resolveProfile({ id: 'nope' }), 'unknown id throws (never returns undefined)');
    throws(() => resolveProfile({ id: 'animagine-xl-4', jobKind: 'video_gen' }), 'id/kind mismatch throws');
    throws(() => resolveProfile({}), 'empty ref throws');
  });

  await section('6. resolveProfile returns a COPY (catalog is immutable to callers)', () => {
    const a = resolveProfile({ id: 'animagine-xl-4' });
    a.estVramMb = 999999;
    eq(resolveProfile({ id: 'animagine-xl-4' }).estVramMb, 7000, 'mutating a resolved profile does not corrupt the catalog');
  });

  await section('7. catalog↔template coherence — every profile actually binds its template', () => {
    for (const p of listProfiles()) {
      const t = getTemplate(p.templateId)!;
      // Supply the profile's files+defaults plus a minimal stand-in for any other
      // required inputs, then assert binding succeeds (no missing-required for the
      // model inputs the profile is responsible for).
      const inputs: Record<string, unknown> = { ...p.files, ...(p.defaults ?? {}) };
      for (const spec of t.inputs) {
        if (spec.required && inputs[spec.name] === undefined) {
          inputs[spec.name] = spec.type === 'string' ? 'x' : 1;
        }
      }
      const graph = bindWorkflow(t, inputs);
      ok(graph && typeof graph === 'object', `${p.id} binds ${p.templateId} with its declared files/defaults`);
    }
  });

  await section('8. provisional flag surfaces (Wan graph is not trusted until live-verified)', () => {
    eq(resolveProfile({ id: 'wan2.2-ti2v-5b' }).provisional, true, 'Wan profile is flagged provisional');
    ok(!resolveProfile({ id: 'animagine-xl-4' }).provisional, 'proven image profile is not provisional');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
