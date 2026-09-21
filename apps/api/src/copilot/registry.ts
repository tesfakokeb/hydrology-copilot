import { calibrateGr4j, depthToDischarge, evaluate, GR4J_REFERENCE, hargreavesPet, runGr4j, METHOD_REFERENCES } from '@hydro/hydrology-core';
import type { ScenarioName, ToolResult } from '@hydro/shared-types';
import { ProvenanceBuilder } from '../services/provenance.js';
import { insufficient, ok, type ToolContext } from '../services/analysis/common.js';
import { assessDrought, calculateDroughtIndex } from '../services/analysis/drought.js';
import { analyzeFloodRisk, calculateFloodFrequency, estimateReturnPeriodTool } from '../services/analysis/flood.js';
import { forecastStreamflow } from '../services/analysis/forecasting.js';
import { analyzePrecipitation, analyzeWatershed, runGisAnalysis } from '../services/analysis/gis.js';
import { runHydrologicModel } from '../services/analysis/modeling.js';
import { analyzeWaterQuality } from '../services/analysis/quality.js';
import { generateReport } from '../services/analysis/report.js';
import { analyzeStreamflow, detectFloodEvents, evaluateModelSeries, getStreamflow } from '../services/analysis/streamflow.js';
import { analyzeWaterSupply, calculateWaterBalance, forecastWaterDemand, supplyDemandBalance } from '../services/analysis/water.js';
import { TOOLS_BY_NAME } from './tools.js';

export type ToolExecutor = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * Tool executors.
 *
 * The Copilot never touches the database or the science routines directly: it
 * chooses a tool name and arguments, and this registry is the only thing that
 * runs. That boundary is what makes every Copilot answer traceable to a
 * provenance record produced by a specific, versioned function.
 */
export const EXECUTORS: Record<string, ToolExecutor> = {
  get_streamflow: (ctx, a) => getStreamflow(ctx, { stationId: asString(a.stationId), startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  analyze_streamflow: (ctx, a) => analyzeStreamflow(ctx, { stationId: asString(a.stationId), startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  calculate_flow_statistics: (ctx, a) => analyzeStreamflow(ctx, { stationId: asString(a.stationId), startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  forecast_streamflow: (ctx, a) =>
    forecastStreamflow(ctx, {
      stationId: asString(a.stationId),
      horizonDays: asNumber(a.horizonDays),
      model: asString(a.model) as never,
    }),
  detect_flood_events: (ctx, a) =>
    detectFloodEvents(ctx, {
      stationId: asString(a.stationId),
      thresholdPercentile: asNumber(a.thresholdPercentile),
      minSeparationDays: asNumber(a.minSeparationDays),
      startDate: asString(a.startDate),
      endDate: asString(a.endDate),
    }),

  calculate_spi: (ctx, a) => calculateDroughtIndex(ctx, { index: 'SPI', timescaleMonths: asNumber(a.timescaleMonths), startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  calculate_spei: (ctx, a) => calculateDroughtIndex(ctx, { index: 'SPEI', timescaleMonths: asNumber(a.timescaleMonths) ?? 6, startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  calculate_pdsi: async (ctx, a) => {
    const p = new ProvenanceBuilder('calculate_pdsi', { projectId: ctx.projectId, userId: ctx.userId });
    const def = TOOLS_BY_NAME.calculate_pdsi;
    return insufficient(
      p,
      'The Palmer Drought Severity Index cannot be computed from the data held in this project. ' +
        (def.integrationNote ?? '') +
        ' SPEI is available now and answers a similar question by combining precipitation with atmospheric demand.',
      a,
    );
  },
  assess_drought: (ctx, a) => assessDrought(ctx, { startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  forecast_drought: async (ctx, a) => {
    // Persistence of the current accumulation under zero future precipitation.
    const r = await calculateDroughtIndex(ctx, { index: 'SPI', timescaleMonths: asNumber(a.timescaleMonths) ?? 3 });
    if (!r.ok) return r;
    r.warnings.push(
      'Drought forecasting here is a no-additional-precipitation projection of the current accumulation state. It is a conservative bound on recovery, not a seasonal outlook. A skilful drought forecast requires a seasonal climate forecast, which this deployment does not ingest.',
    );
    return { ...r, summary: `${r.summary} Projected forward under a no-additional-precipitation assumption, the index would continue to decline until the accumulation window clears the current deficit.` };
  },

  analyze_water_quality: (ctx, a) =>
    analyzeWaterQuality(ctx, {
      stationId: asString(a.stationId),
      parameters: Array.isArray(a.parameters) ? (a.parameters as string[]) : undefined,
      startDate: asString(a.startDate),
      endDate: asString(a.endDate),
    }),
  calculate_wqi: (ctx, a) => analyzeWaterQuality(ctx, { stationId: asString(a.stationId), startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  detect_water_quality_trends: (ctx, a) => analyzeWaterQuality(ctx, { stationId: asString(a.stationId), startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  detect_water_quality_anomalies: (ctx, a) => analyzeWaterQuality(ctx, { stationId: asString(a.stationId) }),

  analyze_watershed: (ctx, a) => analyzeWatershed(ctx, { watershedId: asString(a.watershedId) }),
  calculate_watershed_statistics: (ctx, a) => analyzeWatershed(ctx, { watershedId: asString(a.watershedId) }),
  calculate_water_balance: (ctx, a) => calculateWaterBalance(ctx, { startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  analyze_precipitation: (ctx, a) => analyzePrecipitation(ctx, { startDate: asString(a.startDate), endDate: asString(a.endDate) }),
  analyze_evapotranspiration: (ctx, a) => calculateWaterBalance(ctx, { startDate: asString(a.startDate), endDate: asString(a.endDate) }),

  run_hydrologic_model: (ctx, a) =>
    runHydrologicModel(ctx, { engine: asString(a.engine) as never, calibrate: asBool(a.calibrate), parameters: (a.parameters as Record<string, number>) ?? undefined }),
  calibrate_model: (ctx, a) => runHydrologicModel(ctx, { engine: 'GR4J', calibrate: true }),
  evaluate_hydrologic_model: async (ctx, a) => {
    const engine = asString(a.engine) ?? 'GR4J';
    if (engine !== 'GR4J') return runHydrologicModel(ctx, { engine: engine as never });
    // Run GR4J and evaluate it, which is what "evaluate my model" means when
    // no external engine output has been uploaded.
    const [precip, tmax, tmin, flow] = await Promise.all([
      ctx.db.getSeries({ variable: 'precipitation' }),
      ctx.db.getSeries({ variable: 'temperature_max' }),
      ctx.db.getSeries({ variable: 'temperature_min' }),
      ctx.db.getSeries({ variable: 'discharge' }),
    ]);
    const watershed = (await ctx.db.listWatersheds())[0];
    const dates = precip.points.map((p) => p.t);
    if (dates.length < 730) return insufficient(new ProvenanceBuilder('evaluate_hydrologic_model', { projectId: ctx.projectId, userId: ctx.userId }), 'At least two years of forcing are required.', a);
    const lat = watershed?.centroid?.lat ?? 39.3;
    const pet = dates.map((d, i) => {
      const doy = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.UTC(Number(d.slice(0, 4)), 0, 1)) / 86400000) + 1;
      return hargreavesPet(tmax.points[i]?.v ?? 15, tmin.points[i]?.v ?? 5, lat, doy);
    });
    const observed = flow.points.map((p) => p.v);
    const cal = calibrateGr4j({ precipitation: precip.points.map((p) => p.v ?? 0), pet, dates, observedM3s: observed, areaKm2: watershed?.areaKm2 ?? 1000 }, { maxIterations: 25 });
    const sim = depthToDischarge(runGr4j({ precipitation: precip.points.map((p) => p.v ?? 0), pet }, cal.parameters).runoffMm, watershed?.areaKm2 ?? 1000);
    const from = Math.max(365, dates.length - 900);
    const result = await evaluateModelSeries(ctx, {
      observed: observed.slice(from),
      simulated: sim.slice(from),
      dates: dates.slice(from),
      label: 'GR4J (calibrated)',
      unit: 'm3/s',
    });
    result.data.calibration = { parameters: cal.parameters, iterations: cal.iterations, objective: cal.objective, objectiveValue: cal.objectiveValue, calibrationPeriod: cal.calibration, validationPeriod: cal.validation };
    result.provenance.methods.push({
      name: 'GR4J',
      kind: 'hydrologic_model',
      implementation: '@hydro/hydrology-core runGr4j',
      reference: GR4J_REFERENCE,
      parameters: { ...cal.parameters } as Record<string, unknown>,
    });
    return result;
  },

  calculate_flood_frequency: (ctx, a) =>
    calculateFloodFrequency(ctx, { stationId: asString(a.stationId), method: asString(a.method) as never, regionalSkew: asNumber(a.regionalSkew) }),
  estimate_return_period: async (ctx, a) => {
    const discharge = asNumber(a.discharge);
    if (discharge === undefined) {
      return insufficient(new ProvenanceBuilder('estimate_return_period', { projectId: ctx.projectId, userId: ctx.userId }), 'A discharge value in m³/s is required to estimate a return period.', a);
    }
    return estimateReturnPeriodTool(ctx, { discharge, stationId: asString(a.stationId) });
  },
  analyze_flood_risk: (ctx, a) => analyzeFloodRisk(ctx, { stationId: asString(a.stationId), horizonDays: asNumber(a.horizonDays) }),
  generate_floodplain_map: async (ctx, a) => {
    const r = await analyzeFloodRisk(ctx, {});
    r.warnings.unshift(
      'A floodplain map that can be used for anything requires a HEC-RAS 2D run with terrain, mesh, roughness and boundary conditions. The map returned here is an illustrative footprint scaled by forecast discharge, produced so the mapping surface can be exercised — it is not a hydraulic result and must not be read as one.',
    );
    return { ...r, summary: `Illustrative inundation footprint only. ${r.summary}` };
  },

  analyze_reservoir_storage: (ctx, a) => analyzeWaterSupply(ctx, { scenario: asString(a.scenario) as ScenarioName }),
  forecast_water_supply: (ctx, a) => analyzeWaterSupply(ctx, { scenario: asString(a.scenario) as ScenarioName }),
  perform_supply_demand_balance: (ctx, a) => supplyDemandBalance(ctx, { scenarios: Array.isArray(a.scenarios) ? (a.scenarios as ScenarioName[]) : undefined }),
  forecast_water_demand: (ctx, a) => forecastWaterDemand(ctx, { horizonMonths: asNumber(a.horizonMonths), sector: asString(a.sector) as never }),
  analyze_consumption: (ctx, a) => forecastWaterDemand(ctx, { horizonMonths: 12, sector: asString(a.sector) as never }),
  detect_demand_anomalies: (ctx, a) => forecastWaterDemand(ctx, { horizonMonths: 6, sector: asString(a.sector) as never }),

  run_gis_analysis: (ctx, a) => runGisAnalysis(ctx, { operation: asString(a.operation) as never, lon: asNumber(a.lon), lat: asNumber(a.lat) }),
  intersect_spatial_layers: (ctx, a) => runGisAnalysis(ctx, { operation: 'stations_in_watershed' }),

  generate_report: async (ctx, a) => {
    const r = await generateReport(ctx, { kind: asString(a.kind) as never, title: asString(a.title) });
    return r;
  },
};

export function hasExecutor(name: string): boolean {
  return name in EXECUTORS;
}

/** Method references surfaced alongside tool documentation in the UI. */
export const TOOL_REFERENCES = METHOD_REFERENCES;

export { evaluate };
