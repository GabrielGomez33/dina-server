// File: src/modules/saga/types/index.ts
// ============================================================================
// DINA SAGA MODULE — TYPE CONTRACT
// ============================================================================
// The single source of truth for every shape the saga module speaks:
// tenancy, projects, manifests, audio, generations, jobs, and the live
// progress-event schema consumed by the frontend progress bar. Mirrors the
// locked Pipeline Plan v2 decisions (multi-tenant, soft-delete, TTL pruning,
// all three audio modes, detailed progress UX).
// ============================================================================

// ---- Tenancy ----------------------------------------------------------------

export type PlanTier = 'free' | 'pro' | 'admin';
export type MembershipRole = 'owner' | 'editor' | 'viewer';

export interface SagaTenant {
  id: string;
  name: string;
  slug: string;
  plan: PlanTier;
  quotaBytes: number;
  gpuPriority: number; // 1-10, job-queue ordering hook
  createdAt: string;
  deletedAt?: string | null;
}

export interface SagaMembership {
  id: string;
  tenantId: string;
  userId: string; // dina_users.dina_key
  role: MembershipRole;
}

// ---- Projects / Manifests ---------------------------------------------------

export type ProjectStatus = 'active' | 'archived';
export type ManifestStatus = 'draft' | 'frozen' | 'retired';

export interface SagaProject {
  id: string;
  tenantId: string;
  slug: string;
  ownerUserId: string;
  status: ProjectStatus;
  bytesUsed: number;
  createdAt: string;
  deletedAt?: string | null;
}

export interface SagaManifest {
  id: string;
  projectId: string;
  version: number;
  status: ManifestStatus;
  manifest: Record<string, unknown>; // refs, tags, loras, style config
  createdAt: string;
  frozenAt?: string | null;
}

// ---- Audio ------------------------------------------------------------------

export type AudioAnalysisStatus = 'pending' | 'analyzing' | 'complete' | 'failed';

/** The three toggleable music-video modes (all supported, any combination). */
export interface AudioModes {
  beatSync: boolean; // cuts/motion on beats
  lyricSync: boolean; // prompt timeline per phrase
  lipSync: boolean; // mouth animation on character shots
}

export interface SagaAudioTrack {
  id: string;
  projectId: string;
  filename: string;
  storagePath: string;
  bytes: number;
  analysisStatus: AudioAnalysisStatus;
  /** Cached forever once computed: beats.json + lyrics.json + vocal_segments.json */
  analysis?: {
    bpm?: number;
    beats?: number[]; // beat timestamps (s)
    downbeats?: number[];
    energy?: Array<{ t: number; v: number }>;
    lyrics?: Array<{ word: string; start: number; end: number }>;
    vocalSegments?: Array<[number, number]>;
  } | null;
}

// ---- Generations ------------------------------------------------------------

export type GenerationKind = 'image' | 'video' | 'music_video' | 'lipsync' | 'upscale';
export type GenerationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SagaGeneration {
  id: string;
  projectId: string;
  kind: GenerationKind;
  status: GenerationStatus;
  params: Record<string, unknown>; // prompt, model, loras, controlnets, dims
  seed?: number | null;
  model?: string | null;
  parentGenerationId?: string | null; // lineage: re-rolls & chained shots
  audioTrackId?: string | null;
  storagePath?: string | null;
  bytes: number;
  promoted: boolean; // promoted → exports (TTL-immune)
  ttlExpiresAt?: string | null;
  createdAt: string;
  completedAt?: string | null;
  deletedAt?: string | null;
}

/** One entry of the unified ShotPlan (beats define cuts → lyrics modulate prompts
 *  within shots → lipsync flags shots needing the post-pass). */
export interface ShotPlanEntry {
  start: number;
  end: number;
  prompt: string;
  sourceImage?: string;
  lipsync: boolean;
  vocalSegment?: [number, number];
}

// ---- Jobs & live progress (WebSocket → frontend progress bar) ----------------

export type JobKind =
  | 'caption'
  | 'lora_train'
  | 'image_gen'
  | 'video_gen'
  | 'audio_analyze'
  | 'lipsync'
  | 'assemble'
  | 'janitor';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Progress event schema (locked in Pipeline Plan v2). Re-emitted from ComfyUI's
 *  WS with phase weights so the bar reflects TOTAL work, not just the sub-step. */
export interface JobProgress {
  job_id: string;
  job_kind: JobKind;
  phase: string; // "Loading model", "Sampling step 14/30", "Encoding"
  pct: number; // 0-100, monotonic per phase
  overall_pct: number; // 0-100, weighted across phases
  eta_seconds: number | null;
  current_step?: { idx: number; total: number };
  preview_url?: string; // /tenants/.../previews/step_014.webp
  vram_mb?: number;
  message?: string;
  warnings?: string[];
}

export interface SagaJob {
  id: string;
  tenantId: string;
  projectId: string;
  generationId?: string | null;
  kind: JobKind;
  state: JobState;
  priority: number;
  progress?: JobProgress | null;
  errorText?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

// ---- DUMP integration (structural, dependency-injected like truthStreamRoutes) ----

/** Structural view of a DinaUniversalMessage — the fields the saga module
 *  reads. Structurally compatible with core/protocol's interface, so the module
 *  never imports across module boundaries (no intertwined logic). */
export interface SagaDumpMessage {
  id: string;
  target: { module: string; method: string; priority: number };
  security: { user_id?: string; session_id?: string; clearance?: unknown; sanitized: boolean };
  payload: { data: any; context?: any };
}

export interface SagaSessionInfo {
  userId: string;
  sessionId: string;
}

/** Uniform result each saga handler returns (the orchestrator wraps it into
 *  a DinaResponse, exactly like mirror handlers). */
export interface SagaHandlerResult {
  success: boolean;
  data?: any;
  error?: { code: string; message: string };
}

// ---- Injected infrastructure (ports) -----------------------------------------
// The module depends on INTERFACES, not concrete singletons, matching the
// injection pattern proven by truthStreamRoutes.ts (DinaInstance /
// CreateDinaMessageFn). Production passes the real database/redis; tests pass fakes.

export interface DbPort {
  query(sql: string, params?: any[]): Promise<any>;
  log?(level: string, module: string, message: string, meta?: Record<string, any>): Promise<void>;
}

export interface JobQueuePort {
  enqueue(job: { id: string; kind: JobKind; priority: number; payload: Record<string, unknown> }): Promise<void>;
  cancel(jobId: string): Promise<boolean>;
}

export interface ProgressSinkPort {
  emit(event: JobProgress): void;
}
