import {
  forecast as baselineForecast,
  linearRegression,
  mean,
  METHOD_REFERENCES,
  modifiedZScores,
  safeYield,
  simulateReservoir,
  storageExceedance,
  waterBalance,
} from '@hydro/hydrology-core';
import type { ScenarioName, ToolResult } from '@hydro/shared-types';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { addMonths, CHART_COLORS, fmt, insufficient, lineChart, ok, q, type ToolContext } from './common.js';

/**
 * Share of total system demand met from the reservoir. The remainder is met
 * from run-of-river intakes, groundwater and purchases. Stated explicitly
 * because it materially changes every reliability number reported.
 */
export const RESERVOIR_DEMAND_SHARE = 0.35;

/** Minimum instream flow release required below the dam, m³/s. */
export const MINIMUM_INSTREAM_RELEASE_M3S = 1.2;

// ---------------------------------------------------------------------------
// Scenario definitions (§28)
// ---------------------------------------------------------------------------

export interface ScenarioAdjustment {
  inflowFactor: number;
  demandFactor: number;
  label: string;
  description: string;
}

export const SCENARIOS: Record<ScenarioName, ScenarioAdjustment> = {
  baseline: { inflowFactor: 1.0, demandFactor: 1.0, label: 'Baseline', description: 'Historical inflows and current demand, unchanged.' },
  average: { inflowFactor: 1.0, demandFactor: 1.0, label: 'Average', description: 'Identical to baseline; retained for explicit comparison.' },
  dry: { inflowFactor: 0.75, demandFactor: 1.05, label: 'Dry year', description: 'Inflows reduced 25 %, demand raised 5 % to reflect hotter, drier conditions.' },
  wet: { inflowFactor: 1.3, demandFactor: 0.95, label: 'Wet year', description: 'Inflows raised 30 %, demand reduced 5 %.' },
  extreme_drought: { inflowFactor: 0.5, demandFactor: 1.12, label: 'Extreme drought', description: 'Inflows halved, demand raised 12 % — a stress test, not a forecast.' },
  climate_change: { inflowFactor: 0.88, demandFactor: 1.09, label: 'Climate change', description: 'Illustrative mid-century signal: 12 % lower inflow, 9 % higher demand. Not derived from a downscaled GCM ensemble.' },
  population_growth: { inflowFactor: 1.0, demandFactor: 1.22, label: 'Population growth', description: 'Demand raised 22 %, consistent with sustained growth over a planning horizon.' },
  high_demand: { inflowFactor: 1.0, demandFactor: 1.35, label: 'High demand', description: 'Demand raised 35 %.' },
  conservation: { inflowFactor: 1.0, demandFactor: 0.82, label: 'Conservation', description: 'Demand reduced 18 % through efficiency and restriction measures.' },
  reservoir_operation: { inflowFactor: 1.0, demandFactor: 1.0, label: 'Revised reservoir operation', description: 'Baseline hydrology with an altered operating rule.' },
  land_use_change: { inflowFactor: 1.07, demandFactor: 1.04, label: 'Land-use change', description: 'Increased imperviousness raises runoff volume 7 % and demand 4 %.' },
};

// ---------------------------------------------------------------------------
// Water balance
// ---------------------------------------------------------------------------

export async function calculateWaterBalance(ctx: ToolContext, args: { startDate?: string; endDate?: string } = {}): Promise<ToolResult> {
  const p = new ProvenanceBuilder('calculate_water_balance', { projectId: ctx.projectId, userId: ctx.userId });
  const [precip, aet, flow] = await Promise.all([
    ctx.db.getSeries({ variable: 'precipitation', start: args.startDate, end: args.endDate }),
    ctx.db.getSeries({ variable: 'et_actual', start: args.startDate, end: args.endDate }),
    ctx.db.getSeries({ variable: 'discharge', start: args.startDate, end: args.endDate }),
  ]);
  const watershed = ctx.watershedId ? await ctx.db.getWatershed(ctx.watershedId) : (await ctx.db.listWatersheds())[0];
  if (!watershed) return insufficient(p, 'No watershed is selected, so the catchment area needed for a water balance is unknown.', args);
  if (precip.points.length < 365) return insufficient(p, 'At least one year of precipitation, ET and discharge is required for a water balance.', args);

  const wb = waterBalance({
    precipitationMm: precip.points.map((pt) => pt.v),
    etMm: aet.points.map((pt) => pt.v),
    dischargeM3s: flow.points.map((pt) => pt.v),
    stepSeconds: 86400,
    catchmentAreaKm2: watershed.areaKm2,
  });
  ctx.emit?.('Closed the catchment water balance', wb.closureQuality === 'poor' ? 'warn' : 'ok', `residual ${wb.residualPctOfPrecip.toFixed(1)} % of precipitation`);

  const years = wb.periodSteps / 365.25;

  p.source(demoSource('Basin precipitation, actual ET and outlet discharge', ['precipitation', 'et_actual', 'discharge'], { precipitation: 'mm', et_actual: 'mm', discharge: 'm3/s' }, { start: precip.points[0].t, end: precip.points[precip.points.length - 1].t }, precip.points.length, watershed.name))
    .method({ name: 'Catchment water balance P = Q + ET + ΔS', kind: 'statistic', implementation: '@hydro/hydrology-core waterBalance', reference: null, parameters: { catchmentAreaKm2: watershed.areaKm2, stepSeconds: 86400 } })
    .step('convert', 'Converted discharge to an equivalent runoff depth over the catchment area.', { areaKm2: watershed.areaKm2 })
    .step('accumulate', 'Accumulated each flux over the period, excluding steps with any missing component.', { steps: wb.periodSteps })
    .coverage(precip.points[0].t, precip.points[precip.points.length - 1].t)
    .extent(`${watershed.name} (${watershed.areaKm2.toLocaleString()} km²)`)
    .assume(
      'The catchment is closed: no inter-basin transfers, no significant groundwater flow across the divide.',
      'Storage change is reported as the residual rather than measured independently.',
    )
    .limit(...wb.notes)
    .uncertain({ sources: ['Areal precipitation estimation error.', 'ET is modelled, not measured.', 'Rating-curve error in discharge.'], qualitative: wb.closureQuality === 'good' ? 'moderate' : 'high' });

  return ok(
    `Over ${years.toFixed(1)} years the catchment received ${(wb.precipitationMm / years).toFixed(0)} mm/yr of precipitation, lost ${(wb.evapotranspirationMm / years).toFixed(0)} mm/yr to evapotranspiration and produced ${(wb.runoffMm / years).toFixed(0)} mm/yr of runoff. ` +
      `The runoff coefficient is ${wb.runoffCoefficient.toFixed(2)} and the balance closes to within ${Math.abs(wb.residualPctOfPrecip).toFixed(1)} % of precipitation (${wb.closureQuality}).`,
    {
      data: { balance: wb, watershed, annualised: { precipitationMm: wb.precipitationMm / years, etMm: wb.evapotranspirationMm / years, runoffMm: wb.runoffMm / years, residualMm: wb.residualMm / years } },
      metrics: {
        precipitationMmPerYear: wb.precipitationMm / years,
        etMmPerYear: wb.evapotranspirationMm / years,
        runoffMmPerYear: wb.runoffMm / years,
        runoffCoefficient: wb.runoffCoefficient,
        residualPctOfPrecip: wb.residualPctOfPrecip,
      },
      quantities: {
        precipitation: q(wb.precipitationMm / years, 'mm'),
        evapotranspiration: q(wb.evapotranspirationMm / years, 'mm'),
        runoff: q(wb.runoffMm / years, 'mm'),
      },
      charts: [
        lineChart({
          kind: 'bar',
          title: 'Annual water balance',
          xLabel: 'Component',
          yLabel: 'Depth',
          unit: 'mm',
          series: [{ key: 'v', label: 'Annual depth', color: CHART_COLORS.observed }],
          data: [
            { t: 'Precipitation', v: wb.precipitationMm / years },
            { t: 'Evapotranspiration', v: wb.evapotranspirationMm / years },
            { t: 'Runoff', v: wb.runoffMm / years },
            { t: 'Residual (ΔS)', v: wb.residualMm / years },
          ],
          caption: 'Mean annual fluxes as equivalent depth over the catchment. The residual is what the balance does not explain.',
        }),
      ],
      warnings: wb.closureQuality === 'poor' ? wb.notes : [],
      provenance: p.build(args),
    },
  );
}

// ---------------------------------------------------------------------------
// Water supply
// ---------------------------------------------------------------------------

export async function analyzeWaterSupply(
  ctx: ToolContext,
  args: { scenario?: ScenarioName; horizonMonths?: number } = {},
): Promise<ToolResult> {
  const scenarioName = args.scenario ?? 'baseline';
  const scenario = SCENARIOS[scenarioName] ?? SCENARIOS.baseline;
  const p = new ProvenanceBuilder('analyze_reservoir_storage', { projectId: ctx.projectId, userId: ctx.userId });

  const reservoirs = await ctx.db.listReservoirs(ctx.watershedId ?? undefined);
  const reservoir = reservoirs[0];
  if (!reservoir) return insufficient(p, 'No reservoir is defined for this watershed.', args);

  const obs = await ctx.db.getReservoirSeries(reservoir.id);
  const demandRows = await ctx.db.getDemand(ctx.projectId);
  if (obs.length < 24) return insufficient(p, 'At least two years of monthly reservoir observations are required.', args);

  const demandByMonth = new Map<string, number>();
  for (const d of demandRows) demandByMonth.set(d.t, (demandByMonth.get(d.t) ?? 0) + d.demandMcm);

  const steps = obs.map((o) => {
    const daysInMonth = new Date(Date.UTC(Number(o.t.slice(0, 4)), Number(o.t.slice(5, 7)), 0)).getUTCDate();
    const inflowMcm = (o.inflowM3s * daysInMonth * 86400) / 1e6;
    // The reservoir supplies a share of total system demand; the remainder
    // comes from run-of-river intakes, groundwater and purchases.
    const demandMcm = (demandByMonth.get(o.t) ?? 0) * RESERVOIR_DEMAND_SHARE;
    return {
      t: o.t,
      inflowMcm: inflowMcm * scenario.inflowFactor,
      demandMcm: demandMcm * scenario.demandFactor,
      evaporationMcm: o.evaporationMcm,
      minimumReleaseMcm: (MINIMUM_INSTREAM_RELEASE_M3S * daysInMonth * 86400) / 1e6,
    };
  });

  const config = {
    capacityMcm: reservoir.capacityMcm,
    deadStorageMcm: reservoir.deadStorageMcm,
    initialStorageMcm: obs[0].storageMcm,
  };
  const sim = simulateReservoir(config, steps);
  const yieldMcm = safeYield(config, steps.map(({ t, inflowMcm, evaporationMcm, minimumReleaseMcm }) => ({ t, inflowMcm, evaporationMcm, minimumReleaseMcm })));
  const exceedance = storageExceedance(sim.steps.map((s) => s.storageMcm));
  ctx.emit?.(`Simulated ${steps.length} months of reservoir operation under the ${scenario.label.toLowerCase()} scenario`, 'ok', `reliability ${(sim.timeReliability * 100).toFixed(1)} %`);

  p.source(demoSource(`${reservoir.name} operations and system demand`, ['reservoir_storage', 'inflow', 'water_demand'], { reservoir_storage: 'MCM', inflow: 'm3/s', water_demand: 'MCM' }, { start: obs[0].t, end: obs[obs.length - 1].t }, obs.length, reservoir.name))
    .method({ name: 'Sequential reservoir mass-balance simulation', kind: 'hydrologic_model', implementation: '@hydro/hydrology-core simulateReservoir', reference: null, parameters: { ...config, rule: 'meet demand from storage above dead pool, after the minimum instream release' } })
    .method({ name: 'Reliability, resilience and vulnerability', kind: 'statistic', implementation: '@hydro/hydrology-core simulateReservoir', reference: METHOD_REFERENCES.reliability, parameters: {} })
    .method({ name: 'Safe yield by bisection on the historical inflow sequence', kind: 'statistic', implementation: '@hydro/hydrology-core safeYield', reference: null, parameters: {} })
    .step('scenario', `Applied the ${scenario.label} scenario.`, { inflowFactor: scenario.inflowFactor, demandFactor: scenario.demandFactor })
    .step('simulate', 'Ran the monthly mass balance over the full inflow record.', { months: steps.length })
    .step('metrics', 'Computed reliability, resilience, vulnerability and the storage exceedance curve.', {})
    .coverage(obs[0].t, obs[obs.length - 1].t)
    .extent(reservoir.name)
    .assume(
      `The reservoir supplies ${(RESERVOIR_DEMAND_SHARE * 100).toFixed(0)} % of total system demand; the remainder comes from run-of-river intakes, groundwater and purchases.`,
      'The operating rule is "meet demand from storage above the dead pool after the minimum instream release" — a simplification of any real rule curve.',
      scenarioName === 'baseline' ? 'Historical inflows repeat; the record is treated as representative of future hydrology.' : `Scenario factors are illustrative multipliers, not the output of a climate or demand model. ${scenario.description}`,
    )
    .limit(
      'A single-reservoir monthly simulation cannot represent conjunctive use, system operation across multiple reservoirs, or sub-monthly shortages.',
      'Safe yield is conditional on the historical sequence; a drought worse than the record would give a lower value.',
    )
    .uncertain({ sources: ['Inflow sequence is a single historical realisation, not a stochastic ensemble.', 'Demand allocation between sources is assumed.'], qualitative: 'high' });

  return ok(
    `Under the ${scenario.label.toLowerCase()} scenario the reservoir meets demand in ${(sim.timeReliability * 100).toFixed(1)} % of months (volumetric reliability ${(sim.volumetricReliability * 100).toFixed(1)} %). ` +
      `Safe yield on the historical sequence is ${fmt(yieldMcm * 12, 'MCM')}/yr. Deficit probability is ${(sim.deficitProbability * 100).toFixed(1)} % and the worst single-month shortfall is ${fmt(sim.vulnerabilityMcm, 'MCM')}.`,
    {
      data: {
        reservoir,
        scenario: { name: scenarioName, ...scenario },
        simulation: sim.steps.slice(-180),
        reliability: {
          timeReliability: sim.timeReliability,
          volumetricReliability: sim.volumetricReliability,
          resilience: sim.resilience,
          vulnerabilityMcm: sim.vulnerabilityMcm,
          deficitProbability: sim.deficitProbability,
          safeYieldMcmPerYear: yieldMcm * 12,
        },
        storageExceedance: exceedance,
        currentStorageMcm: obs[obs.length - 1].storageMcm,
        currentStoragePct: (obs[obs.length - 1].storageMcm / reservoir.capacityMcm) * 100,
      },
      metrics: {
        timeReliability: sim.timeReliability,
        volumetricReliability: sim.volumetricReliability,
        resilience: sim.resilience,
        vulnerabilityMcm: sim.vulnerabilityMcm,
        deficitProbability: sim.deficitProbability,
        safeYieldMcmPerYear: yieldMcm * 12,
        currentStoragePct: (obs[obs.length - 1].storageMcm / reservoir.capacityMcm) * 100,
      },
      quantities: {
        currentStorage: q(obs[obs.length - 1].storageMcm, 'MCM'),
        capacity: q(reservoir.capacityMcm, 'MCM'),
        safeYield: q(yieldMcm * 12, 'MCM'),
      },
      charts: [
        lineChart({
          kind: 'area',
          title: `Reservoir storage — ${reservoir.name} (${scenario.label})`,
          xLabel: 'Month',
          yLabel: 'Storage',
          unit: 'MCM',
          series: [
            { key: 'storage', label: 'Simulated storage', kind: 'simulated', color: CHART_COLORS.observed },
            { key: 'demand', label: 'Demand on the reservoir', kind: 'threshold', color: CHART_COLORS.simulated },
          ],
          data: sim.steps.slice(-180).map((s) => ({ t: s.t, storage: s.storageMcm, demand: s.demandMcm })),
          annotations: [
            { kind: 'hline', value: reservoir.capacityMcm, label: 'Capacity', color: CHART_COLORS.neutral },
            { kind: 'hline', value: reservoir.conservationPoolMcm ?? reservoir.capacityMcm * 0.8, label: 'Conservation pool', color: CHART_COLORS.secondary },
            { kind: 'hline', value: reservoir.deadStorageMcm, label: 'Dead storage', color: CHART_COLORS.threshold },
          ],
          caption: 'Simulated end-of-month storage over the last 15 years of the inflow record under the selected scenario.',
        }),
        lineChart({
          kind: 'line',
          title: 'Storage exceedance',
          xLabel: 'Exceedance probability (%)',
          yLabel: 'Storage',
          unit: 'MCM',
          series: [{ key: 'storage', label: 'Storage', color: CHART_COLORS.observed }],
          data: exceedance.map((e) => ({ t: (e.probability * 100).toFixed(0), storage: e.storageMcm })),
          caption: 'Storage equalled or exceeded a given proportion of the simulated months.',
        }),
      ],
      warnings: sim.deficitProbability > 0.1 ? [`Demand is unmet in ${(sim.deficitProbability * 100).toFixed(1)} % of simulated months under this scenario.`] : [],
      provenance: p.build(args),
    },
  );
}

/** perform_supply_demand_balance across several scenarios. */
export async function supplyDemandBalance(ctx: ToolContext, args: { scenarios?: ScenarioName[] } = {}): Promise<ToolResult> {
  const names = args.scenarios ?? (['baseline', 'dry', 'extreme_drought', 'conservation'] as ScenarioName[]);
  const p = new ProvenanceBuilder('perform_supply_demand_balance', { projectId: ctx.projectId, userId: ctx.userId });

  const results: { scenario: ScenarioName; label: string; reliability: number; deficitProbability: number; totalShortfallMcm: number; monthsInDeficit: number; safeYieldMcmPerYear: number }[] = [];
  let lastData: Record<string, unknown> = {};

  for (const name of names) {
    const r = await analyzeWaterSupply(ctx, { scenario: name });
    if (!r.ok) continue;
    const rel = (r.data.reliability ?? {}) as Record<string, number>;
    results.push({
      scenario: name,
      label: SCENARIOS[name].label,
      reliability: rel.timeReliability,
      deficitProbability: rel.deficitProbability,
      totalShortfallMcm: ((r.data.simulation as { shortfallMcm: number }[]) ?? []).reduce((s, x) => s + x.shortfallMcm, 0),
      monthsInDeficit: ((r.data.simulation as { shortfallMcm: number }[]) ?? []).filter((x) => x.shortfallMcm > 1e-9).length,
      safeYieldMcmPerYear: rel.safeYieldMcmPerYear,
    });
    if (name === names[0]) lastData = r.data;
  }
  ctx.emit?.('Compared supply and demand across scenarios', 'ok', names.join(', '));

  if (results.length === 0) return insufficient(p, 'No scenario could be simulated because the reservoir or demand record is unavailable.', args);

  p.source(demoSource('Reservoir operations and sectoral demand', ['reservoir_storage', 'water_demand'], { reservoir_storage: 'MCM', water_demand: 'MCM' }, null, 0, 'Potomac Demonstration Watershed'))
    .method({ name: 'Scenario comparison of reservoir reliability', kind: 'hydrologic_model', implementation: 'analyzeWaterSupply per scenario', reference: METHOD_REFERENCES.reliability, parameters: { scenarios: names } })
    .step('simulate', 'Ran the reservoir mass balance once per scenario over the same inflow record.', { scenarios: names.length })
    .assume('Scenarios differ only through multiplicative inflow and demand factors; no change in operating rule or system configuration is represented.')
    .limit('Scenario factors are illustrative planning assumptions, not projections from a climate or econometric model.')
    .uncertain({ sources: ['Scenario definition dominates the spread of results.'], qualitative: 'high' });

  const worst = results.reduce((a, b) => (a.reliability < b.reliability ? a : b));
  const best = results.reduce((a, b) => (a.reliability > b.reliability ? a : b));

  return ok(
    `Across ${results.length} scenarios, reliability ranges from ${(worst.reliability * 100).toFixed(1)} % (${worst.label}) to ${(best.reliability * 100).toFixed(1)} % (${best.label}). ` +
      `The ${worst.label.toLowerCase()} scenario leaves ${fmt(worst.totalShortfallMcm, 'MCM')} of cumulative demand unmet across ${worst.monthsInDeficit} months.`,
    {
      data: { scenarios: results, baseline: lastData, definitions: Object.fromEntries(names.map((n) => [n, SCENARIOS[n]])) },
      metrics: Object.fromEntries(results.map((r) => [`${r.scenario}_reliability`, r.reliability])),
      charts: [
        lineChart({
          kind: 'bar',
          title: 'Supply reliability by scenario',
          xLabel: 'Scenario',
          yLabel: 'Months in which demand is fully met',
          unit: '%',
          series: [{ key: 'reliability', label: 'Time reliability', color: CHART_COLORS.observed }],
          data: results.map((r) => ({ t: r.label, reliability: r.reliability * 100 })),
          caption: 'Percentage of simulated months in which the reservoir met the full demand placed on it.',
        }),
        lineChart({
          kind: 'bar',
          title: 'Cumulative unmet demand by scenario',
          xLabel: 'Scenario',
          yLabel: 'Cumulative shortfall',
          unit: 'MCM',
          series: [{ key: 'shortfall', label: 'Cumulative shortfall', color: CHART_COLORS.threshold }],
          data: results.map((r) => ({ t: r.label, shortfall: r.totalShortfallMcm })),
          caption: 'Total volume of demand not delivered over the whole simulation period.',
        }),
      ],
      provenance: p.build(args),
    },
  );
}

// ---------------------------------------------------------------------------
// Water demand
// ---------------------------------------------------------------------------

export async function forecastWaterDemand(
  ctx: ToolContext,
  args: { horizonMonths?: number; sector?: 'municipal' | 'agricultural' | 'industrial' | 'total' } = {},
): Promise<ToolResult> {
  const horizon = Math.min(Math.max(args.horizonMonths ?? 12, 1), 60);
  const sector = args.sector ?? 'total';
  const p = new ProvenanceBuilder('forecast_water_demand', { projectId: ctx.projectId, userId: ctx.userId });

  const rows = await ctx.db.getDemand(ctx.projectId);
  if (rows.length < 36) return insufficient(p, 'At least three years of monthly demand records are required to fit a demand model.', args);

  const byMonth = new Map<string, { total: number; municipal: number; agricultural: number; industrial: number; population: number }>();
  for (const r of rows) {
    const rec = byMonth.get(r.t) ?? { total: 0, municipal: 0, agricultural: 0, industrial: 0, population: r.population };
    rec[r.sector] += r.demandMcm;
    rec.total += r.demandMcm;
    rec.population = r.population;
    byMonth.set(r.t, rec);
  }
  const months = [...byMonth.keys()].sort();
  const values = months.map((m) => byMonth.get(m)![sector]);
  ctx.emit?.('Assembled the monthly demand record', 'ok', `${months.length} months`);

  // Decompose: trend (population + efficiency) + monthly seasonal index.
  const t = months.map((_, i) => i / 12);
  const { slope, intercept, r2 } = linearRegression(t, values);
  const detrended = values.map((v, i) => v - (intercept + slope * t[i]));
  const seasonal = new Map<number, number>();
  for (let m = 1; m <= 12; m++) {
    const vals = detrended.filter((_, i) => Number(months[i].slice(5, 7)) === m);
    seasonal.set(m, vals.length ? mean(vals) : 0);
  }
  const fitted = values.map((_, i) => intercept + slope * t[i] + (seasonal.get(Number(months[i].slice(5, 7))) ?? 0));
  const residuals = values.map((v, i) => v - fitted[i]);
  const residSd = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / Math.max(residuals.length - 13, 1));
  ctx.emit?.('Fitted a trend-plus-seasonal decomposition', 'ok', `R² ${r2.toFixed(3)}`);

  const lastMonth = months[months.length - 1];
  const points = Array.from({ length: horizon }, (_, k) => {
    const tt = months.length + k;
    const date = addMonths(lastMonth, k + 1);
    const m = Number(date.slice(5, 7));
    const meanV = intercept + slope * (tt / 12) + (seasonal.get(m) ?? 0);
    const grow = Math.sqrt(1 + k / 12);
    return {
      t: date,
      mean: Math.max(meanV, 0),
      lower80: Math.max(meanV - 1.2816 * residSd * grow, 0),
      upper80: meanV + 1.2816 * residSd * grow,
      lower95: Math.max(meanV - 1.96 * residSd * grow, 0),
      upper95: meanV + 1.96 * residSd * grow,
    };
  });

  const zs = modifiedZScores(residuals);
  const anomalies = months
    .map((m, i) => ({ t: m, observed: values[i], expected: fitted[i], zScore: Number(zs[i].toFixed(2)) }))
    .filter((a) => Math.abs(a.zScore) > 3.5)
    .slice(-12);

  const peak = points.reduce((a, b) => (b.mean > a.mean ? b : a), points[0]);
  const validationSplit = Math.floor(months.length * 0.8);
  const { evaluate } = await import('@hydro/hydrology-core');
  const metrics = evaluate(values.slice(validationSplit), fitted.slice(validationSplit));

  p.source(demoSource('Monthly sectoral water demand', ['water_demand', 'population'], { water_demand: 'MCM' }, { start: months[0], end: lastMonth }, rows.length, 'Demonstration service area'))
    .method({ name: 'Linear trend with additive monthly seasonal indices', kind: 'statistic', implementation: '@hydro/hydrology-core linearRegression + monthly means of the detrended series', reference: null, parameters: { sector, horizonMonths: horizon } })
    .method({ name: 'Modified z-score anomaly detection on residuals', kind: 'statistic', implementation: '@hydro/hydrology-core modifiedZScores', reference: METHOD_REFERENCES.modifiedZ, parameters: { threshold: 3.5 } })
    .step('aggregate', 'Aggregated sectoral demand to a monthly total.', { sector })
    .step('decompose', 'Estimated the long-term trend by ordinary least squares and the seasonal shape from the detrended residuals.', { slopeMcmPerYear: slope, r2 })
    .step('project', 'Projected the trend and seasonal shape forward, widening the interval with the square root of lead time.', { horizonMonths: horizon })
    .coverage(months[0], points[points.length - 1].t)
    .extent('Demonstration municipal service area')
    .assume(
      'The historical trend in per-capita use and population continues unchanged over the forecast horizon.',
      'The seasonal shape is stable; no change in restriction policy or tariff structure is represented.',
      'Weather is at climatological normal over the forecast period — no temperature or rainfall forcing is applied beyond the record.',
    )
    .limit(
      'A linear trend cannot represent a step change from a new large customer, a tariff reform, or a drought restriction.',
      'Random Forest, XGBoost and LSTM demand models are available through the Python scientific service and are more appropriate where weather covariates are available.',
    )
    .uncertain({
      sources: ['Trend extrapolation error grows with horizon.', 'Weather variability is not represented in the mean, only in the interval width.'],
      interval: { level: 0.95, lower: points[0].lower95, upper: points[0].upper95, unit: 'MCM' },
      validationMetrics: { r2, nse: metrics.nse, rmse: metrics.rmse },
      qualitative: 'moderate',
    });

  const history = months.slice(-48);

  return ok(
    `${horizon}-month ${sector} demand forecast: mean ${fmt(mean(points.map((x) => x.mean)), 'MCM')}/month, peaking at ${fmt(peak.mean, 'MCM')} in ${peak.t.slice(0, 7)}. ` +
      `The fitted trend is ${slope >= 0 ? '+' : ''}${slope.toFixed(3)} MCM per year (R² ${r2.toFixed(3)}).`,
    {
      data: {
        sector,
        months,
        observed: values,
        fitted,
        forecast: points,
        seasonalIndex: [...seasonal.entries()].map(([month, indexValue]) => ({ month, indexValue })),
        anomalies,
        trendMcmPerYear: slope,
        r2,
        peakDemand: { value: peak.mean, date: peak.t },
        population: byMonth.get(lastMonth)?.population ?? null,
        sectorShares: {
          municipal: byMonth.get(lastMonth)?.municipal ?? 0,
          agricultural: byMonth.get(lastMonth)?.agricultural ?? 0,
          industrial: byMonth.get(lastMonth)?.industrial ?? 0,
        },
      },
      metrics: { trendMcmPerYear: slope, r2, peakDemandMcm: peak.mean, residualSd: residSd, nse: metrics.nse, rmse: metrics.rmse },
      quantities: { peakDemand: q(peak.mean, 'MCM'), meanForecast: q(mean(points.map((x) => x.mean)), 'MCM') },
      charts: [
        lineChart({
          kind: 'forecast',
          title: `${sector[0].toUpperCase()}${sector.slice(1)} water demand forecast`,
          xLabel: 'Month',
          yLabel: 'Demand',
          unit: 'MCM',
          series: [
            { key: 'observed', label: 'Observed', kind: 'observed', color: CHART_COLORS.observed },
            { key: 'fitted', label: 'Fitted', kind: 'simulated', color: CHART_COLORS.secondary },
            { key: 'forecast', label: 'Forecast', kind: 'forecast', color: CHART_COLORS.forecast },
            { key: 'upper95', label: '95 % interval', kind: 'band', color: CHART_COLORS.band },
            { key: 'lower95', label: '95 % interval', kind: 'band', color: CHART_COLORS.band },
          ],
          data: [
            ...history.map((m) => {
              const i = months.indexOf(m);
              return { t: m, observed: values[i], fitted: fitted[i], forecast: null, lower95: null, upper95: null };
            }),
            ...points.map((pt) => ({ t: pt.t.slice(0, 7), observed: null, fitted: null, forecast: pt.mean, lower95: pt.lower95, upper95: pt.upper95 })),
          ],
          caption: 'Last four years of observed demand with the fitted trend-plus-seasonal model and its forward projection.',
        }),
        lineChart({
          kind: 'bar',
          title: 'Seasonal demand shape',
          xLabel: 'Month',
          yLabel: 'Departure from trend',
          unit: 'MCM',
          series: [{ key: 'index', label: 'Seasonal index', color: CHART_COLORS.secondary }],
          data: [...seasonal.entries()].map(([m, v]) => ({ t: new Date(Date.UTC(2020, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), index: v })),
          caption: 'Average departure from the long-term trend by calendar month.',
        }),
      ],
      warnings: anomalies.length > 0 ? [`${anomalies.length} months depart from the fitted model by more than 3.5 modified standard deviations and should be checked for metering or reporting errors.`] : [],
      provenance: p.build(args),
    },
  );
}
