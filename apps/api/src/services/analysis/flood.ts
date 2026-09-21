import {
  annualPeaks,
  bankfullProxy,
  classifyHazard,
  encounterProbability,
  estimateReturnPeriod,
  forecast as baselineForecast,
  gevLMoments,
  logPearson3,
  METHOD_REFERENCES,
  REGULATORY_DISCLAIMER,
  thresholdExceedanceProbability,
} from '@hydro/hydrology-core';
import type { FloodRiskAssessment, ToolResult } from '@hydro/shared-types';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, fmt, insufficient, lineChart, mapSpec, ok, q, type ToolContext } from './common.js';
import { loadFlow } from './streamflow.js';

/** calculate_flood_frequency */
export async function calculateFloodFrequency(
  ctx: ToolContext,
  args: { stationId?: string; method?: 'log-pearson-iii' | 'gev'; regionalSkew?: number },
): Promise<ToolResult> {
  const p = new ProvenanceBuilder('calculate_flood_frequency', { projectId: ctx.projectId, userId: ctx.userId });
  const { station, series } = await loadFlow(ctx, args.stationId);
  const dates = series.points.map((pt) => pt.t);
  const values = series.points.map((pt) => pt.v);
  const peaks = annualPeaks(dates, values);
  ctx.emit?.('Extracted annual peak series', 'ok', `${peaks.length} water years`);

  if (peaks.length < 10) {
    return insufficient(p, `Only ${peaks.length} annual peaks are available. Bulletin 17C guidance calls for at least 10 water years, and 25 or more for a defensible 1 %-annual-chance estimate.`, args);
  }

  const lp3 = logPearson3(peaks, series.unit as 'm3/s', { regionalSkew: args.regionalSkew });
  const gev = gevLMoments(peaks.map((x) => x.peak), series.unit as 'm3/s');
  const primary = args.method === 'gev' ? gev : lp3;
  ctx.emit?.('Fitted flood-frequency distributions', 'ok', 'Log-Pearson III and GEV (L-moments)');

  p.source(demoSource(`Annual peak discharge — ${station?.name}`, ['discharge'], { discharge: series.unit }, { start: dates[0], end: dates[dates.length - 1] }, peaks.length, station?.name ?? ''))
    .method({ name: 'Log-Pearson Type III with Wilson–Hilferty frequency factors', kind: 'statistic', implementation: '@hydro/hydrology-core logPearson3', reference: METHOD_REFERENCES.lp3, parameters: { skewOption: lp3.skewOption, regionalSkew: args.regionalSkew ?? null } })
    .method({ name: 'GEV fitted by L-moments', kind: 'statistic', implementation: '@hydro/hydrology-core gevLMoments', reference: METHOD_REFERENCES.gev, parameters: {} })
    .step('extract', 'Extracted the annual maximum daily mean discharge for each USGS water year.', {})
    .step('fit', 'Fitted both distributions to the annual peak series.', { nYears: peaks.length })
    .step('quantile', 'Evaluated design quantiles at standard return periods with first-order confidence limits.', {})
    .coverage(dates[0], dates[dates.length - 1])
    .extent(station?.name ?? null)
    .assume(
      'Annual peaks are independent and identically distributed — the stationarity assumption underlying Bulletin 17C.',
      'Peaks are annual maxima of daily mean discharge, which under-estimates instantaneous peaks, typically by 5–20 % on a basin of this size.',
    )
    .limit(
      ...lp3.notes,
      ...REGULATORY_DISCLAIMER,
      'Bulletin 17C Expected Moments Algorithm, low-outlier (MGBT) screening and regional skew mapping are not implemented; this is a simplified at-site analysis.',
    )
    .uncertain({
      sources: [
        `Sampling uncertainty from a ${peaks.length}-year record dominates; the 1 %-annual-chance confidence interval spans a factor of roughly ${(((lp3.quantiles.find((x) => x.returnPeriodYears === 100)?.upper95 ?? 1) / (lp3.quantiles.find((x) => x.returnPeriodYears === 100)?.lower95 ?? 1))).toFixed(1)}.`,
        'Distribution choice: LP3 and GEV give materially different tails.',
        'Non-stationarity from land-use or climate change is not represented.',
      ],
      qualitative: peaks.length < 25 ? 'high' : 'moderate',
    });

  const q100 = primary.quantiles.find((x) => x.returnPeriodYears === 100);
  const q500 = primary.quantiles.find((x) => x.returnPeriodYears === 500);

  return ok(
    `Fitted ${primary.method === 'gev' ? 'GEV' : 'log-Pearson III'} to ${peaks.length} annual peaks. The 1 %-annual-chance (100-year) discharge is ${fmt(q100?.discharge ?? null, series.unit)}` +
      (q100?.lower95 ? ` (95 % interval ${fmt(q100.lower95, series.unit)} to ${fmt(q100.upper95, series.unit)})` : '') +
      `; the 0.2 %-annual-chance (500-year) discharge is ${fmt(q500?.discharge ?? null, series.unit)}.`,
    {
      data: {
        primary,
        logPearson3: lp3,
        gev,
        annualPeaks: peaks,
        comparison: lp3.quantiles.map((qq, i) => ({
          returnPeriodYears: qq.returnPeriodYears,
          lp3: qq.discharge,
          gev: gev.quantiles[i]?.discharge ?? null,
          lower95: qq.lower95,
          upper95: qq.upper95,
        })),
        encounterProbabilities: [10, 30, 50].map((yrs) => ({
          horizonYears: yrs,
          p100: encounterProbability(100, yrs),
          p500: encounterProbability(500, yrs),
        })),
      },
      metrics: {
        nYears: peaks.length,
        q2: primary.quantiles.find((x) => x.returnPeriodYears === 2)?.discharge ?? null,
        q10: primary.quantiles.find((x) => x.returnPeriodYears === 10)?.discharge ?? null,
        q100: q100?.discharge ?? null,
        q500: q500?.discharge ?? null,
      },
      quantities: {
        q100: q(q100?.discharge ?? null, series.unit),
        q500: q(q500?.discharge ?? null, series.unit),
      },
      charts: [
        lineChart({
          kind: 'line',
          title: 'Flood-frequency curve',
          subtitle: `${peaks.length} annual peaks, ${dates[0].slice(0, 4)}–${dates[dates.length - 1].slice(0, 4)}`,
          xLabel: 'Return period (years)',
          yLabel: 'Peak discharge',
          unit: series.unit,
          series: [
            { key: 'lp3', label: 'Log-Pearson III', kind: 'simulated', color: CHART_COLORS.observed },
            { key: 'gev', label: 'GEV (L-moments)', kind: 'simulated', color: CHART_COLORS.simulated },
            { key: 'upper95', label: '95 % confidence (LP3)', kind: 'band', color: CHART_COLORS.band },
            { key: 'lower95', label: '95 % confidence (LP3)', kind: 'band', color: CHART_COLORS.band },
          ],
          data: lp3.quantiles.map((qq, i) => ({
            t: String(qq.returnPeriodYears),
            lp3: qq.discharge,
            gev: gev.quantiles[i]?.discharge ?? null,
            lower95: qq.lower95,
            upper95: qq.upper95,
          })),
          caption: 'Design discharge against return period from two distributions. The gap between them is a direct measure of distribution-choice uncertainty.',
        }),
      ],
      warnings: [...lp3.notes.filter((n) => n.includes('extrapolation') || n.includes('Record length')), REGULATORY_DISCLAIMER[1]],
      provenance: p.build(args),
    },
  );
}

/** estimate_return_period */
export async function estimateReturnPeriodTool(ctx: ToolContext, args: { discharge: number; stationId?: string }): Promise<ToolResult> {
  const p = new ProvenanceBuilder('estimate_return_period', { projectId: ctx.projectId, userId: ctx.userId });
  const { station, series } = await loadFlow(ctx, args.stationId);
  const peaks = annualPeaks(series.points.map((pt) => pt.t), series.points.map((pt) => pt.v));
  if (peaks.length < 10) return insufficient(p, 'At least 10 annual peaks are required to estimate a return period.', args);

  const empirical = estimateReturnPeriod(peaks.map((x) => x.peak), args.discharge);
  const lp3 = logPearson3(peaks, series.unit as 'm3/s');
  // Invert the fitted curve by interpolation in log space.
  const fitted = invertQuantiles(lp3.quantiles, args.discharge);

  p.source(demoSource(`Annual peaks — ${station?.name}`, ['discharge'], { discharge: series.unit }, null, peaks.length, station?.name ?? ''))
    .method({ name: 'Weibull plotting position', kind: 'statistic', implementation: '@hydro/hydrology-core estimateReturnPeriod', reference: null, parameters: {} })
    .method({ name: 'Log-Pearson III inversion', kind: 'statistic', implementation: 'log-space interpolation of the fitted quantile curve', reference: METHOD_REFERENCES.lp3, parameters: {} })
    .step('rank', 'Ranked the annual peak series and located the query discharge.', {})
    .assume('Empirical return periods cannot exceed n+1 years for an n-year record.')
    .limit(empirical.method)
    .uncertain({ sources: ['Short-record sampling uncertainty.'], qualitative: peaks.length < 25 ? 'high' : 'moderate' });

  return ok(
    `A discharge of ${fmt(args.discharge, series.unit)} corresponds to an empirical return period of ${empirical.returnPeriodYears?.toFixed(1) ?? 'n/a'} years ` +
      `(annual exceedance probability ${empirical.aep ? (empirical.aep * 100).toFixed(1) : 'n/a'} %), or ${fitted ? fitted.toFixed(1) : 'n/a'} years from the fitted log-Pearson III curve.`,
    {
      data: { empirical, fittedReturnPeriodYears: fitted, quantiles: lp3.quantiles, discharge: args.discharge },
      metrics: { empiricalReturnPeriod: empirical.returnPeriodYears, fittedReturnPeriod: fitted, aep: empirical.aep },
      quantities: { discharge: q(args.discharge, series.unit) },
      warnings: [empirical.method],
      provenance: p.build(args),
    },
  );
}

function invertQuantiles(quantiles: { returnPeriodYears: number; discharge: number }[], value: number): number | null {
  for (let i = 1; i < quantiles.length; i++) {
    const a = quantiles[i - 1];
    const b = quantiles[i];
    if (value >= a.discharge && value <= b.discharge) {
      const f = (Math.log(value) - Math.log(a.discharge)) / (Math.log(b.discharge) - Math.log(a.discharge));
      return Math.exp(Math.log(a.returnPeriodYears) + f * (Math.log(b.returnPeriodYears) - Math.log(a.returnPeriodYears)));
    }
  }
  return null;
}

/** analyze_flood_risk — current condition plus a short-range probabilistic outlook. */
export async function analyzeFloodRisk(ctx: ToolContext, args: { stationId?: string; horizonDays?: number } = {}): Promise<ToolResult> {
  const horizon = args.horizonDays ?? 7;
  const p = new ProvenanceBuilder('analyze_flood_risk', { projectId: ctx.projectId, userId: ctx.userId });
  const { station, series } = await loadFlow(ctx, args.stationId);
  const precip = await ctx.db.getSeries({ variable: 'precipitation' });
  const soil = await ctx.db.getSeries({ variable: 'soil_moisture' });

  const dates = series.points.map((pt) => pt.t);
  const values = series.points.map((pt) => pt.v);
  if (values.length < 365 * 3) return insufficient(p, 'At least three years of record are required for a flood-risk assessment.', args);

  const peaks = annualPeaks(dates, values);
  const bank = bankfullProxy(peaks);
  const lp3 = logPearson3(peaks, series.unit as 'm3/s');
  const q2 = lp3.quantiles.find((x) => x.returnPeriodYears === 2)?.discharge ?? null;
  const floodStage = bank.discharge ?? q2;
  const actionStage = floodStage ? floodStage * 0.75 : null;

  const precipByDate = new Map(precip.points.map((pt) => [pt.t, pt.v]));
  const fc = baselineForecast(
    { dates, values, precipitation: dates.map((d) => precipByDate.get(d) ?? null) },
    { model: 'arima', horizonDays: horizon, seed: 20260901, ensembleSize: 300 },
  );
  ctx.emit?.('Generated a 300-member streamflow ensemble', 'ok', `${horizon}-day horizon`);

  const pFlood = floodStage ? thresholdExceedanceProbability(fc.points, floodStage) : null;
  const pAction = actionStage ? thresholdExceedanceProbability(fc.points, actionStage) : null;
  const current = [...values].reverse().find((v) => v !== null) ?? null;
  const peak = fc.points.reduce((a, b) => (b.mean > a.mean ? b : a), fc.points[0]);
  const soilNow = [...soil.points].reverse().find((pt) => pt.v !== null)?.v ?? null;

  const hazard = (() => {
    if (!floodStage || current === null) return 'low' as const;
    const ratio = current / floodStage;
    const pf = pFlood?.overall ?? 0;
    if (ratio >= 1 || pf > 0.5) return 'extreme' as const;
    if (ratio >= 0.75 || pf > 0.2) return 'high' as const;
    if (ratio >= 0.5 || pf > 0.05) return 'moderate' as const;
    return 'low' as const;
  })();

  // Illustrative inundation footprint scaled by the forecast peak. This is a
  // geometric approximation for visualisation, NOT a hydraulic model result.
  const inundation = buildIllustrativeInundation(ctx, peak.mean, floodStage);

  p.source(demoSource(`Discharge, precipitation and soil moisture — ${station?.name}`, ['discharge', 'precipitation', 'soil_moisture'], { discharge: series.unit, precipitation: 'mm', soil_moisture: 'mm' }, { start: dates[0], end: dates[dates.length - 1] }, dates.length, station?.name ?? ''))
    .method({ name: 'Ensemble streamflow forecast (autoregressive baseline)', kind: 'ml_model', implementation: '@hydro/hydrology-core forecast', reference: null, parameters: { ensembleSize: 300, horizonDays: horizon } })
    .method({ name: 'Log-Pearson III flood frequency', kind: 'statistic', implementation: '@hydro/hydrology-core logPearson3', reference: METHOD_REFERENCES.lp3, parameters: {} })
    .method({ name: 'Bankfull proxy from the 1.5-year peak', kind: 'heuristic', implementation: '@hydro/hydrology-core bankfullProxy', reference: null, parameters: {} })
    .step('threshold', 'Derived flood and action thresholds from the annual peak record.', { floodStage, actionStage })
    .step('ensemble', 'Propagated forecast uncertainty through a 300-member ensemble.', {})
    .step('probability', 'Counted ensemble members exceeding each threshold on each forecast day.', {})
    .coverage(dates[0], fc.points[fc.points.length - 1].t)
    .extent(station?.name ?? null)
    .assume(
      'Flood and action thresholds are statistical proxies derived from the discharge record. They are not surveyed stages and not National Weather Service flood categories.',
      'The forecast assumes no additional rainfall, so exceedance probabilities are lower bounds during an approaching storm.',
    )
    .limit(
      ...REGULATORY_DISCLAIMER,
      'The inundation footprint shown is a geometric illustration scaled by discharge, not the output of a hydraulic model. A HEC-RAS 2D run is required for depth, velocity or extent that can be used for anything.',
    )
    .uncertain({
      sources: ['Forecast uncertainty (quantified by the ensemble).', 'Threshold definition uncertainty (not quantified).', 'No hydraulic routing.'],
      validationMetrics: { nse: fc.metrics.nse, kge: fc.metrics.kge },
      qualitative: 'high',
    });

  const assessment: FloodRiskAssessment = {
    watershedId: ctx.watershedId ?? '',
    asOf: dates[dates.length - 1],
    currentDischarge: q(current, series.unit),
    actionStage: q(actionStage, series.unit),
    floodStage: q(floodStage, series.unit),
    probabilityOfFloodStage7d: pFlood?.overall ?? null,
    peakForecast: q(peak.mean, series.unit),
    peakForecastTime: peak.t,
    hazardClass: hazard,
    inundationAreaKm2: inundation.areaKm2,
    populationAtRisk: null,
    disclaimers: REGULATORY_DISCLAIMER,
  };

  return ok(
    `Current discharge is ${fmt(current, series.unit)} against a flood threshold of ${fmt(floodStage, series.unit)}. ` +
      `Over the next ${horizon} days the ensemble gives a ${((pFlood?.overall ?? 0) * 100).toFixed(1)} % chance of exceeding that threshold, with a forecast peak of ${fmt(peak.mean, series.unit)} on ${peak.t}. Hazard classification: ${hazard}.`,
    {
      data: {
        assessment,
        thresholds: { floodStage, actionStage, basis: bank.basis },
        exceedanceByDay: pFlood?.byDay ?? [],
        actionExceedanceByDay: pAction?.byDay ?? [],
        forecast: fc.points,
        soilMoistureNow: soilNow,
        floodFrequency: lp3,
        hazardClassExample: classifyHazard(1.1, 1.2),
      },
      metrics: {
        currentDischarge: current,
        floodStage,
        actionStage,
        probabilityFlood: pFlood?.overall ?? null,
        probabilityAction: pAction?.overall ?? null,
        peakForecast: peak.mean,
        inundationAreaKm2: inundation.areaKm2,
      },
      quantities: {
        currentDischarge: q(current, series.unit),
        floodStage: q(floodStage, series.unit),
        peakForecast: q(peak.mean, series.unit),
      },
      charts: [
        lineChart({
          kind: 'forecast',
          title: 'Flood outlook',
          xLabel: 'Date',
          yLabel: 'Discharge',
          unit: series.unit,
          series: [
            { key: 'observed', label: 'Observed', kind: 'observed', color: CHART_COLORS.observed },
            { key: 'forecast', label: 'Ensemble median', kind: 'forecast', color: CHART_COLORS.forecast },
            { key: 'upper95', label: '95 % interval', kind: 'band', color: CHART_COLORS.band },
            { key: 'lower95', label: '95 % interval', kind: 'band', color: CHART_COLORS.band },
          ],
          data: [
            ...series.points.slice(-45).map((pt) => ({ t: pt.t, observed: pt.v, forecast: null, lower95: null, upper95: null })),
            ...fc.points.map((pt) => ({ t: pt.t, observed: null, forecast: pt.mean, lower95: pt.lower95 ?? null, upper95: pt.upper95 ?? null })),
          ],
          annotations: [
            ...(floodStage ? [{ kind: 'hline' as const, value: floodStage, label: 'Flood threshold (proxy)', color: '#c0392b' }] : []),
            ...(actionStage ? [{ kind: 'hline' as const, value: actionStage, label: 'Action threshold (proxy)', color: '#e0721c' }] : []),
          ],
          caption: 'Thresholds are statistical proxies from the discharge record, not surveyed stages or NWS flood categories.',
        }),
        lineChart({
          kind: 'bar',
          title: 'Daily probability of exceeding the flood threshold',
          xLabel: 'Forecast day',
          yLabel: 'Probability',
          unit: '%',
          series: [{ key: 'p', label: 'Exceedance probability', color: CHART_COLORS.threshold }],
          data: (pFlood?.byDay ?? []).map((d) => ({ t: d.t, p: d.p * 100 })),
          caption: 'Fraction of the 300-member ensemble exceeding the flood threshold on each forecast day.',
        }),
      ],
      maps: [inundation.map],
      warnings: REGULATORY_DISCLAIMER,
      provenance: p.build({ ...args, horizon }),
    },
  );
}

/**
 * Build an illustrative inundation footprint for visualisation.
 *
 * This is explicitly a cartographic placeholder: an ellipse around the outlet
 * whose extent scales with the ratio of forecast discharge to the flood
 * threshold. It exists so the map surface is exercised end-to-end. It is
 * labelled as illustrative everywhere it appears, and the HEC-RAS adapter is
 * what produces real depth, velocity and extent.
 */
function buildIllustrativeInundation(ctx: ToolContext, peakQ: number, floodStage: number | null) {
  const ratio = floodStage ? Math.max(peakQ / floodStage, 0.15) : 0.15;
  const scale = Math.min(0.055 * Math.sqrt(ratio), 0.16);
  const center: [number, number] = [-77.5433, 39.2735];
  const bands = [
    { depth: 2.5, factor: 0.45, hazard: 'extreme', color: '#08306b' },
    { depth: 1.2, factor: 0.7, hazard: 'high', color: '#2171b5' },
    { depth: 0.6, factor: 0.86, hazard: 'moderate', color: '#6baed6' },
    { depth: 0.25, factor: 1.0, hazard: 'low', color: '#c6dbef' },
  ];

  const ellipse = (f: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (2 * Math.PI * i) / 64;
      pts.push([
        Number((center[0] + scale * f * 2.6 * Math.cos(a)).toFixed(5)),
        Number((center[1] + scale * f * 0.55 * Math.sin(a) + 0.09 * scale * f * Math.sin(3 * a)).toFixed(5)),
      ]);
    }
    return pts;
  };

  const outer = scale * 2.6 * 111 * scale * 0.55 * 111 * Math.PI;

  return {
    areaKm2: Number((Math.PI * (scale * 2.6 * 87) * (scale * 0.55 * 111)).toFixed(1)) || Number(outer.toFixed(1)),
    map: mapSpec({
      title: 'Illustrative inundation extent',
      caption:
        'ILLUSTRATIVE ONLY — a geometric footprint scaled by forecast discharge, not a hydraulic model result. ' +
        'Depth bands are nominal. Run the HEC-RAS adapter for analysis-grade depth, velocity and extent.',
      center,
      zoom: 10,
      layers: [
        {
          id: 'inundation',
          label: 'Illustrative depth bands',
          kind: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: bands.map((b) => ({
              type: 'Feature',
              properties: { depthM: b.depth, hazard: b.hazard, color: b.color, illustrative: true },
              geometry: { type: 'Polygon', coordinates: [ellipse(b.factor)] },
            })),
          },
          legend: bands.map((b) => ({ label: `≥ ${b.depth} m (${b.hazard})`, color: b.color })),
        },
      ],
    }),
  };
}
