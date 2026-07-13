// File: src/modules/visuals/index.ts
// ============================================================================
// DINA VISUALS MODULE — CORE IMPLEMENTATION (foundation slice)
// ============================================================================
//
// The new DINA "limb" for local image/video generation (ComfyUI + FLUX/SDXL/
// Wan/HunyuanVideo + audio pipeline). Follows the proven MirrorModule anatomy:
//
//   • singleton class, initialize()'d by dinaCore (Phase 5 in the orchestrator)
//   • all requests arrive as DUMP messages via orchestrator case 'visuals'
//   • one handler per method; validation at the boundary (methodRegistry)
//   • separation of concerns: pure cores (paths/quota/ttl/registry) hold the
//     logic; this class only wires validation → authorization → dispatch
//   • infrastructure is INJECTED (DbPort/JobQueuePort/ProgressSinkPort), the
//     pattern truthStreamRoutes proved — production passes the real
//     database/redis singletons, tests pass fakes. No cross-module imports.
//
// GPU SAFETY: this module never touches the GPU inline. Generation methods
// only VALIDATE + RECORD + ENQUEUE; the job worker (phase 2b) takes an
// exclusive gpuArbiter lease around the actual ComfyUI call, so interactive
// @Dina chat always keeps priority and Ollama is drained/re-warmed safely.
// ============================================================================

import {
  DbPort,
  JobQueuePort,
  ProgressSinkPort,
  VisualsDumpMessage,
  VisualsHandlerResult,
  VisualsSessionInfo,
  MembershipRole,
} from './types';
import { getMethodSpec, isVisualsMethod, validatePayload, VISUALS_METHODS } from './core/methodRegistry';
import { StoragePaths } from './core/storagePaths';
import { admitWrite, resolveQuota } from './core/quota';
import { ttlExpiryFor } from './core/ttlPolicy';

export { VISUALS_METHODS, isVisualsMethod } from './core/methodRegistry';

// Role power ordering for authorization checks.
const ROLE_RANK: Record<MembershipRole, number> = { viewer: 1, editor: 2, owner: 3 };

export class VisualsModuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
  ) {
    super(message);
    this.name = 'VisualsModuleError';
  }
}

export interface VisualsModuleDeps {
  db: DbPort;
  jobs: JobQueuePort;
  progress?: ProgressSinkPort;
  storage?: StoragePaths;
  /** id generator injected for deterministic tests; production uses crypto UUIDs. */
  newId?: () => string;
  now?: () => number;
}

export class VisualsModule {
  private db!: DbPort;
  private jobs!: JobQueuePort;
  private progress: ProgressSinkPort | null = null;
  private storage!: StoragePaths;
  private newId!: () => string;
  private now!: () => number;
  private initialized = false;

  private readonly MODULE_VERSION = '0.1.0';

  /** Wire dependencies. Called once from dinaCore.initialize() (Phase 5). */
  async initialize(deps: VisualsModuleDeps): Promise<void> {
    if (this.initialized) return;
    this.db = deps.db;
    this.jobs = deps.jobs;
    this.progress = deps.progress ?? null;
    this.storage = deps.storage ?? new StoragePaths();
    this.newId = deps.newId ?? (() => require('crypto').randomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.initialized = true;
    console.log(`🎬 Visuals Module v${this.MODULE_VERSION} initialized`);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  // ==========================================================================
  // DUMP ENTRY POINT — the orchestrator's `case 'visuals'` calls this.
  // Uniform pipeline for every method:
  //   guard init → method known → payload valid → membership authorized → handler
  // Every failure returns a structured error result; nothing throws upward
  // except protocol-level misuse (unknown module state), matching mirror.
  // ==========================================================================

  async handleVisualsMessage(message: VisualsDumpMessage, session: VisualsSessionInfo): Promise<VisualsHandlerResult> {
    if (!this.initialized) {
      return err('MODULE_NOT_READY', 'Visuals module is not initialized');
    }

    const method = message.target?.method;
    if (!method || !isVisualsMethod(method)) {
      return err('UNKNOWN_METHOD', `Unknown visuals method: ${String(method)}`);
    }

    const data = message.payload?.data ?? {};
    const validation = validatePayload(method, data);
    if (!validation.valid) {
      return err('INVALID_REQUEST', validation.errors.join('; '));
    }

    try {
      // Authorization: any method that names a tenant requires membership.
      if (typeof (data as any).tenantId === 'string') {
        const required: MembershipRole = getMethodSpec(method)!.mutating ? 'editor' : 'viewer';
        const authorized = await this.isMember((data as any).tenantId, session.userId, required);
        if (!authorized) {
          return err('FORBIDDEN', `User is not an authorized ${required} of tenant`);
        }
      }

      switch (method) {
        case 'visuals_create_tenant':
          return await this.createTenant(data, session);
        case 'visuals_create_project':
          return await this.createProject(data, session);
        case 'visuals_get_project':
          return await this.getProject(data);
        case 'visuals_delete_project':
          return await this.softDeleteProject(data);
        case 'visuals_generate_image':
          return await this.enqueueGeneration('image', 'image_gen', data);
        case 'visuals_generate_video':
          return await this.enqueueGeneration('video', 'video_gen', data);
        case 'visuals_generate_music_video':
          return await this.enqueueGeneration('music_video', 'video_gen', data);
        case 'visuals_train_lora':
          return await this.enqueueLoraTraining(data);
        case 'visuals_audio_analyze':
          return await this.enqueueAudioAnalysis(data);
        case 'visuals_job_status':
          return await this.jobStatus(data);
        case 'visuals_job_cancel':
          return await this.jobCancel(data);
        case 'visuals_promote_generation':
          return await this.promoteGeneration(data);
        case 'visuals_get_status':
          return this.moduleStatus();
        default:
          // Registry and switch must stay in lockstep; the harness proves it.
          return err('UNHANDLED_METHOD', `Method registered but not dispatched: ${method}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`❌ [visuals] ${method} failed: ${msg}`);
      await this.db.log?.('error', 'visuals', `${method} failed`, { error: msg, user: session.userId });
      return err('PROCESSING_ERROR', msg);
    }
  }

  // ==========================================================================
  // HANDLERS (foundation slice: tenancy/projects/lifecycle are complete;
  // generation handlers validate + record + enqueue — the worker is phase 2b)
  // ==========================================================================

  private async createTenant(data: any, session: VisualsSessionInfo): Promise<VisualsHandlerResult> {
    const id = this.newId();
    const plan = ['free', 'pro', 'admin'].includes(data.plan) ? data.plan : 'free';
    const quota = resolveQuota(plan);
    await this.db.query(
      `INSERT INTO visuals_tenants (id, name, slug, plan, quota_bytes) VALUES (?, ?, ?, ?, ?)`,
      [id, String(data.name).trim(), slugify(data.slug), plan, quota],
    );
    await this.db.query(
      `INSERT INTO visuals_memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, 'owner')`,
      [this.newId(), id, session.userId],
    );
    return okr({ tenantId: id, plan, quotaBytes: quota });
  }

  private async createProject(data: any, session: VisualsSessionInfo): Promise<VisualsHandlerResult> {
    const id = this.newId();
    await this.db.query(
      `INSERT INTO visuals_projects (id, tenant_id, slug, owner_user_id) VALUES (?, ?, ?, ?)`,
      [id, data.tenantId, slugify(data.slug), session.userId],
    );
    // Resolve (and thereby validate) the project's storage root now — fails
    // fast on a malformed tenant/project id before anything touches disk.
    const root = this.storage.projectRoot(data.tenantId, id);
    return okr({ projectId: id, storageRoot: root });
  }

  private async getProject(data: any): Promise<VisualsHandlerResult> {
    const rows = await this.db.query(
      `SELECT id, tenant_id, slug, owner_user_id, status, bytes_used, created_at, deleted_at
         FROM visuals_projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [data.projectId, data.tenantId],
    );
    const row = firstRow(rows);
    if (!row) return err('NOT_FOUND', 'Project not found');
    return okr({ project: row });
  }

  private async softDeleteProject(data: any): Promise<VisualsHandlerResult> {
    const res = await this.db.query(
      `UPDATE visuals_projects SET deleted_at = NOW() WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [data.projectId, data.tenantId],
    );
    if (!affectedRows(res)) return err('NOT_FOUND', 'Project not found (or already deleted)');
    return okr({ projectId: data.projectId, recoverableForDays: 30 });
  }

  /** Shared path for image/video/music-video: quota-check → record → enqueue. */
  private async enqueueGeneration(
    kind: 'image' | 'video' | 'music_video',
    jobKind: 'image_gen' | 'video_gen',
    data: any,
  ): Promise<VisualsHandlerResult> {
    // 1. Quota admission BEFORE any work (estimate by kind; refined in 2b).
    const estimate = kind === 'image' ? 20 * 1024 ** 2 : 500 * 1024 ** 2;
    const tenant = await this.tenantRow(data.tenantId);
    if (!tenant) return err('NOT_FOUND', 'Tenant not found');
    const usage = await this.tenantBytesUsed(data.tenantId);
    const decision = admitWrite(usage, estimate, resolveQuota(tenant.plan, tenant.quota_bytes));
    if (!decision.allowed) {
      return err('QUOTA_EXCEEDED', `Write would exceed quota by ${decision.shortfallBytes} bytes`);
    }

    // 2. Record the generation with lineage + TTL by kind.
    const genId = this.newId();
    const ttl = ttlExpiryFor(kind === 'image' ? 'gen_image' : 'gen_video', this.now());
    await this.db.query(
      `INSERT INTO visuals_generations (id, project_id, kind, status, params_json, seed, parent_generation_id, audio_track_id, ttl_expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        genId,
        data.projectId,
        kind,
        JSON.stringify(data.params ?? {}),
        numOrNull(data.params?.seed),
        strOrNull(data.params?.parentGenerationId),
        strOrNull(data.audioTrackId),
        ttl,
      ],
    );

    // 3. Record + enqueue the job (worker takes the exclusive GPU lease in 2b).
    const jobId = this.newId();
    const priority = Number(tenant.gpu_priority) || 5;
    await this.db.query(
      `INSERT INTO visuals_jobs (id, tenant_id, project_id, generation_id, kind, priority) VALUES (?, ?, ?, ?, ?, ?)`,
      [jobId, data.tenantId, data.projectId, genId, jobKind, priority],
    );
    await this.jobs.enqueue({
      id: jobId,
      kind: jobKind,
      priority,
      payload: { generationId: genId, tenantId: data.tenantId, projectId: data.projectId, kind, modes: data.modes },
    });

    return okr({ generationId: genId, jobId, ttlExpiresAt: ttl ? ttl.toISOString() : null });
  }

  private async enqueueLoraTraining(data: any): Promise<VisualsHandlerResult> {
    const jobId = this.newId();
    await this.db.query(
      `INSERT INTO visuals_jobs (id, tenant_id, project_id, kind) VALUES (?, ?, ?, 'lora_train')`,
      [jobId, data.tenantId, data.projectId],
    );
    await this.jobs.enqueue({ id: jobId, kind: 'lora_train', priority: 5, payload: { manifestId: data.manifestId } });
    return okr({ jobId });
  }

  private async enqueueAudioAnalysis(data: any): Promise<VisualsHandlerResult> {
    // Cache check: analysis runs once per track, results cached forever.
    const rows = await this.db.query(
      `SELECT analysis_status FROM visuals_audio_tracks WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
      [data.audioTrackId, data.projectId],
    );
    const row = firstRow(rows);
    if (!row) return err('NOT_FOUND', 'Audio track not found');
    if (row.analysis_status === 'complete') return okr({ cached: true, audioTrackId: data.audioTrackId });

    const jobId = this.newId();
    await this.db.query(
      `INSERT INTO visuals_jobs (id, tenant_id, project_id, kind) VALUES (?, ?, ?, 'audio_analyze')`,
      [jobId, data.tenantId, data.projectId],
    );
    await this.jobs.enqueue({ id: jobId, kind: 'audio_analyze', priority: 5, payload: { audioTrackId: data.audioTrackId } });
    return okr({ cached: false, jobId });
  }

  private async jobStatus(data: any): Promise<VisualsHandlerResult> {
    const rows = await this.db.query(
      `SELECT id, kind, state, priority, progress_json, error_text, created_at, started_at, finished_at
         FROM visuals_jobs WHERE id = ? AND tenant_id = ?`,
      [data.jobId, data.tenantId],
    );
    const row = firstRow(rows);
    if (!row) return err('NOT_FOUND', 'Job not found');
    return okr({ job: row });
  }

  private async jobCancel(data: any): Promise<VisualsHandlerResult> {
    const res = await this.db.query(
      `UPDATE visuals_jobs SET state = 'cancelled', finished_at = NOW()
        WHERE id = ? AND tenant_id = ? AND state IN ('queued','running')`,
      [data.jobId, data.tenantId],
    );
    if (!affectedRows(res)) return err('NOT_CANCELLABLE', 'Job not found or already finished');
    const workerCancelled = await this.jobs.cancel(data.jobId);
    return okr({ jobId: data.jobId, workerCancelled });
  }

  private async promoteGeneration(data: any): Promise<VisualsHandlerResult> {
    // Promotion is TTL-immunity: promoted=1 AND ttl cleared, atomically.
    const res = await this.db.query(
      `UPDATE visuals_generations g
         JOIN visuals_projects p ON p.id = g.project_id
          SET g.promoted = 1, g.ttl_expires_at = NULL
        WHERE g.id = ? AND g.project_id = ? AND p.tenant_id = ? AND g.deleted_at IS NULL`,
      [data.generationId, data.projectId, data.tenantId],
    );
    if (!affectedRows(res)) return err('NOT_FOUND', 'Generation not found');
    return okr({ generationId: data.generationId, promoted: true });
  }

  private moduleStatus(): VisualsHandlerResult {
    return okr({
      module: 'visuals',
      version: this.MODULE_VERSION,
      initialized: this.initialized,
      methods: VISUALS_METHODS.map((m) => m.method),
    });
  }

  // ==========================================================================
  // AUTHZ / LOOKUP HELPERS
  // ==========================================================================

  private async isMember(tenantId: string, userId: string, required: MembershipRole): Promise<boolean> {
    if (!tenantId || !userId) return false;
    const rows = await this.db.query(
      `SELECT role FROM visuals_memberships WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId],
    );
    const row = firstRow(rows);
    if (!row) return false;
    const have = ROLE_RANK[row.role as MembershipRole] ?? 0;
    return have >= ROLE_RANK[required];
  }

  private async tenantRow(tenantId: string): Promise<any | null> {
    const rows = await this.db.query(
      `SELECT id, plan, quota_bytes, gpu_priority FROM visuals_tenants WHERE id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    return firstRow(rows);
  }

  private async tenantBytesUsed(tenantId: string): Promise<number> {
    const rows = await this.db.query(
      `SELECT COALESCE(SUM(bytes_used),0) AS used FROM visuals_projects WHERE tenant_id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    const row = firstRow(rows);
    return Number(row?.used ?? 0);
  }
}

// ---- small pure helpers ------------------------------------------------------

function okr(data: any): VisualsHandlerResult {
  return { success: true, data };
}
function err(code: string, message: string): VisualsHandlerResult {
  return { success: false, error: { code, message } };
}
function slugify(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
function firstRow(rows: any): any | null {
  // mysql2 returns [rows, fields] from .query() in some wrappers and plain
  // arrays in others (database.query in this repo returns rows directly).
  const arr = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}
function affectedRows(res: any): number {
  const r = Array.isArray(res) ? res[0] : res;
  return Number(r?.affectedRows ?? 0);
}
function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

// Process-wide singleton, mirroring `export const mirrorModule = new MirrorModule()`.
export const visualsModule = new VisualsModule();
