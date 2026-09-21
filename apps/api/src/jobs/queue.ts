import { randomUUID } from 'node:crypto';
import type { Job } from '@hydro/shared-types';
import type { EventBus } from '../plugins/ws.js';
import type { DataAccess } from '../store/types.js';

export type JobHandler = (job: Job, report: (progress: number, message: string) => Promise<void>) => Promise<{ outputLocation?: string | null; result?: unknown }>;

/**
 * Asynchronous job queue (§21).
 *
 * Long-running analyses — model calibration, report generation, dataset
 * profiling — run here rather than on the request thread, with the lifecycle
 * `queued → running → completed | failed | cancelled`, progress reporting and
 * WebSocket notifications.
 *
 * ## Execution backend
 *
 * Jobs currently execute **in-process** with bounded concurrency, whether or
 * not REDIS_URL is set, and `stats.backend` reports that truthfully. The
 * BullMQ integration point is `enqueue()` and `run()`: replacing the internal
 * `pending` array with a BullMQ `Queue`, and `run()` with a BullMQ `Worker`
 * consuming it, is the whole change. Everything else — the database record,
 * the progress callback, the WebSocket events, the handler contract — is
 * already backend-agnostic.
 *
 * It is reported rather than claimed because a queue that says "redis" while
 * running in one process would mislead an operator about durability and about
 * whether a second worker replica does anything.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private running = new Set<string>();
  private pending: string[] = [];
  private concurrency = 2;

  constructor(
    private readonly db: DataAccess,
    private readonly bus: EventBus,
    private readonly log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void },
    /** Set when REDIS_URL is configured, so status can say what is available. */
    private readonly redisConfigured = false,
  ) {}

  /** What actually runs the jobs. See the class comment. */
  readonly backend = 'in-process' as const;

  get durability(): string {
    return this.redisConfigured
      ? 'REDIS_URL is configured, but jobs execute in-process in this build: they do not survive a restart and additional replicas do not share the queue.'
      : 'No REDIS_URL configured. Jobs execute in-process and do not survive a restart.';
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  get registeredKinds(): string[] {
    return [...this.handlers.keys()];
  }

  async enqueue(kind: string, projectId: string | null, userId: string, payload: Record<string, unknown> = {}): Promise<Job> {
    if (!this.handlers.has(kind)) {
      throw new Error(`No handler is registered for job kind "${kind}". Registered kinds: ${this.registeredKinds.join(', ')}.`);
    }
    const job = await this.db.createJob({
      kind,
      projectId,
      userId,
      status: 'queued',
      progress: 0,
      message: 'Queued',
      startedAt: null,
      finishedAt: null,
      outputLocation: null,
      error: null,
      logs: [{ t: new Date().toISOString(), level: 'info', message: `Job queued (${kind}).` }],
    });
    (job as Job & { payload?: unknown }).payload = payload;
    this.pending.push(job.id);
    setImmediate(() => void this.drain());
    return job;
  }

  private async drain(): Promise<void> {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      this.running.add(id);
      void this.run(id).finally(() => {
        this.running.delete(id);
        void this.drain();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const job = await this.db.getJob(id);
    if (!job) return;
    const handler = this.handlers.get(job.kind);
    if (!handler) return;

    const report = async (progress: number, message: string) => {
      await this.db.updateJob(id, { progress: Math.round(progress), message });
      if (job.projectId) this.bus.publish(job.projectId, { type: 'job.progress', jobId: id, progress: Math.round(progress), message });
    };

    await this.db.updateJob(id, { status: 'running', startedAt: new Date().toISOString(), progress: 1, message: 'Running' });
    if (job.projectId) this.bus.publish(job.projectId, { type: 'job.progress', jobId: id, progress: 1, message: 'Running' });

    try {
      const out = await handler(job, report);
      await this.db.updateJob(id, {
        status: 'completed',
        progress: 100,
        message: 'Completed',
        finishedAt: new Date().toISOString(),
        outputLocation: out.outputLocation ?? null,
      });
      if (job.projectId) this.bus.publish(job.projectId, { type: 'job.completed', jobId: id, outputLocation: out.outputLocation ?? null });
      this.log.info({ jobId: id, kind: job.kind }, 'Job completed');
    } catch (err) {
      const message = (err as Error).message;
      await this.db.updateJob(id, { status: 'failed', message: 'Failed', error: message, finishedAt: new Date().toISOString() });
      if (job.projectId) this.bus.publish(job.projectId, { type: 'job.failed', jobId: id, error: message });
      this.log.error({ err, jobId: id, kind: job.kind }, 'Job failed');
    }
  }

  async cancel(id: string): Promise<boolean> {
    const idx = this.pending.indexOf(id);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      await this.db.updateJob(id, { status: 'cancelled', message: 'Cancelled before it started', finishedAt: new Date().toISOString() });
      return true;
    }
    // A running job is not interrupted mid-computation; cancellation of an
    // in-flight scientific computation would leave partial state.
    return false;
  }

  get stats(): { queued: number; running: number; backend: string; concurrency: number; durability: string } {
    return {
      queued: this.pending.length,
      running: this.running.size,
      backend: this.backend,
      concurrency: this.concurrency,
      durability: this.durability,
    };
  }
}

export function newJobId(): string {
  return randomUUID();
}
