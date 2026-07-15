// File: src/modules/saga/tests/promptSystemsTest.ts
// ============================================================================
// DINA SAGA — PROMPT + REFERENCE-TEMPLATE PROOF HARNESS
// ============================================================================
// Proves the deterministic prompt-assembly logic (underscore→space, paren-aware
// split, empty-strip, de-dupe, subject/quality assembly) and the IP-Adapter
// reference workflow template binds to a valid injection-safe graph.
//
//   run:  npx ts-node src/modules/saga/tests/promptSystemsTest.ts
// ============================================================================

import { normalizeTag, splitTags, normalizePrompt, assemblePrompt } from '../core/promptNormalizer';
import { bindWorkflow, TEMPLATE_IMAGE_REFERENCE, getTemplate, WorkflowBindError } from '../systems/workflowTemplates';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — PROMPT + REFERENCE-TEMPLATE PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. normalizeTag — the exact bug we hit live (underscores from Dina)', () => {
    eq(normalizeTag('cinematic_horror_lighting'), 'cinematic horror lighting', 'underscores between words → spaces');
    eq(normalizeTag('  looming_silhouette  '), 'looming silhouette', 'trims surrounding whitespace');
    eq(normalizeTag('dark   color   gradient'), 'dark color gradient', 'collapses doubled internal whitespace');
    eq(normalizeTag('3D_ rendered'), '3D rendered', 'underscore before a space (the exact defect the harness caught) is fixed');
    eq(normalizeTag('(dark:1.4)'), '(dark:1.4)', 'weight syntax + decimal untouched');
    eq(normalizeTag('^_^'), '^_^', 'kaomoji underscore (flanked by non-word chars) is preserved');
    eq(normalizeTag(''), '', 'empty stays empty');
  });

  await section('2. splitTags — paren-aware (does not break weight groups)', () => {
    eq(splitTags('a, b, c').length, 3, 'plain comma split');
    eq(splitTags('(masterpiece, best quality:1.3), dark').length, 2, 'comma inside parens is NOT a separator');
    const parts = splitTags('1boy, (foo, bar:1.2), solo');
    eq(parts.length, 3, 'weight group counts as one tag among others');
    eq(normalizeTag(parts[1]), '(foo, bar:1.2)', 'the group survives intact');
  });

  await section('3. normalizePrompt — end to end on real Dina output', () => {
    const raw = ' Exodia_the_Forbidden_One_3D_ rendered, cinematic_horror_lighting, ominous_atmosphere';
    eq(
      normalizePrompt(raw),
      'Exodia the Forbidden One 3D rendered, cinematic horror lighting, ominous atmosphere',
      'the literal string that broke the first render is now clean',
    );
  });

  await section('4. normalizePrompt — drops empties and de-dupes (first wins)', () => {
    eq(normalizePrompt('dark, , dark, ,'), 'dark', 'doubled commas + repeats collapse to one');
    eq(normalizePrompt('Dark, dark, DARK'), 'Dark', 'de-dupe is case-insensitive, keeps first casing/position');
    eq(normalizePrompt('a, b, a, c, b'), 'a, b, c', 'order preserved, later dupes removed');
    eq(normalizePrompt(''), '', 'empty prompt → empty');
    eq(normalizePrompt('  '), '', 'whitespace-only → empty');
  });

  await section('5. weighted vs bare are DISTINCT (never drop a deliberate weight)', () => {
    eq(normalizePrompt('dark, (dark:1.4)'), 'dark, (dark:1.4)', 'weighted tag is not a duplicate of the bare tag');
  });

  await section('6. assemblePrompt — subject anchor first, quality last, de-duped across seams', () => {
    const p = assemblePrompt({
      subjectAnchor: 'exodia, yu-gi-oh!, 1boy',
      body: 'golden bandaged giant, (dark:1.4)',
      qualitySuffix: 'masterpiece, absurdres',
    });
    eq(p, 'exodia, yu-gi-oh!, 1boy, golden bandaged giant, (dark:1.4), masterpiece, absurdres', 'ordered assembly');
    ok(p.startsWith('exodia'), 'subject anchor lands first (Animagine keys off the head)');
  });

  await section('7. assemblePrompt — quality booster the user already typed is not doubled', () => {
    const p = assemblePrompt({ subjectAnchor: '1girl', body: 'forest, masterpiece', qualitySuffix: 'masterpiece, absurdres' });
    eq(p, '1girl, forest, masterpiece, absurdres', 'the echoed "masterpiece" collapses to one');
  });

  await section('8. assemblePrompt — optional parts absent', () => {
    eq(assemblePrompt({ body: 'lone tree' }), 'lone tree', 'body only');
    eq(assemblePrompt({ subjectAnchor: '', body: 'x', qualitySuffix: '' }), 'x', 'empty parts skipped, no stray commas');
  });

  await section('9. reference template is registered and binds to a valid graph', () => {
    ok(getTemplate('image-reference@1') === TEMPLATE_IMAGE_REFERENCE, 'template registered under its id');
    const g = bindWorkflow(TEMPLATE_IMAGE_REFERENCE, {
      prompt: 'exodia, (dark:1.4)',
      checkpoint: 'animagine-xl-4.0.safetensors',
      referenceImage: 'exodia_ref.png',
      ipAdapterWeight: 0.7,
      seed: 1337,
    });
    eq(g['1'].inputs.ckpt_name, 'animagine-xl-4.0.safetensors', 'checkpoint bound');
    eq(g['8'].inputs.image, 'exodia_ref.png', 'reference image filename bound into LoadImage');
    eq(g['10'].inputs.weight, 0.7, 'IP-Adapter weight bound as a NUMBER, not a string');
    eq(g['10'].class_type, 'IPAdapterAdvanced', 'IP-Adapter node present in the graph');
    // weight_type must be a value the installed IPAdapterAdvanced accepts. 'standard'
    // was rejected live (value_not_in_list); 'linear' is the valid general-purpose type.
    ok(
      ['linear', 'ease in', 'ease out', 'ease in-out', 'style transfer', 'composition']
        .includes(g['10'].inputs.weight_type),
      'weight_type is a value the node accepts (regression guard for the live rejection)',
    );
    eq(g['5'].inputs.model[0], '10', 'KSampler consumes the IP-Adapter-modified model, not the raw checkpoint');
    eq(g['2'].inputs.text, 'exodia, (dark:1.4)', 'prompt text lands verbatim (weights preserved)');
  });

  await section('10. reference template — weight clamps to 0..1 and defaults apply', () => {
    const hi = bindWorkflow(TEMPLATE_IMAGE_REFERENCE, { prompt: 'x', checkpoint: 'c', referenceImage: 'r.png', ipAdapterWeight: 5 });
    eq(hi['10'].inputs.weight, 1, 'over-range weight clamps to max 1');
    const lo = bindWorkflow(TEMPLATE_IMAGE_REFERENCE, { prompt: 'x', checkpoint: 'c', referenceImage: 'r.png', ipAdapterWeight: -3 });
    eq(lo['10'].inputs.weight, 0, 'under-range weight clamps to min 0');
    const def = bindWorkflow(TEMPLATE_IMAGE_REFERENCE, { prompt: 'x', checkpoint: 'c', referenceImage: 'r.png' });
    eq(def['10'].inputs.weight, 0.6, 'weight defaults to 0.6 when omitted');
  });

  await section('11. reference template — missing required reference image is rejected fast', () => {
    let threw = false;
    try {
      bindWorkflow(TEMPLATE_IMAGE_REFERENCE, { prompt: 'x', checkpoint: 'c' });
    } catch (e) {
      threw = e instanceof WorkflowBindError;
    }
    ok(threw, 'a reference workflow with no reference image never reaches the GPU');
  });

  await section('12. injection safety — a prompt full of JSON metacharacters cannot break the graph', () => {
    const nasty = '"}],"evil":1,"x":["';
    const g = bindWorkflow(TEMPLATE_IMAGE_REFERENCE, { prompt: nasty, checkpoint: 'c', referenceImage: 'r.png' });
    eq(g['2'].inputs.text, nasty, 'the hostile string is a value, never structure');
    ok(g['10'].class_type === 'IPAdapterAdvanced', 'graph shape intact after hostile input');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
