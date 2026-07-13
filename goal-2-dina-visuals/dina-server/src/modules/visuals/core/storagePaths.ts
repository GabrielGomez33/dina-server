// File: src/modules/visuals/core/storagePaths.ts
// ============================================================================
// DINA VISUALS — STORAGE PATH RESOLUTION (security-critical, pure logic)
// ============================================================================
//
// All assets live on the dedicated 4TB SSD under VISUALS_ROOT (/mnt/visuals).
// The locked design requires: "Storage paths embed tenant_id so a path
// traversal can't cross tenants even if validation fails."
//
// This module is the ONLY place paths are built. It is pure (no fs/network),
// which makes its guarantees provable in the hermetic harness:
//
//   G1. Every returned path is strictly inside <root>/tenants/<tenantId>/.
//   G2. IDs are validated against a strict charset BEFORE joining — "../",
//       absolute paths, null bytes, URL-encoded dots etc. are all REJECTED,
//       never "cleaned up" (reject-don't-sanitize).
//   G3. A defense-in-depth containment check re-verifies the resolved path
//       prefix even if G2 were somehow bypassed.
//
// Callers get either a valid absolute path or a thrown VisualsPathError.
// ============================================================================

import * as path from 'path';

export class VisualsPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualsPathError';
  }
}

/** Asset classes with fixed sub-locations (mirrors the SSD layout). */
export type AssetArea =
  | 'raw'
  | 'captions'
  | 'manifests'
  | 'loras'
  | 'audio_source'
  | 'audio_stems'
  | 'audio_analysis'
  | 'gen_images'
  | 'gen_videos'
  | 'gen_lipsync'
  | 'exports';

const AREA_SUBPATH: Record<AssetArea, string[]> = {
  raw: ['raw'],
  captions: ['captions'],
  manifests: ['manifests'],
  loras: ['loras'],
  audio_source: ['audio', 'source'],
  audio_stems: ['audio', 'stems'],
  audio_analysis: ['audio', 'analysis'],
  gen_images: ['generations', 'images'],
  gen_videos: ['generations', 'videos'],
  gen_lipsync: ['generations', 'lipsync'],
  exports: ['exports'],
};

// UUID-shaped ids (tenant/project/generation ids are VARCHAR(36) UUIDs).
// Strict allow-list: hex + dashes only. Anything else is rejected.
const ID_RE = /^[0-9a-fA-F-]{8,36}$/;

// Filenames: conservative allow-list. No separators, no leading dot, no
// control chars. (Uploads are renamed server-side to safe names anyway; this
// is the final gate.)
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function assertSafeId(kind: string, value: string): void {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new VisualsPathError(`Invalid ${kind} id for storage path: ${JSON.stringify(String(value).slice(0, 60))}`);
  }
}

function assertSafeFilename(value: string): void {
  if (typeof value !== 'string' || !FILENAME_RE.test(value) || value.includes('..')) {
    throw new VisualsPathError(`Invalid filename for storage path: ${JSON.stringify(String(value).slice(0, 60))}`);
  }
}

export class StoragePaths {
  private readonly root: string;

  constructor(root: string = process.env.VISUALS_ROOT || '/mnt/visuals') {
    if (!root || !path.isAbsolute(root)) {
      throw new VisualsPathError(`VISUALS_ROOT must be an absolute path (got ${JSON.stringify(root)})`);
    }
    this.root = path.resolve(root);
  }

  /** <root>/tenants/<tenantId> — the isolation boundary. */
  tenantRoot(tenantId: string): string {
    assertSafeId('tenant', tenantId);
    return this.contain(path.join(this.root, 'tenants', tenantId), tenantId);
  }

  /** <root>/tenants/<tenantId>/projects/<projectId> */
  projectRoot(tenantId: string, projectId: string): string {
    assertSafeId('project', projectId);
    return this.contain(path.join(this.tenantRoot(tenantId), 'projects', projectId), tenantId);
  }

  /** Area directory inside a project, e.g. generations/videos. */
  areaDir(tenantId: string, projectId: string, area: AssetArea): string {
    const sub = AREA_SUBPATH[area];
    if (!sub) throw new VisualsPathError(`Unknown asset area: ${String(area)}`);
    return this.contain(path.join(this.projectRoot(tenantId, projectId), ...sub), tenantId);
  }

  /** Directory for one generation's outputs: .../generations/<kind>/<genId>/ */
  generationDir(tenantId: string, projectId: string, area: 'gen_images' | 'gen_videos' | 'gen_lipsync', generationId: string): string {
    assertSafeId('generation', generationId);
    return this.contain(path.join(this.areaDir(tenantId, projectId, area), generationId), tenantId);
  }

  /** A concrete file inside an area (filename validated, never trusted). */
  assetFile(tenantId: string, projectId: string, area: AssetArea, filename: string): string {
    assertSafeFilename(filename);
    return this.contain(path.join(this.areaDir(tenantId, projectId, area), filename), tenantId);
  }

  /** Scratch space — cleared on worker restart. Not tenant data. */
  tmpDir(): string {
    return path.join(this.root, 'tmp');
  }

  /**
   * G3 — defense-in-depth containment: even if an id slipped through the
   * charset gate, the resolved path MUST stay under the tenant's own root.
   * (path.resolve collapses any ../ so a traversal would escape the prefix
   * and be caught here.)
   */
  private contain(candidate: string, tenantId: string): string {
    const resolved = path.resolve(candidate);
    const boundary = path.resolve(this.root, 'tenants', tenantId) + path.sep;
    if (resolved !== boundary.slice(0, -1) && !resolved.startsWith(boundary)) {
      throw new VisualsPathError(
        `Path containment violation: resolved path escapes tenant boundary (tenant=${tenantId})`,
      );
    }
    return resolved;
  }
}
