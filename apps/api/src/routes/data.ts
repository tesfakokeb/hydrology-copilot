import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { toolContextFor } from '../context.js';
import { analyzePrecipitation, analyzeWatershed, runGisAnalysis } from '../services/analysis/gis.js';
import { analyzeStreamflow, detectFloodEvents, getStreamflow } from '../services/analysis/streamflow.js';
import { analyzeWaterQuality } from '../services/analysis/quality.js';

const query = z.object({
  projectId: z.string().optional(),
  watershedId: z.string().optional(),
  stationId: z.string().optional(),
  variable: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  maxPoints: z.coerce.number().int().min(50).max(50_000).optional(),
});

export async function dataRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: [app.authenticate] };
  const defaultProject = async (req: { query: unknown }) => {
    const q = query.parse(req.query ?? {});
    if (q.projectId) return q.projectId;
    const projects = await ctx.store.db.listProjects('');
    return projects[0]?.id ?? '';
  };

  // ---- Spatial ------------------------------------------------------------

  app.get('/api/watersheds', { ...auth, schema: { tags: ['gis'], summary: 'List watersheds.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    return { data: await ctx.store.db.listWatersheds(q.projectId) };
  });

  app.get('/api/watersheds/:id', { ...auth, schema: { tags: ['gis'], summary: 'Watershed detail with subbasins and stations.' } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const watershed = await ctx.store.db.getWatershed(id);
    if (!watershed) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No watershed with that identifier.' } });
    const [subbasins, stations, reservoirs] = await Promise.all([
      ctx.store.db.listSubbasins(id),
      ctx.store.db.listStations({ watershedId: id }),
      ctx.store.db.listReservoirs(id),
    ]);
    return { data: { watershed, subbasins, stations, reservoirs } };
  });

  app.get('/api/watersheds/:id/geojson', { ...auth, schema: { tags: ['gis'], summary: 'Watershed and subbasin geometry as GeoJSON.' } }, async (req) => ({
    data: await ctx.store.db.getWatershedGeoJson((req.params as { id: string }).id),
  }));

  app.get('/api/watersheds/:id/reaches', { ...auth, schema: { tags: ['gis'], summary: 'Stream network as GeoJSON.' } }, async (req) => ({
    data: await ctx.store.db.getReaches((req.params as { id: string }).id),
  }));

  app.get('/api/stations', { ...auth, schema: { tags: ['gis'], summary: 'List monitoring stations.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const type = (req.query as { type?: string }).type;
    return { data: await ctx.store.db.listStations({ watershedId: q.watershedId, type }) };
  });

  app.get('/api/stations/:id', { ...auth, schema: { tags: ['gis'], summary: 'Station detail.' } }, async (req, reply) => {
    const station = await ctx.store.db.getStation((req.params as { id: string }).id);
    if (!station) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No station with that identifier or code.' } });
    return { data: station };
  });

  // ---- Time series --------------------------------------------------------

  app.get('/api/series', { ...auth, schema: { tags: ['data'], summary: 'Retrieve a time series for any hydro-climatic variable.' } }, async (req, reply) => {
    const q = query.parse(req.query ?? {});
    if (!q.variable) return reply.code(400).send({ error: { code: 'MISSING_VARIABLE', message: 'A variable is required, e.g. discharge, precipitation, temperature_mean, et_reference.' } });
    const series = await ctx.store.db.getSeries({
      variable: q.variable,
      stationId: q.stationId,
      start: q.start,
      end: q.end,
      maxPoints: q.maxPoints ?? 4000,
    });
    return { data: series };
  });

  app.get('/api/streamflow', { ...auth, schema: { tags: ['streamflow'], summary: 'Daily discharge record with a completeness report.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return { data: await getStreamflow(c, { stationId: q.stationId, startDate: q.start, endDate: q.end }) };
  });

  app.get('/api/streamflow/statistics', { ...auth, schema: { tags: ['streamflow'], summary: 'Flow statistics, flow-duration curve, 7Q10 and baseflow index.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return { data: await analyzeStreamflow(c, { stationId: q.stationId, startDate: q.start, endDate: q.end }) };
  });

  app.get('/api/streamflow/events', { ...auth, schema: { tags: ['streamflow'], summary: 'Peak-over-threshold events and annual peaks.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const pct = (req.query as { thresholdPercentile?: string }).thresholdPercentile;
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return { data: await detectFloodEvents(c, { stationId: q.stationId, thresholdPercentile: pct ? Number(pct) : undefined, startDate: q.start, endDate: q.end }) };
  });

  app.get('/api/precipitation', { ...auth, schema: { tags: ['data'], summary: 'Precipitation statistics and the rainfall-runoff lag.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return { data: await analyzePrecipitation(c, { startDate: q.start, endDate: q.end }) };
  });

  // ---- Water quality ------------------------------------------------------

  app.get('/api/water-quality', { ...auth, schema: { tags: ['water-quality'], summary: 'Water-quality assessment: WQI, exceedances, trends and anomalies.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const params = (req.query as { parameters?: string }).parameters;
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return {
      data: await analyzeWaterQuality(c, {
        stationId: q.stationId,
        parameters: params ? params.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        startDate: q.start,
        endDate: q.end,
      }),
    };
  });

  app.get('/api/water-quality/raw', { ...auth, schema: { tags: ['water-quality'], summary: 'Raw water-quality results.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const params = (req.query as { parameters?: string }).parameters;
    return {
      data: await ctx.store.db.getWaterQuality({
        stationId: q.stationId,
        watershedId: q.watershedId,
        parameters: params ? params.split(',') : undefined,
        start: q.start,
        end: q.end,
      }),
    };
  });

  // ---- Watershed / GIS analysis -------------------------------------------

  app.get('/api/gis/watershed-analysis', { ...auth, schema: { tags: ['gis'], summary: 'Watershed characterisation with subbasin contributions.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return { data: await analyzeWatershed(c, { watershedId: q.watershedId }) };
  });

  app.get('/api/gis/query', { ...auth, schema: { tags: ['gis'], summary: 'Spatial query over the project layers.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    const { operation, lon, lat } = req.query as { operation?: string; lon?: string; lat?: string };
    const c = await toolContextFor(ctx, await defaultProject(req), req.user!.id, q.watershedId);
    return { data: await runGisAnalysis(c, { operation: operation as never, lon: lon ? Number(lon) : undefined, lat: lat ? Number(lat) : undefined }) };
  });

  // ---- Reservoirs and demand ---------------------------------------------

  app.get('/api/reservoirs', { ...auth, schema: { tags: ['water-supply'], summary: 'List reservoirs.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    return { data: await ctx.store.db.listReservoirs(q.watershedId) };
  });

  app.get('/api/reservoirs/:id/series', { ...auth, schema: { tags: ['water-supply'], summary: 'Reservoir storage, inflow, release and spill.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    return { data: await ctx.store.db.getReservoirSeries((req.params as { id: string }).id, q.start, q.end) };
  });

  app.get('/api/water-demand/history', { ...auth, schema: { tags: ['water-demand'], summary: 'Historical sectoral demand.' } }, async (req) => {
    const q = query.parse(req.query ?? {});
    return { data: await ctx.store.db.getDemand(q.projectId ?? (await defaultProject(req)), q.start, q.end) };
  });
}
