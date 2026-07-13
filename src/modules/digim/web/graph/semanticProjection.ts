// File: src/modules/digim/web/graph/semanticProjection.ts
// ============================================================================
// DIGIM SEMANTIC VIEW — PCA PROJECTION (Phase 2.4b-4)
// ============================================================================
//
// The "n-dimensional coordinate graph": take the high-dimensional embedding
// vectors DINA already stores (mxbai-embed-large → 1024-D) and project them
// down to 3 coordinates so proximity in the cloud ≈ semantic proximity of the
// meaning. This is the third graph view (network / temporal / SEMANTIC).
//
// PURE + DETERMINISTIC on purpose:
//   • No randomness (Math.random is unavailable in this runtime anyway) — the
//     power-iteration seed is a fixed deterministic function of the index, so
//     the same corpus always yields the same cloud and the projection is
//     unit-testable without a DB or Redis.
//   • No D×D covariance matrix is ever materialized (D can be 1024). We use the
//     identity  C·w = Xᵀ(X·w)  so every iteration is O(N·D), not O(D²).
//
// Algorithm: mean-center → power-iterate for the top-3 principal components
// (deflating the data after each), project each point onto them, then rescale
// each axis to a stable [-1, 1] range for rendering.
// ============================================================================

export interface SemanticInputPoint {
  id: string;
  vector: number[];
  label?: string;
  url?: string;
  provider?: string;
}

export interface SemanticPoint {
  id: string;
  label: string;
  url: string;
  provider: string;
  x: number;
  y: number;
  z: number;
}

export interface SemanticProjection {
  points: SemanticPoint[];
  dimensions: number;      // original embedding dimensionality
  count: number;           // points projected
  explainedVariance: number[]; // fraction of total variance on each of the 3 axes
}

/** Deterministic unit-ish seed vector for power iteration (no RNG). */
function seedVector(dim: number, component: number): number[] {
  const w = new Array<number>(dim);
  // Distinct, spread-out seed per component; never all-zero, never orthogonally
  // degenerate against a previous seed.
  for (let j = 0; j < dim; j++) {
    w[j] = Math.sin((j + 1) * (component + 1) * 0.7 + component * 1.3);
  }
  return normalize(w);
}

function normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return v.slice();
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Dominant principal component of the (already centered) rows via power
 * iteration on the covariance implicitly:  w ← normalize( Xᵀ (X w) ).
 * Returns the unit eigenvector; `iterations` bounds cost (converges fast).
 */
function dominantComponent(rows: number[][], dim: number, component: number, iterations: number): number[] {
  let w = seedVector(dim, component);
  for (let iter = 0; iter < iterations; iter++) {
    // proj[i] = row_i · w   (N-dim)
    const acc = new Array<number>(dim).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += row[j] * w[j];
      // accumulate dot * row into Xᵀ(Xw)
      for (let j = 0; j < dim; j++) acc[j] += dot * row[j];
    }
    const next = normalize(acc);
    // Early stop when the direction stabilizes.
    let delta = 0;
    for (let j = 0; j < dim; j++) delta += Math.abs(next[j] - w[j]);
    w = next;
    if (delta < 1e-7) break;
  }
  return w;
}

/** Variance of the rows' projection onto unit vector w. */
function projectedVariance(rows: number[][], w: number[], dim: number): number {
  let sumSq = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += row[j] * w[j];
    sumSq += dot * dot;
  }
  return rows.length > 0 ? sumSq / rows.length : 0;
}

/** Remove the component `w` from every row (deflation), in place on a copy. */
function deflate(rows: number[][], w: number[], dim: number): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += row[j] * w[j];
    for (let j = 0; j < dim; j++) row[j] -= dot * w[j];
  }
}

/** Rescale a coordinate array to [-1, 1] symmetric around 0. */
function rescaleAxis(vals: number[]): number[] {
  let max = 0;
  for (const v of vals) { const a = Math.abs(v); if (a > max) max = a; }
  if (max < 1e-12) return vals.map(() => 0);
  return vals.map((v) => v / max);
}

/**
 * Project embedding vectors to 3D via PCA. Pure and deterministic. Vectors of
 * inconsistent length (relative to the modal dimension) are skipped so a stray
 * bad row can't corrupt the geometry. With < 2 usable points it returns them at
 * the origin (nothing meaningful to spread).
 */
export function projectEmbeddings(
  inputs: SemanticInputPoint[],
  opts: { iterations?: number } = {}
): SemanticProjection {
  const iterations = Math.max(1, Math.min(opts.iterations ?? 40, 500));

  const valid = (inputs || []).filter((p) => p && Array.isArray(p.vector) && p.vector.length > 0);
  if (valid.length === 0) {
    return { points: [], dimensions: 0, count: 0, explainedVariance: [0, 0, 0] };
  }

  // Use the modal dimensionality; drop rows that don't match it.
  const dimCounts = new Map<number, number>();
  for (const p of valid) dimCounts.set(p.vector.length, (dimCounts.get(p.vector.length) || 0) + 1);
  let dim = valid[0].vector.length;
  let best = 0;
  for (const [d, c] of dimCounts) if (c > best) { best = c; dim = d; }
  const usable = valid.filter((p) => p.vector.length === dim);

  const toPoint = (p: SemanticInputPoint, x: number, y: number, z: number): SemanticPoint => ({
    id: p.id,
    label: p.label || p.url || p.id,
    url: p.url || '',
    provider: p.provider || '',
    x, y, z,
  });

  if (usable.length < 2) {
    return {
      points: usable.map((p) => toPoint(p, 0, 0, 0)),
      dimensions: dim,
      count: usable.length,
      explainedVariance: [0, 0, 0],
    };
  }

  // Mean-center.
  const mean = new Array<number>(dim).fill(0);
  for (const p of usable) for (let j = 0; j < dim; j++) mean[j] += p.vector[j];
  for (let j = 0; j < dim; j++) mean[j] /= usable.length;
  const centered: number[][] = usable.map((p) => {
    const row = new Array<number>(dim);
    for (let j = 0; j < dim; j++) row[j] = p.vector[j] - mean[j];
    return row;
  });

  // Total variance (for the explained-variance fractions).
  let totalVar = 0;
  for (const row of centered) for (let j = 0; j < dim; j++) totalVar += row[j] * row[j];
  totalVar = totalVar / usable.length || 1;

  // Top-3 components via power iteration + deflation. Work on a copy we deflate.
  const work = centered.map((r) => r.slice());
  const comps: number[][] = [];
  const variances: number[] = [];
  for (let c = 0; c < 3; c++) {
    const w = dominantComponent(work, dim, c, iterations);
    comps.push(w);
    variances.push(projectedVariance(work, w, dim));
    deflate(work, w, dim);
  }

  // Project ORIGINAL centered rows onto the components.
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (const row of centered) {
    let dx = 0, dy = 0, dz = 0;
    for (let j = 0; j < dim; j++) {
      dx += row[j] * comps[0][j];
      dy += row[j] * comps[1][j];
      dz += row[j] * comps[2][j];
    }
    xs.push(dx); ys.push(dy); zs.push(dz);
  }
  const rx = rescaleAxis(xs), ry = rescaleAxis(ys), rz = rescaleAxis(zs);

  const points = usable.map((p, i) => toPoint(p, rx[i], ry[i], rz[i]));
  return {
    points,
    dimensions: dim,
    count: points.length,
    explainedVariance: variances.map((v) => (totalVar > 0 ? v / totalVar : 0)),
  };
}
