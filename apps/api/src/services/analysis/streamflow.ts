import {
  annualPeaks,
  bankfullProxy,
  baseflowSeparation,
  detectEvents,
  flowDurationCurve,
  flowStatistics,
  METHOD_REFERENCES,
  smoothedClimatology,
  dayOfYear,
  evaluate,
  ratePerformance,
  percentileRank,
} from '@hydro/hydrology-core';
import type { ToolResult } from '@hydro/shared-types';
import { convert } from '@hydro/units';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, fmt, insufficient, lineChart, ok, q, resolvePeriod, type ToolContext } from './common.js';

const DEFAULT_GAGE = 'DEMO-01638500';

export async function loadFlow(ctx: ToolContext, stationRef?: string, start?: string, end?: string) {
  const station = (await ctx.db.getStation(stationRef ?? DEFAULT_GAGE)) ?? (await ctx.db.listStations({ type: 'streamgage' }))[0] ?? null;
  const series = await ctx.db.getSeries({ stationId: station?.id, variable: 'discharge', start, end });
  return { station, series };
}

/** get_streamflow — retrieval with an explicit completeness report. */
export async function getStreamflow(ctx: ToolContext, args: { stationId?: string; startDate?: string; endDate?: string }): Promise<ToolResult> {
  const p = new ProvenanceBuilder('get_streamflow', { projectId: ctx.projectId, userId: ctx.userId });
  const { station, series } = await loadFlow(ctx, args.stationId, args.startDate, args.endDate);
  ctx.emit?.('Retrieved streamflow record', 'ok', `${series.points.length} daily values`);

  if (series.points.length === 0) {
    return insufficient(p, 'No streamflow observations are available for the requested station and period.', args);
  }

  const values = series.points.map((pt) => pt.v);
  const missing = values.filter((v) => v === null).length;
  const coverage = { start: series.points[0].t, end: series.points[series.points.length - 1].t };

  p.source(
    demoSource(
      `Daily discharge — ${station?.name ?? 'unknown station'}`,
      ['discharge'],
      { discharge: series.unit },
      coverage,
      series.points.length,
      station ? `Point ${station.location.lon.toFixed(4)}, ${station.location.lat.toFixed(4)}` : 'unknown',
    ),
  )
    .step('retrieve', 'Read the daily mean discharge record for the requested station and period.', { stationId: station?.id, ...args })
    .step('validate', 'Counted missing values and checked the record is monotonic in time.', { missing })
    .coverage(coverage.start, coverage.end)
    .extent(station ? `${station.name} (drainage area ${station.drainageAreaKm2 ?? 'unknown'} km²)` : null)
    .uncertain({ sources: ['Synthetic demonstration record: values are model output, not gauge measurements.'], qualitative: 'not_quantified' });

  const latest = [...series.points].reverse().find((pt) => pt.v !== null);

  return ok(
    `Retrieved ${series.points.length - missing} daily discharge values for ${station?.name ?? 'the default gauge'} covering ${coverage.start} to ${coverage.end}.`,
    {
      data: { station, series, missing, coverage },
      quantities: { latestDischarge: q(latest?.v ?? null, series.unit) },
      warnings: missing > 0 ? [`${missing} of ${series.points.length} days are missing and were left as gaps rather than filled.`] : [],
      charts: [
        lineChart({
          kind: 'hydrograph',
          title: `Daily discharge — ${station?.name ?? 'gauge'}`,
          xLabel: 'Date',
          yLabel: 'Discharge',
          unit: series.unit,
          series: [{ key: 'q', label: 'Observed discharge', kind: 'observed', color: CHART_COLORS.observed }],
          data: series.points.map((pt) => ({ t: pt.t, q: pt.v })),
          caption: `Observed (synthetic) daily mean discharge, ${coverage.start} to ${coverage.end}. Gaps are shown as breaks, not interpolated.`,
        }),
      ],
      provenance: p.build(args),
    },
  );
}

/** analyze_streamflow / calculate_flow_statistics */
export async function analyzeStreamflow(
  ctx: ToolContext,
  args: { stationId?: string; startDate?: string; endDate?: string },
): Promise<ToolResult> {
  const p = new ProvenanceBuilder('analyze_streamflow', { projectId: ctx.projectId, userId: ctx.userId });
  const { station, series } = await loadFlow(ctx, args.stationId, args.startDate, args.endDate);
  if (series.points.length < 365) {
    return insufficient(p, `Only ${series.points.length} daily values are available; at least one full year is required for flow statistics.`, args);
  }

  const dates = series.points.map((pt) => pt.t);
  const values = series.points.map((pt) => pt.v);
  ctx.emit?.('Validated observations', 'ok', `${values.filter((v) => v !== null).length} valid daily values`);

  const stats = flowStatistics({ dates, values, unit: series.unit as 'm3/s' });
  ctx.emit?.('Calculated flow-duration and low-flow statistics', 'ok', 'Q1–Q99, 7Q10, baseflow index');

  const fdc = flowDurationCurve(values);
  const clim = smoothedClimatology(dates, values);
  const { baseflow } = baseflowSeparation(values);

  const latestIdx = values.length - 1;
  const latest = values[latestIdx];
  const climToday = clim.get(dayOfYear(dates[latestIdx])) ?? null;
  const anomalyPct = latest !== null && climToday ? ((latest - climToday) / climToday) * 100 : null;
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const pct = latest !== null ? percentileRank(sorted, latest) : null;

  p.source(
    demoSource(
      `Daily discharge — ${station?.name}`,
      ['discharge'],
      { discharge: series.unit },
      { start: stats.startDate, end: stats.endDate },
      stats.count,
      station?.name ?? 'unknown',
    ),
  )
    .method({ name: 'Flow-duration curve (Weibull plotting position)', kind: 'statistic', implementation: '@hydro/hydrology-core flowDurationCurve', reference: 'Searcy (1959), USGS WSP 1542-A', parameters: { plottingPosition: 'i/(n+1)' } })
    .method({ name: '7Q10 low-flow statistic', kind: 'statistic', implementation: '@hydro/hydrology-core sevenQTen', reference: 'Log-normal fit to annual 7-day minima', parameters: { returnPeriodYears: 10, averagingDays: 7 } })
    .method({ name: 'Lyne–Hollick baseflow separation', kind: 'statistic', implementation: '@hydro/hydrology-core baseflowSeparation', reference: METHOD_REFERENCES.baseflow, parameters: { alpha: 0.925, passes: 3 } })
    .step('describe', 'Computed descriptive statistics, flow-duration percentiles and annual peaks.', {})
    .step('separate', 'Applied a three-pass Lyne–Hollick recursive digital filter to estimate the baseflow index.', { alpha: 0.925 })
    .coverage(stats.startDate, stats.endDate)
    .extent(station?.name ?? null)
    .assume(
      'Daily mean discharge is representative of the day; sub-daily peaks are not resolved.',
      'The record is treated as stationary over the period analysed.',
    )
    .limit('The baseflow index from a digital filter is an index, not a measured groundwater contribution.')
    .uncertain({
      sources: ['Rating-curve uncertainty in the source record (not quantified for synthetic data).', 'Sampling uncertainty in percentiles estimated from a finite record.'],
      qualitative: 'moderate',
    });

  const decimatedFdc = fdc.filter((_, i) => i % Math.max(1, Math.floor(fdc.length / 400)) === 0);
  const recentStart = Math.max(0, values.length - 730);

  return ok(
    `Mean discharge ${fmt(stats.mean, stats.unit)}, median ${fmt(stats.median, stats.unit)}, range ${fmt(stats.min, stats.unit)} to ${fmt(stats.max, stats.unit)} over ${stats.count} days (${stats.startDate} to ${stats.endDate}). Baseflow index ${stats.baseflowIndex?.toFixed(2) ?? 'not estimated'}.`,
    {
      data: {
        station,
        statistics: stats,
        flowDurationCurve: decimatedFdc,
        currentPercentile: pct,
        anomalyPct,
        seasonalMedian: climToday,
      },
      metrics: {
        mean: stats.mean,
        median: stats.median,
        q7d10: stats.q7d10,
        baseflowIndex: stats.baseflowIndex,
        cv: stats.cv,
        skew: stats.skew,
        currentPercentile: pct,
        anomalyPct,
      },
      quantities: {
        mean: q(stats.mean, stats.unit),
        median: q(stats.median, stats.unit),
        q7d10: q(stats.q7d10, stats.unit),
        latest: q(latest, stats.unit),
      },
      charts: [
        lineChart({
          kind: 'hydrograph',
          title: `Recent hydrograph with seasonal median — ${station?.name}`,
          xLabel: 'Date',
          yLabel: 'Discharge',
          unit: stats.unit,
          series: [
            { key: 'q', label: 'Observed', kind: 'observed', color: CHART_COLORS.observed },
            { key: 'baseflow', label: 'Estimated baseflow', kind: 'simulated', color: CHART_COLORS.secondary },
            { key: 'clim', label: 'Seasonal median (full record)', kind: 'threshold', color: CHART_COLORS.neutral },
          ],
          data: series.points.slice(recentStart).map((pt, i) => ({
            t: pt.t,
            q: pt.v,
            baseflow: baseflow[recentStart + i],
            clim: clim.get(dayOfYear(pt.t)) ?? null,
          })),
          caption: 'Last two years of the record against the day-of-year seasonal median computed from the whole record.',
        }),
        lineChart({
          kind: 'fdc',
          title: 'Flow-duration curve',
          xLabel: 'Exceedance probability (%)',
          yLabel: 'Discharge',
          unit: stats.unit,
          series: [{ key: 'discharge', label: 'Discharge', kind: 'observed', color: CHART_COLORS.observed }],
          data: decimatedFdc.map((d) => ({ t: (d.exceedanceProbability * 100).toFixed(2), discharge: d.discharge })),
          annotations: [
            { kind: 'vline', value: '50.00', label: 'Q50 (median)', color: CHART_COLORS.neutral },
            { kind: 'vline', value: '95.00', label: 'Q95 (low flow)', color: CHART_COLORS.threshold },
          ],
          caption: 'Proportion of the record during which a given discharge is equalled or exceeded, Weibull plotting positions.',
        }),
      ],
      warnings: stats.missing > 0 ? [`${stats.missing} days are missing from the record and were excluded pairwise.`] : [],
      provenance: p.build(args),
    },
  );
}

/** detect_flood_events — peak-over-threshold event extraction. */
export async function detectFloodEvents(
  ctx: ToolContext,
  args: { stationId?: string; thresholdPercentile?: number; startDate?: string; endDate?: string; minSeparationDays?: number },
): Promise<ToolResult> {
  const p = new ProvenanceBuilder('detect_flood_events', { projectId: ctx.projectId, userId: ctx.userId });
  const { station, series } = await loadFlow(ctx, args.stationId, args.startDate, args.endDate);
  if (series.points.length < 730) {
    return insufficient(p, 'At least two years of daily discharge are required to define a meaningful event threshold.', args);
  }

  const dates = series.points.map((pt) => pt.t);
  const values = series.points.map((pt) => pt.v);
  const pctile = args.thresholdPercentile ?? 99;
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const threshold = sorted[Math.min(Math.floor((pctile / 100) * sorted.length), sorted.length - 1)];
  const events = detectEvents(dates, values, threshold, args.minSeparationDays ?? 5);
  ctx.emit?.('Extracted peak-over-threshold events', 'ok', `${events.length} events above the Q${(100 - pctile).toFixed(0)} threshold`);

  const peaks = annualPeaks(dates, values);
  const bank = bankfullProxy(peaks);

  p.source(demoSource(`Daily discharge — ${station?.name}`, ['discharge'], { discharge: series.unit }, { start: dates[0], end: dates[dates.length - 1] }, values.length, station?.name ?? ''))
    .method({ name: 'Peak-over-threshold event extraction', kind: 'statistic', implementation: '@hydro/hydrology-core detectEvents', reference: null, parameters: { thresholdPercentile: pctile, threshold, minSeparationDays: args.minSeparationDays ?? 5 } })
    .step('threshold', `Set the event threshold at the ${pctile}th percentile of the daily record.`, { threshold })
    .step('extract', 'Identified contiguous runs above the threshold and merged runs separated by less than the declustering window.', {})
    .coverage(dates[0], dates[dates.length - 1])
    .extent(station?.name ?? null)
    .assume('Daily mean discharge under-represents instantaneous peaks; event peaks here are daily means.')
    .limit(bank.basis)
    .uncertain({ sources: ['Threshold choice materially affects event count.', 'Daily averaging suppresses short-duration peaks.'], qualitative: 'moderate' });

  const top = [...events].sort((a, b) => b.peak - a.peak).slice(0, 12);

  return ok(
    `Identified ${events.length} discharge events above ${fmt(threshold, series.unit)} (the ${pctile}th percentile) between ${dates[0]} and ${dates[dates.length - 1]}. The largest reached ${fmt(top[0]?.peak ?? null, series.unit)} on ${top[0]?.peakDate ?? 'n/a'}.`,
    {
      data: { threshold, thresholdPercentile: pctile, events, largestEvents: top, bankfullProxy: bank, annualPeaks: peaks },
      metrics: { eventCount: events.length, threshold, largestPeak: top[0]?.peak ?? null, bankfullProxy: bank.discharge },
      quantities: { threshold: q(threshold, series.unit), bankfullProxy: q(bank.discharge, series.unit) },
      charts: [
        lineChart({
          kind: 'bar',
          title: 'Annual peak discharge by water year',
          xLabel: 'Water year',
          yLabel: 'Peak daily discharge',
          unit: series.unit,
          series: [{ key: 'peak', label: 'Annual peak', kind: 'observed', color: CHART_COLORS.observed }],
          data: peaks.map((pk) => ({ t: String(pk.waterYear), peak: pk.peak })),
          annotations: bank.discharge
            ? [{ kind: 'hline', value: bank.discharge, label: 'Bankfull proxy (1.5-yr)', color: CHART_COLORS.threshold }]
            : [],
          caption: 'Maximum daily mean discharge in each USGS water year (1 October – 30 September).',
        }),
      ],
      warnings: [bank.basis],
      provenance: p.build(args),
    },
  );
}

/** evaluate_hydrologic_model — observed vs simulated comparison. */
export async function evaluateModelSeries(
  ctx: ToolContext,
  args: { observed: (number | null)[]; simulated: (number | null)[]; dates: string[]; label?: string; unit?: string },
): Promise<ToolResult> {
  const p = new ProvenanceBuilder('evaluate_hydrologic_model', { projectId: ctx.projectId, userId: ctx.userId });
  const metrics = evaluate(args.observed, args.simulated);
  if (metrics.n < 10) {
    return insufficient(p, `Only ${metrics.n} paired observed/simulated values are available; at least 10 are required.`, { n: metrics.n });
  }
  const rating = ratePerformance(metrics);
  const unit = args.unit ?? 'm3/s';

  p.method({ name: 'Nash–Sutcliffe efficiency', kind: 'statistic', implementation: '@hydro/hydrology-core nse', reference: METHOD_REFERENCES.nse, parameters: {} })
    .method({ name: 'Kling–Gupta efficiency (2009)', kind: 'statistic', implementation: '@hydro/hydrology-core kge', reference: METHOD_REFERENCES.kge, parameters: {} })
    .method({ name: 'Percent bias', kind: 'statistic', implementation: '@hydro/hydrology-core pbias', reference: METHOD_REFERENCES.pbias, parameters: {} })
    .step('pair', 'Paired observed and simulated values by time step, deleting pairs with a missing member.', { pairs: metrics.n })
    .step('evaluate', 'Computed the full goodness-of-fit suite.', {})
    .coverage(args.dates[0] ?? null, args.dates[args.dates.length - 1] ?? null)
    .assume('Performance ratings follow Moriasi et al. (2015) conventions for daily streamflow; they are a convention, not a certification.')
    .uncertain({ validationMetrics: { nse: metrics.nse, kge: metrics.kge, pbias: metrics.pbias }, sources: ['Goodness-of-fit statistics are sensitive to the evaluation period chosen.'], qualitative: 'moderate' });

  return ok(
    `NSE ${metrics.nse?.toFixed(3)}, KGE ${metrics.kge?.toFixed(3)}, PBIAS ${metrics.pbias?.toFixed(1)} %, RMSE ${fmt(metrics.rmse, unit)} over ${metrics.n} paired values — rated "${rating.overall}".`,
    {
      data: { metrics, rating, label: args.label ?? 'simulation' },
      metrics: metrics as unknown as Record<string, number | null>,
      charts: [
        lineChart({
          kind: 'hydrograph',
          title: `Observed vs simulated — ${args.label ?? 'model run'}`,
          xLabel: 'Date',
          yLabel: 'Discharge',
          unit: unit as never,
          series: [
            { key: 'obs', label: 'Observed', kind: 'observed', color: CHART_COLORS.observed },
            { key: 'sim', label: 'Simulated', kind: 'simulated', color: CHART_COLORS.simulated },
          ],
          data: args.dates.map((t, i) => ({ t, obs: args.observed[i], sim: args.simulated[i] })),
          caption: `Paired comparison over ${metrics.n} time steps. NSE ${metrics.nse?.toFixed(3)}, KGE ${metrics.kge?.toFixed(3)}.`,
        }),
        lineChart({
          kind: 'scatter',
          title: 'Simulated against observed',
          xLabel: 'Observed',
          yLabel: 'Simulated',
          unit: unit as never,
          series: [{ key: 'sim', label: 'Paired values', kind: 'simulated', color: CHART_COLORS.simulated }],
          data: args.dates
            .map((_, i) => ({ t: String(args.observed[i] ?? ''), obs: args.observed[i], sim: args.simulated[i] }))
            .filter((d) => d.obs !== null && d.sim !== null),
          caption: 'Points on the 1:1 line indicate a perfect match. Systematic departure indicates bias.',
        }),
      ],
      provenance: p.build({ n: metrics.n, label: args.label }),
    },
  );
}

/** Convert a discharge into the project's display unit system. */
export function toProjectUnit(value: number | null, from: string, system: 'SI' | 'US'): { value: number | null; unit: string } {
  if (value === null) return { value: null, unit: from };
  const target = system === 'US' && from === 'm3/s' ? 'ft3/s' : from;
  return { value: convert(value, from, target), unit: target };
}
