import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModelEngine, ScenarioName } from '@hydro/shared-types';
import type { AppContext } from '../context.js';
import { toolContextFor } from '../context.js';
import { buildDashboard } from '../services/analysis/dashboard.js';
import { assessDrought, calculateDroughtIndex } from '../services/analysis/drought.js';
import { analyzeFloodRisk, calculateFloodFrequency, estimateReturnPeriodTool } from '../services/analysis/flood.js';
import { forecastStreamflow } from '../services/analysis/forecasting.js';
import { listModelAdapters, runHydrologicModel, validateModelInput } from '../services/analysis/modeling.js';
import { generateReport, REPORT_TITLES } from '../services/analysis/report.js';
import { SCENARIOS, analyzeWaterSupply, calculateWaterBalance, forecastWaterDemand, supplyDemandBalance } from '../services/analysis/water.js';

const base = z.object({ projectId: z.string().optional(), watershedId: z.string().optional(), stationId: z.string().optional() });

export async function analysisRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: [app.authenticate] };
  const projectOf = async (q: { projectId?: string }, userId: string) => {
    if (q.projectId) return q.projectId;
    const list = await ctx.store.db.listProjects(userId);
    return list[0]?.id ?? '';
  };

  // ---- Dashboard ----------------------------------------------------------
  app.get('/api/dashboard', { ...auth, schema: { tags: ['dashboard'], summary: 'Dashboard KPI cards and rule-generated alerts.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await buildDashboard(c) };
  });

  // ---- Forecast -----------------------------------------------------------
  app.get('/api/forecast/streamflow', { ...auth, schema: { tags: ['forecast'], summary: 'Probabilistic streamflow forecast with validation skill.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { horizonDays, model } = req.query as { horizonDays?: string; model?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await forecastStreamflow(c, { stationId: q.stationId, horizonDays: horizonDays ? Number(horizonDays) : 7, model: model as never }) };
  });

  // ---- Drought ------------------------------------------------------------
  app.get('/api/drought', { ...auth, schema: { tags: ['drought'], summary: 'Multi-index drought assessment with a narrative.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await assessDrought(c, {}) };
  });

  app.get('/api/drought/index', { ...auth, schema: { tags: ['drought'], summary: 'Compute SPI, SPEI or the streamflow drought index.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { index, timescaleMonths } = req.query as { index?: string; timescaleMonths?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await calculateDroughtIndex(c, { index: (index as 'SPI' | 'SPEI' | 'SSI') ?? 'SPI', timescaleMonths: timescaleMonths ? Number(timescaleMonths) : 3 }) };
  });

  // ---- Flood --------------------------------------------------------------
  app.get('/api/flood-risk', { ...auth, schema: { tags: ['flood'], summary: 'Flood risk outlook with ensemble exceedance probabilities.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { horizonDays } = req.query as { horizonDays?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await analyzeFloodRisk(c, { stationId: q.stationId, horizonDays: horizonDays ? Number(horizonDays) : 7 }) };
  });

  app.get('/api/flood-risk/frequency', { ...auth, schema: { tags: ['flood'], summary: 'Flood-frequency analysis (LP3 and GEV).' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { method, regionalSkew } = req.query as { method?: string; regionalSkew?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await calculateFloodFrequency(c, { stationId: q.stationId, method: method as never, regionalSkew: regionalSkew ? Number(regionalSkew) : undefined }) };
  });

  app.get('/api/flood-risk/return-period', { ...auth, schema: { tags: ['flood'], summary: 'Return period of a specified discharge.' } }, async (req, reply) => {
    const q = base.parse(req.query ?? {});
    const { discharge } = req.query as { discharge?: string };
    if (!discharge) return reply.code(400).send({ error: { code: 'MISSING_DISCHARGE', message: 'A discharge in m³/s is required.' } });
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await estimateReturnPeriodTool(c, { discharge: Number(discharge), stationId: q.stationId }) };
  });

  // ---- Water balance, supply and demand -----------------------------------
  app.get('/api/water-balance', { ...auth, schema: { tags: ['water-supply'], summary: 'Catchment water balance and runoff coefficient.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await calculateWaterBalance(c, {}) };
  });

  app.get('/api/water-supply', { ...auth, schema: { tags: ['water-supply'], summary: 'Reservoir simulation, reliability and safe yield under a scenario.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { scenario } = req.query as { scenario?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await analyzeWaterSupply(c, { scenario: (scenario as ScenarioName) ?? 'baseline' }) };
  });

  app.get('/api/water-supply/balance', { ...auth, schema: { tags: ['water-supply'], summary: 'Supply-demand balance across scenarios.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { scenarios } = req.query as { scenarios?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await supplyDemandBalance(c, { scenarios: scenarios ? (scenarios.split(',') as ScenarioName[]) : undefined }) };
  });

  app.get('/api/scenarios', { ...auth, schema: { tags: ['water-supply'], summary: 'Available planning scenarios and their definitions.' } }, async () => ({
    data: Object.entries(SCENARIOS).map(([name, s]) => ({ name, ...s })),
  }));

  app.get('/api/water-demand', { ...auth, schema: { tags: ['water-demand'], summary: 'Water demand forecast with seasonal shape and anomalies.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const { horizonMonths, sector } = req.query as { horizonMonths?: string; sector?: string };
    const c = await toolContextFor(ctx, await projectOf(q, req.user!.id), req.user!.id, q.watershedId);
    return { data: await forecastWaterDemand(c, { horizonMonths: horizonMonths ? Number(horizonMonths) : 12, sector: sector as never }) };
  });

  // ---- Models -------------------------------------------------------------
  app.get('/api/models/adapters', { ...auth, schema: { tags: ['models'], summary: 'Model engines, their requirements and whether they can run here.' } }, async () => ({
    data: await listModelAdapters(),
  }));

  app.post('/api/models/validate', { ...auth, schema: { tags: ['models'], summary: 'Validate a model run request without executing it.' } }, async (req) => {
    const body = (req.body ?? {}) as { engine?: ModelEngine; projectId?: string; parameters?: Record<string, unknown> };
    return { data: await validateModelInput(body.engine ?? 'GR4J', body.projectId ?? '', body.parameters ?? {}) };
  });

  app.post('/api/models/run', { ...auth, schema: { tags: ['models'], summary: 'Run a hydrologic model. GR4J runs in-process; external engines report their requirements.' } }, async (req) => {
    const body = (req.body ?? {}) as { engine?: ModelEngine; projectId?: string; watershedId?: string; calibrate?: boolean; parameters?: Record<string, number> };
    const projectId = body.projectId ?? (await projectOf({}, req.user!.id));
    const c = await toolContextFor(ctx, projectId, req.user!.id, body.watershedId);
    const result = await runHydrologicModel(c, { engine: body.engine ?? 'GR4J', calibrate: body.calibrate, parameters: body.parameters });

    const run = await ctx.store.db.createModelRun({
      projectId,
      watershedId: c.watershedId,
      engine: body.engine ?? 'GR4J',
      name: `${body.engine ?? 'GR4J'} run`,
      status: result.ok ? 'completed' : 'failed',
      adapterAvailable: result.ok || Boolean((result.data as { available?: boolean }).available),
      createdBy: req.user!.id,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      parameters: (result.data.parameters as Record<string, unknown>) ?? {},
      metrics: result.ok ? (result.metrics as never) : null,
      outputLocation: null,
      logs: result.warnings,
      message: result.summary,
    });
    await ctx.store.db.saveProvenance(result.provenance).catch(() => undefined);
    return { data: { run, result } };
  });

  app.get('/api/models/runs', { ...auth, schema: { tags: ['models'], summary: 'List model runs for a project.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    return { data: await ctx.store.db.listModelRuns(await projectOf(q, req.user!.id)) };
  });

  app.get('/api/models/runs/:id', { ...auth, schema: { tags: ['models'], summary: 'Model run detail.' } }, async (req, reply) => {
    const run = await ctx.store.db.getModelRun((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No model run with that identifier.' } });
    return { data: run };
  });

  // ---- Reports ------------------------------------------------------------
  app.get('/api/reports', { ...auth, schema: { tags: ['reports'], summary: 'List generated reports.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    return { data: { reports: await ctx.store.db.listReports(await projectOf(q, req.user!.id)), kinds: REPORT_TITLES } };
  });

  app.post('/api/reports', { ...auth, schema: { tags: ['reports'], summary: 'Generate a scientific report. Runs asynchronously as a job.' } }, async (req) => {
    const body = (req.body ?? {}) as { kind?: keyof typeof REPORT_TITLES; projectId?: string; title?: string; watershedId?: string };
    const projectId = body.projectId ?? (await projectOf({}, req.user!.id));
    const job = await ctx.queue.enqueue('report.generate', projectId, req.user!.id, {
      kind: body.kind ?? 'hydrology_assessment',
      title: body.title,
      watershedId: body.watershedId,
    });
    return { data: { job } };
  });

  app.post('/api/reports/sync', { ...auth, schema: { tags: ['reports'], summary: 'Generate a report synchronously and return it immediately.' } }, async (req) => {
    const body = (req.body ?? {}) as { kind?: keyof typeof REPORT_TITLES; projectId?: string; title?: string; watershedId?: string };
    const projectId = body.projectId ?? (await projectOf({}, req.user!.id));
    const c = await toolContextFor(ctx, projectId, req.user!.id, body.watershedId);
    const result = await generateReport(c, { kind: body.kind, title: body.title });
    await ctx.store.db.saveProvenance(result.provenance).catch(() => undefined);
    const report = await ctx.store.db.createReport({
      projectId,
      kind: result.kind,
      title: (result.data.title as string) ?? REPORT_TITLES[result.kind],
      status: 'ready',
      formats: ['html', 'pdf'],
      storageUri: null,
      createdBy: req.user!.id,
      provenanceId: result.provenance.id,
      contentHtml: result.html,
    });
    return { data: { report, result: { ...result, html: undefined } } };
  });

  app.get('/api/reports/:id', { ...auth, schema: { tags: ['reports'], summary: 'Report metadata.' } }, async (req, reply) => {
    const report = await ctx.store.db.getReport((req.params as { id: string }).id);
    if (!report) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No report with that identifier.' } });
    const { contentHtml: _c, ...meta } = report;
    return { data: meta };
  });

  app.get('/api/reports/:id/html', { ...auth, schema: { tags: ['reports'], summary: 'Rendered report as a self-contained HTML document.' } }, async (req, reply) => {
    const report = await ctx.store.db.getReport((req.params as { id: string }).id);
    if (!report?.contentHtml) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No rendered report content for that identifier.' } });
    return reply.type('text/html; charset=utf-8').send(report.contentHtml);
  });

  // ---- Provenance ---------------------------------------------------------
  app.get('/api/provenance', { ...auth, schema: { tags: ['provenance'], summary: 'Recent provenance records for a project.' } }, async (req) => {
    const q = base.parse(req.query ?? {});
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return { data: await ctx.store.db.listProvenance(await projectOf(q, req.user!.id), limit) };
  });

  app.get('/api/provenance/:id', { ...auth, schema: { tags: ['provenance'], summary: 'A single provenance record.' } }, async (req, reply) => {
    const rec = await ctx.store.db.getProvenance((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No provenance record with that identifier.' } });
    return { data: rec };
  });
}
