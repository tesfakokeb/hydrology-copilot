import {
  ccmeWqi,
  DEFAULT_THRESHOLDS,
  detectQualityAnomalies,
  isExceedance,
  mannKendall,
  METHOD_REFERENCES,
  PARAMETER_LABELS,
  parameterCorrelations,
  seasonalMannKendall,
} from '@hydro/hydrology-core';
import type { ToolResult, WaterQualityParameter } from '@hydro/shared-types';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, insufficient, lineChart, mapSpec, ok, q, type ToolContext } from './common.js';

function yearsFrom(dates: string[]): number[] {
  const t0 = Date.parse(`${dates[0]}T00:00:00Z`);
  return dates.map((d) => (Date.parse(`${d}T00:00:00Z`) - t0) / (365.25 * 86400000));
}

/** analyze_water_quality + calculate_wqi */
export async function analyzeWaterQuality(
  ctx: ToolContext,
  args: { stationId?: string; parameters?: string[]; startDate?: string; endDate?: string },
): Promise<ToolResult> {
  const p = new ProvenanceBuilder('analyze_water_quality', { projectId: ctx.projectId, userId: ctx.userId });
  const rows = await ctx.db.getWaterQuality({
    stationId: args.stationId,
    parameters: args.parameters,
    start: args.startDate,
    end: args.endDate,
  });
  if (rows.length < 20) {
    return insufficient(p, `Only ${rows.length} water-quality observations are available; at least 20 are required for an index and trend assessment.`, args);
  }
  ctx.emit?.('Retrieved water-quality samples', 'ok', `${rows.length} results across ${new Set(rows.map((r) => r.parameter)).size} parameters`);

  const stations = await ctx.db.listStations({ type: 'water_quality' });
  const byStation = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byStation.has(r.stationCode)) byStation.set(r.stationCode, []);
    byStation.get(r.stationCode)!.push(r);
  }

  const wqiByStation = [...byStation.entries()].map(([code, rs]) => ({
    stationCode: code,
    stationName: stations.find((s) => s.code === code)?.name ?? code,
    result: ccmeWqi(rs.map((r) => ({ t: r.t, parameter: r.parameter as WaterQualityParameter, value: r.value }))),
  }));
  const overall = ccmeWqi(rows.map((r) => ({ t: r.t, parameter: r.parameter as WaterQualityParameter, value: r.value })));
  ctx.emit?.('Computed CCME Water Quality Index', 'ok', `WQI ${overall.wqi.toFixed(1)} (${overall.rating})`);

  // Trends per parameter (seasonal Mann–Kendall where the record supports it).
  const trends = [] as { parameter: string; label: string; unit: string; n: number; slopePerYear: number; pValue: number; direction: string; significant: boolean; method: string }[];
  for (const [parameter, rs] of groupBy(rows, (r) => r.parameter)) {
    const sorted = [...rs].sort((a, b) => a.t.localeCompare(b.t));
    if (sorted.length < 12) continue;
    const t = yearsFrom(sorted.map((r) => r.t));
    const v = sorted.map((r) => r.value);
    const months = sorted.map((r) => Number(r.t.slice(5, 7)));
    const res = sorted.length >= 48 ? seasonalMannKendall(months, t, v, 0.05, `${sorted[0].unit}/yr`) : mannKendall(t, v, 0.05, `${sorted[0].unit}/yr`);
    trends.push({
      parameter,
      label: PARAMETER_LABELS[parameter as WaterQualityParameter] ?? parameter,
      unit: sorted[0].unit,
      n: res.n,
      slopePerYear: res.slopePerYear,
      pValue: res.pValue,
      direction: res.direction,
      significant: res.significant,
      method: res.method,
    });
  }
  ctx.emit?.('Tested each parameter for monotonic trend', 'ok', `${trends.filter((t) => t.significant).length} of ${trends.length} significant at α = 0.05`);

  const anomalies = detectQualityAnomalies(rows.map((r) => ({ t: r.t, parameter: r.parameter as WaterQualityParameter, value: r.value })));
  const correlations = parameterCorrelations(rows.map((r) => ({ t: r.t, parameter: r.parameter as WaterQualityParameter, value: r.value }))).slice(0, 12);

  const criticalParameter = overall.exceedances.length > 0
    ? [...overall.exceedances].sort((a, b) => b.pct - a.pct)[0]
    : null;

  const coverage = { start: overall.period.start, end: overall.period.end };

  p.source(demoSource('Synthetic water-quality sampling network', [...new Set(rows.map((r) => r.parameter))], Object.fromEntries(rows.map((r) => [r.parameter, r.unit])), coverage, rows.length, 'Three synthetic monitoring stations'))
    .method({ name: 'CCME Water Quality Index 1.0', kind: 'index', implementation: '@hydro/hydrology-core ccmeWqi', reference: METHOD_REFERENCES.ccme, parameters: { thresholds: 'platform screening defaults' } })
    .method({ name: 'Seasonal Mann–Kendall with Theil–Sen slope', kind: 'statistic', implementation: '@hydro/hydrology-core seasonalMannKendall', reference: METHOD_REFERENCES.mannKendall, parameters: { alpha: 0.05 } })
    .method({ name: 'Modified z-score anomaly detection', kind: 'statistic', implementation: '@hydro/hydrology-core detectQualityAnomalies', reference: METHOD_REFERENCES.modifiedZ, parameters: { threshold: 3.5 } })
    .step('retrieve', 'Read water-quality results for the requested stations, parameters and period.', args as Record<string, unknown>)
    .step('screen', 'Compared every result with the applicable screening criterion.', { criteria: DEFAULT_THRESHOLDS.length })
    .step('index', 'Computed the CCME WQI from scope, frequency and amplitude of exceedance.', {})
    .step('trend', 'Applied a non-parametric trend test per parameter.', { alpha: 0.05 })
    .coverage(coverage.start, coverage.end)
    .extent('Three synthetic water-quality stations in the Potomac Demonstration Watershed')
    .assume(
      'Screening criteria are general aquatic-life and drinking-water benchmarks, not the applicable standard for any specific waterbody.',
      'Samples are treated as independent; serial correlation between closely spaced samples is not modelled.',
    )
    .limit(
      'The CCME index is sensitive to which parameters are included: adding a parameter that never fails raises the score.',
      'A statistically significant trend over a short record can be an artefact of a changing monitoring programme rather than a change in the water.',
    )
    .uncertain({
      sources: ['Laboratory and sampling variability (not represented in synthetic data).', 'Censored values below detection limits are not present in this record but would bias trends if they were.'],
      qualitative: 'moderate',
    });

  const paramForChart = args.parameters?.[0] ?? (criticalParameter?.parameter ?? 'nitrate');
  const chartRows = rows.filter((r) => r.parameter === paramForChart);
  const th = DEFAULT_THRESHOLDS.find((t) => t.parameter === paramForChart);

  return ok(
    `CCME Water Quality Index is ${overall.wqi.toFixed(1)} (${overall.rating}) over ${overall.period.start} to ${overall.period.end}, based on ${overall.parametersUsed.length} parameters and ${rows.length} results.` +
      (criticalParameter ? ` The most frequently exceeded criterion is ${PARAMETER_LABELS[criticalParameter.parameter] ?? criticalParameter.parameter} (${criticalParameter.pct.toFixed(0)} % of samples).` : ' No screening criterion was exceeded.'),
    {
      data: {
        wqi: overall,
        wqiByStation,
        trends: trends.sort((a, b) => a.pValue - b.pValue),
        anomalies: anomalies.slice(-30),
        correlations,
        thresholds: DEFAULT_THRESHOLDS,
        parameterLabels: PARAMETER_LABELS,
        series: Object.fromEntries(
          [...groupBy(rows, (r) => r.parameter)].map(([param, rs]) => [
            param,
            rs.map((r) => ({ t: r.t, v: r.value, station: r.stationCode, unit: r.unit, exceeds: th ? isExceedance(r.value, DEFAULT_THRESHOLDS.find((x) => x.parameter === param)!) : false })),
          ]),
        ),
      },
      metrics: {
        wqi: overall.wqi,
        f1Scope: overall.f1Scope ?? null,
        f2Frequency: overall.f2Frequency ?? null,
        f3Amplitude: overall.f3Amplitude ?? null,
        parameterCount: overall.parametersUsed.length,
        sampleCount: rows.length,
        significantTrends: trends.filter((t) => t.significant).length,
        anomalyCount: anomalies.length,
      },
      quantities: { wqi: q(overall.wqi, 'dimensionless') },
      charts: [
        lineChart({
          kind: 'scatter',
          title: `${PARAMETER_LABELS[paramForChart as WaterQualityParameter] ?? paramForChart} by station`,
          xLabel: 'Date',
          yLabel: PARAMETER_LABELS[paramForChart as WaterQualityParameter] ?? paramForChart,
          unit: (chartRows[0]?.unit ?? 'mg/L') as never,
          series: [...new Set(chartRows.map((r) => r.stationCode))].map((code, i) => ({
            key: code,
            label: stations.find((s) => s.code === code)?.name ?? code,
            color: [CHART_COLORS.observed, CHART_COLORS.simulated, CHART_COLORS.secondary][i % 3],
          })),
          data: [...groupBy(chartRows, (r) => r.t)].map(([t, rs]) => {
            const row: Record<string, string | number | null> = { t };
            for (const r of rs) row[r.stationCode] = r.value;
            return row;
          }),
          annotations: th?.max !== undefined ? [{ kind: 'hline', value: th.max, label: `Screening criterion (${th.source})`, color: CHART_COLORS.threshold }] : [],
          caption: `Individual sample results with the applicable screening criterion. Criterion source: ${th?.source ?? 'not defined'}.`,
        }),
        lineChart({
          kind: 'bar',
          title: 'Exceedance rate by parameter',
          xLabel: 'Parameter',
          yLabel: 'Samples exceeding the criterion',
          unit: '%',
          series: [{ key: 'pct', label: 'Exceedance rate', color: CHART_COLORS.threshold }],
          data: overall.exceedances
            .sort((a, b) => b.pct - a.pct)
            .map((e) => ({ t: PARAMETER_LABELS[e.parameter] ?? e.parameter, pct: e.pct })),
          caption: 'Percentage of samples exceeding the screening criterion for each parameter.',
        }),
      ],
      maps: [
        mapSpec({
          title: 'Water-quality stations',
          caption: 'Station-level CCME WQI. Marker colour is the index rating, not a regulatory attainment status.',
          center: [-77.55, 39.35],
          zoom: 8,
          layers: [
            {
              id: 'wq-stations',
              label: 'Water-quality stations',
              kind: 'points',
              data: {
                type: 'FeatureCollection',
                features: wqiByStation.map((w) => {
                  const st = stations.find((s) => s.code === w.stationCode);
                  return {
                    type: 'Feature',
                    properties: { name: w.stationName, wqi: Number(w.result.wqi.toFixed(1)), rating: w.result.rating },
                    geometry: { type: 'Point', coordinates: [st?.location.lon ?? 0, st?.location.lat ?? 0] },
                  };
                }),
              },
              legend: [
                { label: 'Excellent (95–100)', color: '#1a7f37' },
                { label: 'Good (80–94)', color: '#57a773' },
                { label: 'Fair (65–79)', color: '#e6a700' },
                { label: 'Marginal (45–64)', color: '#e06c00' },
                { label: 'Poor (0–44)', color: '#c0392b' },
              ],
            },
          ],
        }),
      ],
      warnings: anomalies.length > 0 ? [`${anomalies.length} results were flagged as statistical anomalies (|modified z| > 3.5) and should be checked before use.`] : [],
      provenance: p.build(args),
    },
  );
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return m;
}
