// File: src/modules/saga/systems/jobQueue.ts
// ============================================================================
// DINA SAGA — JOB QUEUE PORT IMPLEMENTATIONS
// ============================================================================
// Phase 1 ships StubJobQueue: SAGA's API surface (tenancy, projects, quota,
// job records) is fully live, while actual execution waits for the Phase 2
// generation worker. The stub is honest — it logs loudly that the job is
// recorded but NOT executed, so a queued job can never be mistaken for a
// running one. The DB row (saga_jobs.state='queued') is written by the module
// before enqueue, so Phase 2's worker can adopt every job the stub accepted.
//
// Phase 2 replaces this with the worker-backed queue (same JobQueuePort, so
// the module does not change — that is the point of the port).
// ============================================================================

import { JobKind, JobQueuePort } from '../types';

export class StubJobQueue implements JobQueuePort {
  private accepted = 0;

  async enqueue(job: { id: string; kind: JobKind; priority: number; payload: Record<string, unknown> }): Promise<void> {
    this.accepted++;
    console.log(
      `🎬 [saga.jobQueue:STUB] job ${job.id} (${job.kind}, prio ${job.priority}) recorded as queued — ` +
        `execution engine lands in Phase 2. (${this.accepted} accepted this process)`,
    );
  }

  async cancel(jobId: string): Promise<boolean> {
    // Nothing is executing yet, so worker-level cancellation is trivially true;
    // the module has already flipped the DB row to 'cancelled'.
    console.log(`🎬 [saga.jobQueue:STUB] cancel(${jobId}) — no execution engine yet, DB state is authoritative.`);
    return true;
  }
}
