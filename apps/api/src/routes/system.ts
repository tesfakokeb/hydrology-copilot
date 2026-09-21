import type { FastifyInstance } from 'fastify';
import type { DataSourceStatus, SystemStatus } from '@hydro/shared-types';
import type { AppContext } from '../context.js';
import { DEMO_DISCLAIMER } from '../demo/potomac.js';
import { listModelAdapters } from '../services/analysis/modeling.js';

export async function systemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', { schema: { tags: ['system'], summary: 'Liveness probe.' } }, async () => ({
    data: { status: 'ok', version: ctx.config.version, uptimeSeconds: Math.round(process.uptime()) },
  }));

  app.get('/api/status', { schema: { tags: ['system'], summary: 'Component status, data-source availability and Copilot engine.' } }, async () => {
    const [dbHealthy, science] = await Promise.all([ctx.store.db.healthy(), ctx.science.health()]);
    const now = new Date().toISOString();

    const sources: DataSourceStatus[] = [
      {
        id: 'demo',
        name: 'Potomac Demonstration Watershed (synthetic)',
        kind: 'internal',
        status: 'online',
        detail: DEMO_DISCLAIMER,
        lastCheckedAt: now,
      },
      {
        id: 'database',
        name: 'PostgreSQL / PostGIS',
        kind: 'internal',
        status: ctx.store.databaseStatus === 'online' && dbHealthy ? 'online' : ctx.store.databaseStatus === 'not_configured' ? 'not_configured' : 'offline',
        detail: ctx.store.note,
        lastCheckedAt: now,
      },
      {
        id: 'science',
        name: 'Python scientific service',
        kind: 'science_service',
        status: science.status,
        detail: science.detail,
        lastCheckedAt: now,
      },
      {
        id: 'queue',
        name: `Job queue (${ctx.queue.backend})`,
        kind: 'internal',
        status: 'online',
        detail:
          `${ctx.queue.stats.queued} queued, ${ctx.queue.stats.running} running, concurrency ${ctx.queue.stats.concurrency}. ` +
          `${ctx.queue.durability} Registered job kinds: ${ctx.queue.registeredKinds.join(', ')}.`,
        lastCheckedAt: now,
      },
      {
        id: 'storage',
        name: 'Object storage',
        kind: 'object_storage',
        status: ctx.config.objectStorage.endpoint ? 'online' : 'not_configured',
        detail: ctx.config.objectStorage.endpoint
          ? `S3-compatible endpoint ${ctx.config.objectStorage.endpoint}, bucket ${ctx.config.objectStorage.bucket}.`
          : 'No S3 endpoint configured. Uploads are written to the local filesystem under STORAGE_ROOT.',
        lastCheckedAt: now,
      },
      {
        id: 'usgs',
        name: 'USGS NWIS',
        kind: 'usgs',
        status: 'not_configured',
        detail: 'Live USGS retrieval is not enabled in this deployment. Configure an outbound connector to ingest real gauge records.',
        lastCheckedAt: now,
      },
      {
        id: 'noaa',
        name: 'NOAA precipitation and forecast',
        kind: 'noaa',
        status: 'not_configured',
        detail: 'No quantitative precipitation forecast is ingested, so streamflow forecasts run on a zero-future-rainfall assumption.',
        lastCheckedAt: now,
      },
    ];

    const status: SystemStatus = {
      api: 'online',
      database: ctx.store.databaseStatus,
      scienceService: science.status,
      queue: 'online',
      copilotEngine: ctx.copilot.engine,
      objectStorage: ctx.config.objectStorage.endpoint ? 'online' : 'not_configured',
      version: ctx.config.version,
      demoMode: ctx.config.demoMode,
      sources,
    };
    return { data: status };
  });

  app.get('/api/capabilities', { schema: { tags: ['system'], summary: 'What this deployment can and cannot do right now.' } }, async () => {
    const adapters = await listModelAdapters();
    const science = await ctx.science.health();
    return {
      data: {
        copilot: {
          engine: ctx.copilot.engine,
          note:
            ctx.copilot.engine === 'anthropic'
              ? 'A language model selects tools and writes the explanation. All numbers still come from tool results.'
              : 'No language model is configured. A deterministic keyword router selects tools and the explanation is composed from tool summaries. Scientific results are identical.',
        },
        models: adapters.map((a) => ({ engine: a.engine, available: a.available, displayName: a.displayName })),
        forecasting: {
          inProcess: ['persistence', 'climatology', 'moving_average', 'arima', 'sarima'],
          scienceService: science.status === 'online' ? science.models ?? [] : [],
          note: science.status === 'online' ? 'Machine-learning models run in the Python scientific service.' : science.detail,
        },
        persistence: { database: ctx.store.databaseStatus, note: ctx.store.note },
        demoData: { enabled: true, disclaimer: DEMO_DISCLAIMER },
      },
    };
  });
}
