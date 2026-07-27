// File: scripts/gpuFitTest.ts
// ============================================================================
// DINA — GPU FIT TEST: can we run a bigger extraction model alongside warmup?
// ============================================================================
// Reads the ACTUAL GPU + Ollama state and checks whether a candidate model fits
// in VRAM next to the models DINA warms on init (chat + analysis + embed). Two
// modes:
//
//   • estimate (default): uses nvidia-smi free VRAM + the config footprint table.
//       npx ts-node scripts/gpuFitTest.ts qwen2.5:14b
//   • --load: actually pulls (if needed) + loads the candidate with a 1-token
//       generate, re-reads /api/ps to measure its REAL resident VRAM, and leaves
//       it loaded (keep_alive). This is the definitive test.
//       npx ts-node scripts/gpuFitTest.ts qwen2.5:14b --load
//
// Non-destructive to data. --load leaves the candidate resident (Ollama evicts
// on keep_alive); it never deletes models.
// ============================================================================

import { execSync } from 'child_process';
import { getLlmConfig } from '../src/modules/llm/llmConfig';

const CANDIDATE = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'qwen2.5:14b';
const DO_LOAD = process.argv.includes('--load');
const cfg = getLlmConfig();
const BASE = cfg.ollamaBaseUrl;

function bar(t: string) { console.log('\n' + '─'.repeat(76) + `\n  ${t}\n` + '─'.repeat(76)); }
const gb = (mb: number) => (mb / 1024).toFixed(1) + ' GB';

function nvidiaSmi(): { totalMb: number; usedMb: number; freeMb: number } | null {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits', {
      encoding: 'utf8', timeout: 8000,
    }).trim().split('\n')[0];
    const [total, used, free] = out.split(',').map((s) => parseInt(s.trim(), 10));
    return { totalMb: total, usedMb: used, freeMb: free };
  } catch {
    return null;
  }
}

async function ollama(path: string, body?: any): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

function footprint(model: string): number | null {
  const f = cfg.modelFootprints;
  if (f[model] != null) return f[model];
  const base = model.split(':')[0];
  if (f[base] != null) return f[base];
  return null;
}

async function main() {
  console.log(`\nDINA GPU fit test — candidate = ${CANDIDATE}${DO_LOAD ? '  (--load)' : ''}`);
  console.log(`Ollama = ${BASE}   VRAM budget (config) = ${gb(cfg.vramBudgetMb)}\n`);

  // ── 1. Physical GPU ───────────────────────────────────────────────────────
  bar('1) GPU (nvidia-smi)');
  const smi = nvidiaSmi();
  if (smi) {
    console.log(`  total=${gb(smi.totalMb)}  used=${gb(smi.usedMb)}  free=${gb(smi.freeMb)}`);
  } else {
    console.log('  nvidia-smi unavailable — falling back to config budget for estimates.');
  }

  // ── 2. What DINA warms on init ────────────────────────────────────────────
  bar('2) Warmup set (from config)');
  let warmSum = 0;
  for (const m of cfg.warmupModels) {
    const fp = footprint(m);
    warmSum += fp ?? 0;
    console.log(`  ${m.padEnd(22)} ${fp != null ? gb(fp) : '(unknown footprint)'}`);
  }
  console.log(`  warmup total ≈ ${gb(warmSum)}`);

  // ── 3. Currently loaded (Ollama /api/ps) ──────────────────────────────────
  bar('3) Currently resident (Ollama /api/ps)');
  let loaded: any[] = [];
  try {
    const ps = await ollama('/api/ps');
    loaded = Array.isArray(ps.models) ? ps.models : [];
    if (loaded.length === 0) console.log('  (nothing loaded right now)');
    for (const m of loaded) console.log(`  ${String(m.name || m.model).padEnd(28)} ${gb((m.size_vram || 0) / 1e6)} resident`);
  } catch (e) {
    console.log(`  /api/ps failed: ${(e as Error).message}`);
  }

  // ── 4. Is the candidate installed? ────────────────────────────────────────
  bar('4) Candidate availability');
  let installed = false;
  try {
    const tags = await ollama('/api/tags');
    const names: string[] = (tags.models || []).map((m: any) => m.name);
    installed = names.includes(CANDIDATE) || names.some((n) => n.split(':')[0] === CANDIDATE.split(':')[0] && CANDIDATE.includes(':') === false);
    console.log(`  ${CANDIDATE} installed: ${installed ? 'YES' : 'NO (ollama pull ' + CANDIDATE + ')'}`);
  } catch (e) {
    console.log(`  /api/tags failed: ${(e as Error).message}`);
  }
  const candFp = footprint(CANDIDATE);
  console.log(`  candidate footprint (config est.) = ${candFp != null ? gb(candFp) : 'UNKNOWN — add to DINA_MODEL_VRAM_JSON'}`);

  // ── 5. Estimate verdict ───────────────────────────────────────────────────
  bar('5) Fit estimate');
  const budgetFree = cfg.vramBudgetMb - warmSum;
  console.log(`  headroom under config budget after warmup ≈ ${gb(budgetFree)}`);
  if (smi) console.log(`  actual free VRAM right now ≈ ${gb(smi.freeMb)}`);
  if (candFp != null) {
    const fitsBudget = candFp <= budgetFree;
    const fitsNow = smi ? candFp <= smi.freeMb : fitsBudget;
    console.log(`  candidate ${gb(candFp)}  →  fits budget headroom: ${fitsBudget ? 'YES' : 'NO'}` +
      (smi ? `   fits current free VRAM: ${fitsNow ? 'YES' : 'NO'}` : ''));
    console.log(`  ${fitsBudget && fitsNow ? '✅ Estimated to fit alongside the warm set.' : '⚠️ Tight/over — prefer a smaller model or free VRAM first.'}`);
  }

  // ── 6. Real load test ─────────────────────────────────────────────────────
  if (DO_LOAD) {
    bar('6) REAL load test (--load)');
    console.log(`  loading ${CANDIDATE} (pull if needed, 1-token generate)…`);
    try {
      const t0 = Date.now();
      await ollama('/api/generate', { model: CANDIDATE, prompt: 'ok', stream: false, keep_alive: cfg.keepAlive, options: { num_predict: 1, num_gpu: cfg.numGpu } });
      console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const ps = await ollama('/api/ps');
      const me = (ps.models || []).find((m: any) => (m.name || m.model) === CANDIDATE || String(m.name || m.model).split(':')[0] === CANDIDATE.split(':')[0]);
      if (me) {
        const vram = (me.size_vram || 0) / 1e6;
        const cpu = me.size_vram && me.size ? (1 - me.size_vram / me.size) : 0;
        console.log(`  REAL resident VRAM = ${gb(vram)}   ${cpu > 0.02 ? `⚠️ ${(cpu * 100).toFixed(0)}% on CPU (partial offload — model is too big to stay fully on GPU)` : '✅ fully on GPU'}`);
      }
      const smi2 = nvidiaSmi();
      if (smi2) console.log(`  GPU now: used=${gb(smi2.usedMb)}  free=${gb(smi2.freeMb)} of ${gb(smi2.totalMb)}`);
      const ps2 = await ollama('/api/ps');
      console.log(`  models resident now: ${(ps2.models || []).map((m: any) => m.name || m.model).join(', ') || '(none)'}`);
      console.log('\n  ✅ If free VRAM stayed ≥ 0 and the candidate shows "fully on GPU" with the');
      console.log('     warm models still resident, a bigger extraction model fits on this box.');
    } catch (e) {
      console.log(`  load failed: ${(e as Error).message}`);
    }
  } else {
    console.log('\n  (add --load to actually load the candidate and measure real VRAM.)');
  }
  console.log();
}

main().catch((e) => { console.error('fit test failed:', e?.message || e); process.exit(1); });
