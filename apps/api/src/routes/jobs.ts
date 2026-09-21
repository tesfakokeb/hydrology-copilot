import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function jobRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  app.get('/api/jobs', { ...auth, schema: { tags: ['jobs'], summary: 'List jobs for a project.' } }, async (req) => {
    const { projectId, limit } = req.query as { projectId?: string; limit?: string };
    return {
      data: {
        jobs: await ctx.store.db.listJobs(projectId, limit ? Number(limit) : 50),
        stats: ctx.queue.stats,
        kinds: ctx.queue.registeredKinds,
      },
    };
  });

  app.get('/api/jobs/:id', { ...auth, schema: { tags: ['jobs'], summary: 'Job detail with logs.' } }, async (req, reply) => {
    const job = await ctx.store.db.getJob((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No job with that identifier.' } });
    return { data: job };
  });

  app.post('/api/jobs/:id/cancel', { ...auth, schema: { tags: ['jobs'], summary: 'Cancel a queued job. A running scientific computation is not interrupted.' } }, async (req, reply) => {
    const cancelled = await ctx.queue.cancel((req.params as { id: string }).id);
    if (!cancelled) {
      return reply.code(409).send({
        error: {
          code: 'NOT_CANCELLABLE',
          message: 'The job is already running or has finished. A running computation is not interrupted, because cancelling one mid-way would leave partial results.',
        },
      });
    }
    return { data: { cancelled: true } };
  });
}
