import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { SUGGESTED_PROMPTS, TOOLS } from '../copilot/tools.js';
import { route } from '../copilot/router.js';
import { EXECUTORS } from '../copilot/registry.js';
import { toolContextFor } from '../context.js';

const chatSchema = z.object({
  projectId: z.string().min(1),
  message: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
  datasetIds: z.array(z.string()).optional(),
  context: z
    .object({
      watershedId: z.string().optional(),
      stationId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    })
    .optional(),
});

export async function copilotRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  app.get('/api/copilot/tools', { ...auth, schema: { tags: ['copilot'], summary: 'The tool catalogue the Copilot can call.' } }, async () => ({
    data: {
      tools: TOOLS.map((t) => ({ ...t, executable: t.name in EXECUTORS })),
      suggestedPrompts: SUGGESTED_PROMPTS,
      engine: ctx.copilot.engine,
    },
  }));

  app.post('/api/copilot/route', { ...auth, schema: { tags: ['copilot'], summary: 'Show which tools a message would trigger, without running them.' } }, async (req) => {
    const message = (req.body as { message?: string })?.message ?? '';
    return { data: route(message) };
  });

  app.post('/api/copilot/chat', { ...auth, schema: { tags: ['copilot'], summary: 'Ask the Copilot a hydrology question. Runs tools and returns a structured scientific answer.' } }, async (req, reply) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'projectId and message are required.', details: parsed.error.issues } });
    }
    const body = parsed.data;
    const userId = req.user!.id;

    let conversationId = body.conversationId;
    if (!conversationId) {
      const conv = await ctx.store.db.createConversation({ projectId: body.projectId, userId, title: 'New conversation' });
      conversationId = conv.id;
    }

    await ctx.store.db.appendMessage({ conversationId, role: 'user', content: body.message });

    const response = await ctx.copilot.chat(body, userId, conversationId);

    const saved = await ctx.store.db.appendMessage({
      conversationId,
      role: 'assistant',
      content: response.answer,
      intent: response.intent,
      engine: response.engine,
      scientific: response.scientific,
      toolCalls: response.toolsUsed,
      charts: response.charts,
      maps: response.maps,
      warnings: response.warnings,
    });

    return { data: { ...response, messageId: saved.id } };
  });

  app.post('/api/copilot/run-tool', { ...auth, schema: { tags: ['copilot'], summary: 'Execute a single Copilot tool directly, bypassing intent detection.' } }, async (req, reply) => {
    const body = (req.body ?? {}) as { tool?: string; projectId?: string; watershedId?: string; arguments?: Record<string, unknown> };
    if (!body.tool || !(body.tool in EXECUTORS)) {
      return reply.code(400).send({
        error: { code: 'UNKNOWN_TOOL', message: `Unknown tool "${body.tool}". Call GET /api/copilot/tools for the catalogue.` },
      });
    }
    const projects = await ctx.store.db.listProjects(req.user!.id);
    const projectId = body.projectId ?? projects[0]?.id ?? '';
    const c = await toolContextFor(ctx, projectId, req.user!.id, body.watershedId);
    const result = await EXECUTORS[body.tool](c, body.arguments ?? {});
    await ctx.store.db.saveProvenance(result.provenance).catch(() => undefined);
    return { data: result };
  });

  app.post('/api/copilot/analyze', { ...auth, schema: { tags: ['copilot'], summary: 'Alias of /chat scoped to an analytical intent.' } }, async (req, reply) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'projectId and message are required.' } });
    const conv = await ctx.store.db.createConversation({ projectId: parsed.data.projectId, userId: req.user!.id, title: parsed.data.message.slice(0, 72) });
    return { data: await ctx.copilot.chat(parsed.data, req.user!.id, conv.id) };
  });

  app.get('/api/copilot/conversations', { ...auth, schema: { tags: ['copilot'], summary: 'List the user\'s conversations.' } }, async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    return { data: await ctx.store.db.listConversations(req.user!.id, projectId) };
  });

  app.get('/api/copilot/conversations/:id', { ...auth, schema: { tags: ['copilot'], summary: 'Conversation with its full message history and tool calls.' } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const conv = await ctx.store.db.getConversation(id, req.user!.id);
    if (!conv) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No conversation with that identifier.' } });
    return { data: { conversation: conv, messages: await ctx.store.db.listMessages(id) } };
  });
}
