import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { loadConfig } from '@hydro/config';
import type { AppContext } from './context.js';
import { toolContextFor } from './context.js';
import { CopilotOrchestrator } from './copilot/orchestrator.js';
import { JobQueue } from './jobs/queue.js';
import { registerAuthDecorators } from './plugins/auth.js';
import { EventBus } from './plugins/ws.js';
import { analysisRoutes } from './routes/analysis.js';
import { authRoutes } from './routes/auth.js';
import { copilotRoutes } from './routes/copilot.js';
import { dataRoutes } from './routes/data.js';
import { datasetRoutes } from './routes/datasets.js';
import { jobRoutes } from './routes/jobs.js';
import { projectRoutes } from './routes/projects.js';
import { systemRoutes } from './routes/system.js';
import { generateReport, REPORT_TITLES } from './services/analysis/report.js';
import { runHydrologicModel } from './services/analysis/modeling.js';
import { ScienceClient } from './services/science-client.js';
import { createStore } from './store/index.js';

export async function buildServer(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.env === 'development'
        ? { transport: undefined }
        : {}),
      // Structured logging (§34): every line carries a request id.
      redact: { paths: ['req.headers.authorization', 'req.headers["x-api-key"]'], censor: '[redacted]' },
    },
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  const store = await createStore(config, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
  const bus = new EventBus();
  const science = new ScienceClient(config.scienceServiceUrl);
  const queue = new JobQueue(store.db, bus, app.log, Boolean(config.redisUrl));

  const copilot = new CopilotOrchestrator({
    db: store.db,
    config,
    log: app.log,
    publish: (event) => {
      // Copilot progress is broadcast so the chat UI can render the tool trace
      // as it happens rather than only when the answer is complete.
      bus.broadcast(event);
    },
  });

  const ctx: AppContext = { config, store, bus, science, copilot, queue, log: app.log };

  // ---- Job handlers -------------------------------------------------------
  queue.register('report.generate', async (job, report) => {
    const payload = (job as unknown as { payload?: { kind?: keyof typeof REPORT_TITLES; title?: string; watershedId?: string } }).payload ?? {};
    await report(10, 'Loading project data');
    const c = await toolContextFor(ctx, job.projectId ?? '', job.userId, payload.watershedId);
    await report(30, 'Running analyses');
    const result = await generateReport(c, { kind: payload.kind, title: payload.title });
    await report(85, 'Rendering the document');
    await store.db.saveProvenance(result.provenance).catch(() => undefined);
    const saved = await store.db.createReport({
      projectId: job.projectId ?? '',
      kind: result.kind,
      title: (result.data.title as string) ?? REPORT_TITLES[result.kind],
      status: 'ready',
      formats: ['html', 'pdf'],
      storageUri: null,
      createdBy: job.userId,
      provenanceId: result.provenance.id,
      contentHtml: result.html,
    });
    await report(100, 'Report ready');
    return { outputLocation: `/api/reports/${saved.id}/html`, result: { reportId: saved.id } };
  });

  queue.register('model.run', async (job, report) => {
    const payload = (job as unknown as { payload?: { engine?: string; calibrate?: boolean } }).payload ?? {};
    await report(15, 'Preparing forcing data');
    const c = await toolContextFor(ctx, job.projectId ?? '', job.userId);
    await report(40, `Running ${payload.engine ?? 'GR4J'}`);
    const result = await runHydrologicModel(c, { engine: (payload.engine as never) ?? 'GR4J', calibrate: payload.calibrate });
    await store.db.saveProvenance(result.provenance).catch(() => undefined);
    await report(100, result.summary);
    return { outputLocation: null, result };
  });

  // ---- Plugins ------------------------------------------------------------
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    allowList: (req) => req.url === '/api/health',
  });

  await app.register(jwt, { secret: config.auth.jwtSecret });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Hydrology Copilot API',
        version: config.version,
        description:
          'AI-Powered Water Resources Intelligence. Every analytical endpoint returns a result together with a provenance record describing the data, methods, assumptions, limitations and uncertainty behind it.',
      },
      servers: [{ url: `http://localhost:${config.port}`, description: 'Local development' }],
      tags: [
        { name: 'system', description: 'Health, status and capabilities' },
        { name: 'auth', description: 'Authentication and accounts' },
        { name: 'projects', description: 'Projects and scenarios' },
        { name: 'datasets', description: 'Dataset upload, profiling and preview' },
        { name: 'data', description: 'Time-series retrieval' },
        { name: 'gis', description: 'Watersheds, stations and spatial queries' },
        { name: 'streamflow', description: 'Streamflow analysis' },
        { name: 'forecast', description: 'Forecasting' },
        { name: 'drought', description: 'Drought indices and assessment' },
        { name: 'water-quality', description: 'Water-quality analytics' },
        { name: 'flood', description: 'Flood frequency and flood risk' },
        { name: 'water-supply', description: 'Reservoirs, supply and scenarios' },
        { name: 'water-demand', description: 'Demand analysis and forecasting' },
        { name: 'models', description: 'Hydrologic and hydraulic model adapters' },
        { name: 'copilot', description: 'AI Copilot' },
        { name: 'jobs', description: 'Asynchronous jobs' },
        { name: 'reports', description: 'Automated scientific reports' },
        { name: 'provenance', description: 'Analysis provenance records' },
        { name: 'dashboard', description: 'Dashboard KPIs and alerts' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  registerAuthDecorators(app, store.db);

  // ---- Routes -------------------------------------------------------------
  await app.register(async (instance) => systemRoutes(instance, ctx));
  await app.register(async (instance) => authRoutes(instance, ctx));
  await app.register(async (instance) => projectRoutes(instance, ctx));
  await app.register(async (instance) => datasetRoutes(instance, ctx));
  await app.register(async (instance) => dataRoutes(instance, ctx));
  await app.register(async (instance) => analysisRoutes(instance, ctx));
  await app.register(async (instance) => copilotRoutes(instance, ctx));
  await app.register(async (instance) => jobRoutes(instance, ctx));

  // ---- WebSocket ----------------------------------------------------------
  await app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket, req) => {
      const url = new URL(req.url ?? '/ws', 'http://localhost');
      const projectId = url.searchParams.get('projectId') ?? 'global';
      const unsubscribe = bus.subscribe(projectId, { send: (d) => socket.send(d) });

      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', t: new Date().toISOString() }));
        } catch {
          /* a malformed frame is ignored rather than closing the socket */
        }
      });
      socket.on('close', () => unsubscribe());
      socket.send(JSON.stringify({ type: 'pong', t: new Date().toISOString() }));
    });
  });

  // ---- Error handling -----------------------------------------------------
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error({ err, url: req.url }, 'Unhandled API error');
    reply.code(status).send({
      error: {
        code: err.code ?? 'INTERNAL_ERROR',
        message: status >= 500 && config.env === 'production' ? 'An internal error occurred.' : err.message,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}. See /docs for the API surface.` } });
  });

  return { app, ctx };
}

async function main(): Promise<void> {
  const { app, ctx } = await buildServer();
  const config = ctx.config;
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(
      {
        port: config.port,
        database: ctx.store.databaseStatus,
        copilotEngine: ctx.copilot.engine,
        scienceService: config.scienceServiceUrl ?? 'not configured',
        docs: `http://localhost:${config.port}/docs`,
      },
      'Hydrology Copilot API is listening',
    );
  } catch (err) {
    app.log.error({ err }, 'Failed to start');
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => ctx.store.db.close()).then(() => process.exit(0));
    });
  }
}

const isDirectRun = process.argv[1]?.includes('server');
if (isDirectRun) {
  void main();
}
