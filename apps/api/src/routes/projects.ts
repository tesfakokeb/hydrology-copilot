import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';

const createSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  agency: z.string().max(160).optional(),
  unitSystem: z.enum(['SI', 'US']).default('SI'),
  defaultWatershedId: z.string().optional(),
});

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  app.get('/api/projects', { ...auth, schema: { tags: ['projects'], summary: 'Projects visible to the authenticated user.' } }, async (req) => ({
    data: await ctx.store.db.listProjects(req.user!.id),
  }));

  app.get('/api/projects/:id', { ...auth, schema: { tags: ['projects'], summary: 'Project detail.' } }, async (req, reply) => {
    const project = await ctx.store.db.getProject((req.params as { id: string }).id, req.user!.id);
    if (!project) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No project with that identifier, or you do not have access to it.' } });
    const watersheds = await ctx.store.db.listWatersheds(project.id);
    return { data: { project, watersheds } };
  });

  app.post('/api/projects', { preHandler: [app.authenticate, requireRole('analyst')], schema: { tags: ['projects'], summary: 'Create a project.' } }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'A project name is required.', details: parsed.error.issues } });
    const project = await ctx.store.db.createProject({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      agency: parsed.data.agency ?? null,
      unitSystem: parsed.data.unitSystem,
      defaultWatershedId: parsed.data.defaultWatershedId ?? null,
      createdBy: req.user!.id,
    });
    return reply.code(201).send({ data: project });
  });

  app.patch('/api/projects/:id', { preHandler: [app.authenticate, requireRole('analyst')], schema: { tags: ['projects'], summary: 'Update a project.' } }, async (req, reply) => {
    const parsed = createSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'Invalid update.', details: parsed.error.issues } });
    const updated = await ctx.store.db.updateProject((req.params as { id: string }).id, req.user!.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No project with that identifier, or you are not its owner.' } });
    return { data: updated };
  });

  app.delete('/api/projects/:id', { preHandler: [app.authenticate, requireRole('modeler')], schema: { tags: ['projects'], summary: 'Delete a project.' } }, async (req, reply) => {
    const okDeleted = await ctx.store.db.deleteProject((req.params as { id: string }).id, req.user!.id);
    if (!okDeleted) {
      return reply.code(409).send({
        error: { code: 'NOT_DELETED', message: 'The project could not be deleted. The pre-loaded demonstration project is protected, and you must own a project to delete it.' },
      });
    }
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/scenarios', { ...auth, schema: { tags: ['projects'], summary: 'Saved scenarios for a project.' } }, async (req) => ({
    data: await ctx.store.db.listScenarios((req.params as { id: string }).id),
  }));

  app.post('/api/projects/:id/scenarios', { preHandler: [app.authenticate, requireRole('analyst')], schema: { tags: ['projects'], summary: 'Save a scenario.' } }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; kind?: string; description?: string; parameters?: Record<string, number | string | boolean> };
    if (!body.name || !body.kind) return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'A scenario name and kind are required.' } });
    const scenario = await ctx.store.db.createScenario({
      projectId: (req.params as { id: string }).id,
      name: body.name,
      kind: body.kind as never,
      description: body.description ?? '',
      parameters: body.parameters ?? {},
    });
    return reply.code(201).send({ data: scenario });
  });
}
