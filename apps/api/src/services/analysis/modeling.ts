import {
  calibrateGr4j,
  depthToDischarge,
  evaluate,
  GR4J_DEFAULTS,
  GR4J_PARAMETER_DESCRIPTIONS,
  GR4J_REFERENCE,
  hargreavesPet,
  METHOD_REFERENCES,
  ratePerformance,
  runGr4j,
} from '@hydro/hydrology-core';
import type { ModelEngine, ToolResult, ValidationResult } from '@hydro/shared-types';
import { EXTERNAL_ADAPTERS, getAdapter } from '../models/adapters.js';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, insufficient, lineChart, ok, q, type ToolContext } from './common.js';

async function loadForcing(ctx: ToolContext) {
  const [precip, tmax, tmin, flow] = await Promise.all([
    ctx.db.getSeries({ variable: 'precipitation' }),
    ctx.db.getSeries({ variable: 'temperature_max' }),
    ctx.db.getSeries({ variable: 'temperature_min' }),
    ctx.db.getSeries({ variable: 'discharge' }),
  ]);
  const watershed = ctx.watershedId ? await ctx.db.getWatershed(ctx.watershedId) : (await ctx.db.listWatersheds())[0];
  const dates = precip.points.map((p) => p.t);
  const lat = watershed?.centroid?.lat ?? 39.3;
  const pet = dates.map((d, i) => {
    const doy = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.UTC(Number(d.slice(0, 4)), 0, 1)) / 86400000) + 1;
    return hargreavesPet(tmax.points[i]?.v ?? 15, tmin.points[i]?.v ?? 5, lat, doy);
  });
  return {
    dates,
    precipitation: precip.points.map((p) => p.v ?? 0),
    pet,
    observed: flow.points.map((p) => p.v),
    areaKm2: watershed?.areaKm2 ?? 1000,
    watershed,
  };
}

/** run_hydrologic_model — GR4J runs; external engines report their requirements. */
export async function runHydrologicModel(
  ctx: ToolContext,
  args: { engine?: ModelEngine; parameters?: Record<string, number>; calibrate?: boolean },
): Promise<ToolResult> {
  const engine = args.engine ?? 'GR4J';
  const p = new ProvenanceBuilder('run_hydrologic_model', { projectId: ctx.projectId, userId: ctx.userId });

  if (engine !== 'GR4J' && engine !== 'PYTHON-CUSTOM') {
    const adapter = getAdapter(engine);
    if (!adapter) return insufficient(p, `No adapter is registered for engine "${engine}".`, args);
    const available = await adapter.available();
    const validation = await adapter.validateInput({ runId: p.runId, projectId: ctx.projectId, watershedId: ctx.watershedId, parameters: args.parameters ?? {} });
    ctx.emit?.(`Checked the ${adapter.displayName} adapter`, available ? 'ok' : 'warn', available ? 'engine available' : 'engine not configured');

    p.method({ name: `${adapter.displayName} adapter`, kind: engine === 'HEC-RAS' ? 'hydraulic_model' : 'hydrologic_model', implementation: 'apps/api/src/services/models/adapters.ts', reference: null, parameters: args.parameters ?? {} })
      .step('validate', 'Validated the run request against the adapter contract without executing anything.', {})
      .limit(
        `${adapter.displayName} is not bundled with Hydrology Copilot and is not installed in this deployment.`,
        'No simulation was performed. No results were generated.',
      )
      .uncertain({ sources: [], qualitative: 'not_quantified' });

    return {
      ok: false,
      summary: `${adapter.displayName}: integration required. ${validation.issues.find((i) => i.severity === 'error')?.message ?? ''}`,
      data: {
        integrationRequired: true,
        engine,
        displayName: adapter.displayName,
        description: adapter.description,
        available,
        requirements: adapter.requirements(),
        capabilities: adapter.capabilities(),
        validation,
      },
      charts: [],
      maps: [],
      metrics: {},
      quantities: {},
      warnings: validation.issues.filter((i) => i.severity === 'error').map((i) => i.message),
      provenance: p.build(args),
    };
  }

  // ---- GR4J: an actually runnable model -----------------------------------
  const forcing = await loadForcing(ctx);
  if (forcing.dates.length < 730) return insufficient(p, 'At least two years of daily forcing are required to run GR4J with a warm-up period.', args);

  const warmup = 365;
  let parameters = { ...GR4J_DEFAULTS, ...(args.parameters ?? {}) } as typeof GR4J_DEFAULTS;
  let calibration = null as ReturnType<typeof calibrateGr4j> | null;

  if (args.calibrate !== false) {
    ctx.emit?.('Calibrating GR4J against observed discharge', 'ok', 'bounded coordinate descent on KGE');
    calibration = calibrateGr4j(
      { precipitation: forcing.precipitation, pet: forcing.pet, dates: forcing.dates, observedM3s: forcing.observed, areaKm2: forcing.areaKm2 },
      { warmupDays: warmup, maxIterations: 30 },
    );
    parameters = calibration.parameters;
    ctx.emit?.(`Calibration converged after ${calibration.iterations} iterations`, 'ok', `KGE ${calibration.objectiveValue.toFixed(3)}`);
  }

  const run = runGr4j({ precipitation: forcing.precipitation, pet: forcing.pet }, parameters, warmup);
  const simulated = depthToDischarge(run.runoffMm, forcing.areaKm2);
  const metrics = evaluate(forcing.observed.slice(warmup), simulated.slice(warmup));
  const rating = ratePerformance(metrics);
  ctx.emit?.('Simulated the full record and evaluated skill', 'ok', `NSE ${metrics.nse?.toFixed(3)}, KGE ${metrics.kge?.toFixed(3)}`);

  p.source(demoSource('Basin precipitation, temperature-derived PET and observed discharge', ['precipitation', 'et_reference', 'discharge'], { precipitation: 'mm', et_reference: 'mm', discharge: 'm3/s' }, { start: forcing.dates[0], end: forcing.dates[forcing.dates.length - 1] }, forcing.dates.length, forcing.watershed?.name ?? ''))
    .method({ name: 'GR4J four-parameter daily rainfall-runoff model', kind: 'hydrologic_model', implementation: '@hydro/hydrology-core runGr4j', reference: GR4J_REFERENCE, parameters: { ...parameters } as Record<string, unknown> })
    .method({ name: 'Hargreaves–Samani reference ET', kind: 'statistic', implementation: '@hydro/hydrology-core hargreavesPet', reference: METHOD_REFERENCES.hargreaves, parameters: {} })
    .method({ name: 'Goodness-of-fit suite', kind: 'statistic', implementation: '@hydro/hydrology-core evaluate', reference: `${METHOD_REFERENCES.nse}; ${METHOD_REFERENCES.kge}`, parameters: {} })
    .step('force', 'Assembled daily precipitation and PET forcing on the catchment.', { areaKm2: forcing.areaKm2 })
    .step('warmup', `Discarded the first ${warmup} days so the model stores could equilibrate.`, { warmupDays: warmup })
    .step(args.calibrate === false ? 'default' : 'calibrate', args.calibrate === false ? 'Used the supplied or default parameter set without calibration.' : 'Calibrated by bounded coordinate descent maximising KGE on the first 65 % of the record.', { iterations: calibration?.iterations ?? 0 })
    .step('simulate', 'Ran GR4J over the full record and converted runoff depth to discharge.', {})
    .step('evaluate', 'Computed NSE, KGE, RMSE, MAE, PBIAS, R² and peak/volume error against observed discharge.', {})
    .coverage(forcing.dates[warmup], forcing.dates[forcing.dates.length - 1])
    .extent(forcing.watershed?.name ?? null)
    .assume(
      'GR4J is a lumped model: the catchment is treated as a single unit with no spatial variability in soil, land cover or rainfall.',
      'PET from Hargreaves–Samani is a temperature-based approximation to atmospheric demand.',
      'No snow module is active; in a catchment with a significant snowpack a CemaNeige-style module would be required.',
    )
    .limit(
      'A four-parameter lumped model cannot represent regulation, diversions, or sub-daily flood dynamics.',
      'Calibration on a single objective (KGE) trades off high-flow and low-flow performance; a multi-objective calibration would give a different parameter set.',
      calibration ? 'Validation metrics come from a period the calibration never saw, but the whole record shares the same generating process, so real-world transferability will be lower.' : 'No calibration was performed; parameters are defaults and are not fitted to this catchment.',
    )
    .uncertain({
      sources: ['Parameter equifinality: several parameter sets give near-identical skill.', 'Forcing error in areal precipitation and PET.', 'Model structural error.'],
      validationMetrics: { nse: metrics.nse, kge: metrics.kge, pbias: metrics.pbias, rmse: metrics.rmse },
      qualitative: (metrics.kge ?? 0) > 0.75 ? 'moderate' : 'high',
    });

  const tail = 900;
  const from = Math.max(warmup, forcing.dates.length - tail);

  return ok(
    `GR4J ${args.calibrate === false ? 'run with the supplied parameters' : `calibrated in ${calibration?.iterations ?? 0} iterations`}: ` +
      `NSE ${metrics.nse?.toFixed(3)}, KGE ${metrics.kge?.toFixed(3)}, PBIAS ${metrics.pbias?.toFixed(1)} %, rated "${rating.overall}". ` +
      `Parameters x1 = ${parameters.x1.toFixed(0)} mm, x2 = ${parameters.x2.toFixed(2)} mm/d, x3 = ${parameters.x3.toFixed(0)} mm, x4 = ${parameters.x4.toFixed(2)} d.`,
    {
      data: {
        engine: 'GR4J',
        parameters,
        parameterDescriptions: GR4J_PARAMETER_DESCRIPTIONS,
        reference: GR4J_REFERENCE,
        warmupDays: warmup,
        calibration: calibration
          ? { iterations: calibration.iterations, objective: calibration.objective, objectiveValue: calibration.objectiveValue, calibrationPeriod: calibration.calibration, validationPeriod: calibration.validation, trace: calibration.trace }
          : null,
        metrics,
        rating,
        series: forcing.dates.slice(from).map((t, i) => ({
          t,
          observed: forcing.observed[from + i],
          simulated: Number(simulated[from + i].toFixed(3)),
          precipitation: forcing.precipitation[from + i],
        })),
        stores: forcing.dates.slice(from).map((t, i) => ({ t, production: run.productionStore[from + i], routing: run.routingStore[from + i] })),
      },
      metrics: metrics as unknown as Record<string, number | null>,
      quantities: { meanSimulated: q(simulated.slice(warmup).reduce((a, b) => a + b, 0) / (simulated.length - warmup), 'm3/s') },
      charts: [
        lineChart({
          kind: 'hydrograph',
          title: 'GR4J simulation against observed discharge',
          subtitle: `NSE ${metrics.nse?.toFixed(3)} · KGE ${metrics.kge?.toFixed(3)} · PBIAS ${metrics.pbias?.toFixed(1)} %`,
          xLabel: 'Date',
          yLabel: 'Discharge',
          unit: 'm3/s',
          series: [
            { key: 'observed', label: 'Observed', kind: 'observed', color: CHART_COLORS.observed },
            { key: 'simulated', label: 'GR4J simulated', kind: 'simulated', color: CHART_COLORS.simulated },
          ],
          data: forcing.dates.slice(from).map((t, i) => ({ t, observed: forcing.observed[from + i], simulated: Number(simulated[from + i].toFixed(3)) })),
          caption: `Last ${Math.min(tail, forcing.dates.length - warmup)} days of the simulation. The first ${warmup} days were discarded as warm-up.`,
        }),
        lineChart({
          kind: 'scatter',
          title: 'Simulated against observed discharge',
          xLabel: 'Observed',
          yLabel: 'Simulated',
          unit: 'm3/s',
          series: [{ key: 'simulated', label: 'Paired daily values', kind: 'simulated', color: CHART_COLORS.simulated }],
          data: forcing.dates
            .slice(warmup)
            .filter((_, i) => i % 7 === 0)
            .map((_, i) => ({ t: String(i), observed: forcing.observed[warmup + i * 7], simulated: Number(simulated[warmup + i * 7]?.toFixed(3) ?? 0) })),
          caption: 'Weekly sample of paired values. Departure from the 1:1 line is model error.',
        }),
      ],
      warnings: (metrics.nse ?? 0) < 0.5 ? ['The calibrated model does not reach a satisfactory NSE for daily streamflow (Moriasi et al. 2015 threshold: NSE > 0.50).'] : [],
      provenance: p.build({ ...args, parameters }),
    },
  );
}

/** List every adapter and whether it can actually run here. */
export async function listModelAdapters(): Promise<
  { engine: ModelEngine; displayName: string; description: string; available: boolean; requirements: unknown[]; capabilities: string[] }[]
> {
  const external = await Promise.all(
    EXTERNAL_ADAPTERS.map(async (a) => ({
      engine: a.engine,
      displayName: a.displayName,
      description: a.description,
      available: await a.available(),
      requirements: a.requirements(),
      capabilities: a.capabilities(),
    })),
  );
  return [
    {
      engine: 'GR4J' as ModelEngine,
      displayName: 'GR4J (built in)',
      description:
        'Four-parameter daily lumped rainfall-runoff model implemented in TypeScript inside @hydro/hydrology-core. Runs without any external dependency and is fully unit-tested.',
      available: true,
      requirements: [{ kind: 'environment', name: 'None', description: 'Implemented in-process; needs only daily precipitation, temperature and a catchment area.' }],
      capabilities: [
        'Continuous daily rainfall-runoff simulation',
        'Production and routing store state output',
        'Groundwater exchange flux',
        'Automatic calibration by bounded coordinate descent on KGE or NSE',
        'Split-sample calibration and validation with a warm-up period',
        'Full goodness-of-fit suite (NSE, KGE, RMSE, MAE, PBIAS, R², peak and volume error)',
      ],
    },
    ...external,
  ];
}

export async function validateModelInput(engine: ModelEngine, projectId: string, parameters: Record<string, unknown>): Promise<ValidationResult> {
  const adapter = getAdapter(engine);
  if (!adapter) {
    return {
      valid: engine === 'GR4J',
      issues: engine === 'GR4J' ? [{ severity: 'info', code: 'BUILT_IN', message: 'GR4J is built in and requires no external project files.' }] : [{ severity: 'error', code: 'UNKNOWN_ENGINE', message: `No adapter registered for "${engine}".` }],
      checkedAt: new Date().toISOString(),
    };
  }
  return adapter.validateInput({ runId: 'validate-only', projectId, watershedId: null, parameters });
}
