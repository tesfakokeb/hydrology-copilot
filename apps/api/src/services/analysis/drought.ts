import {
  calculateSpei,
  calculateSpi,
  calculateSsi,
  classifyIndex,
  DROUGHT_CLASSES,
  identifyDroughtEvents,
  METHOD_REFERENCES,
  percentileRank,
  smoothedClimatology,
  dayOfYear,
  toMonthly,
} from '@hydro/hydrology-core';
import type { DroughtAssessment, ToolResult } from '@hydro/shared-types';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, insufficient, lineChart, ok, q, type ToolContext } from './common.js';

async function loadClimate(ctx: ToolContext, start?: string, end?: string) {
  const [precip, tmax, tmin, pet, flow] = await Promise.all([
    ctx.db.getSeries({ variable: 'precipitation', start, end }),
    ctx.db.getSeries({ variable: 'temperature_max', start, end }),
    ctx.db.getSeries({ variable: 'temperature_min', start, end }),
    ctx.db.getSeries({ variable: 'et_reference', start, end }),
    ctx.db.getSeries({ variable: 'discharge', start, end }),
  ]);
  return { precip, tmax, tmin, pet, flow };
}

/** calculate_spi / calculate_spei */
export async function calculateDroughtIndex(
  ctx: ToolContext,
  args: { index?: 'SPI' | 'SPEI' | 'SSI'; timescaleMonths?: number; startDate?: string; endDate?: string },
): Promise<ToolResult> {
  const index = args.index ?? 'SPI';
  const timescale = args.timescaleMonths ?? 3;
  const p = new ProvenanceBuilder(`calculate_${index.toLowerCase()}`, { projectId: ctx.projectId, userId: ctx.userId });

  const { precip, pet, flow } = await loadClimate(ctx, args.startDate, args.endDate);
  const dates = precip.points.map((pt) => pt.t);
  if (dates.length < 365 * 5) {
    return insufficient(p, `Only ${(dates.length / 365).toFixed(1)} years of precipitation are available. Standardised drought indices require at least 5 years, and WMO guidance recommends 30.`, args);
  }

  const monthlyP = toMonthly(dates, precip.points.map((pt) => pt.v), 'sum');
  ctx.emit?.('Aggregated precipitation to monthly totals', 'ok', `${monthlyP.months.length} months`);

  let result;
  let variableUsed: string[];
  if (index === 'SPEI') {
    const monthlyPet = toMonthly(pet.points.map((pt) => pt.t), pet.points.map((pt) => pt.v), 'sum');
    result = calculateSpei(monthlyP, monthlyPet, { timescaleMonths: timescale });
    variableUsed = ['precipitation', 'et_reference'];
    p.method({ name: `SPEI-${timescale}`, kind: 'index', implementation: '@hydro/hydrology-core calculateSpei', reference: METHOD_REFERENCES.spei, parameters: { timescaleMonths: timescale, distribution: 'log-logistic (L-moments)', perCalendarMonth: true } })
      .method({ name: 'Hargreaves–Samani reference ET', kind: 'statistic', implementation: '@hydro/hydrology-core hargreavesPet', reference: METHOD_REFERENCES.hargreaves, parameters: {} });
  } else if (index === 'SSI') {
    const monthlyQ = toMonthly(flow.points.map((pt) => pt.t), flow.points.map((pt) => pt.v), 'mean');
    result = calculateSsi(monthlyQ, timescale);
    variableUsed = ['discharge'];
    p.method({ name: `Standardized Streamflow Index (${timescale} month)`, kind: 'index', implementation: '@hydro/hydrology-core calculateSsi', reference: METHOD_REFERENCES.ssi, parameters: { timescaleMonths: timescale } });
  } else {
    result = calculateSpi(monthlyP, { timescaleMonths: timescale });
    variableUsed = ['precipitation'];
    p.method({ name: `SPI-${timescale}`, kind: 'index', implementation: '@hydro/hydrology-core calculateSpi', reference: METHOD_REFERENCES.spi, parameters: { timescaleMonths: timescale, distribution: 'gamma (Thom MLE), zero-inflated', perCalendarMonth: true } });
  }

  ctx.emit?.(`Fitted ${index}-${timescale} distribution per calendar month`, 'ok', result.distribution);

  const events = identifyDroughtEvents(result.months, result.values, -0.8);
  const lastValue = [...result.values].reverse().find((v) => v !== null) ?? null;
  const classification = classifyIndex(lastValue);

  p.source(demoSource('Basin-average precipitation and climate', variableUsed, { precipitation: 'mm', et_reference: 'mm', discharge: 'm3/s' }, { start: dates[0], end: dates[dates.length - 1] }, dates.length, 'Potomac Demonstration Watershed'))
    .step('aggregate', 'Aggregated daily values to monthly totals, discarding months with less than 80 % daily coverage.', { minCoveragePct: 80 })
    .step('accumulate', `Accumulated over a ${timescale}-month window.`, { timescaleMonths: timescale })
    .step('fit', 'Fitted the distribution separately for each calendar month over the calibration period.', { calibrationStart: result.calibrationStart, calibrationEnd: result.calibrationEnd })
    .step('transform', 'Transformed the non-exceedance probability to the standard normal variate, truncated at ±3.09.', {})
    .coverage(result.months[0], result.months[result.months.length - 1])
    .extent('Potomac Demonstration Watershed (basin average)')
    .assume(
      'The monthly series is stationary over the calibration period.',
      'Basin-average precipitation is representative of the whole catchment.',
      index === 'SPEI' ? 'Reference ET from Hargreaves–Samani is used as a proxy for atmospheric demand; it is not measured ET.' : 'SPI measures meteorological drought only; it says nothing directly about soil moisture or streamflow.',
    )
    .limit(...result.warnings)
    .uncertain({
      sources: [
        'Distribution-fitting uncertainty, which grows sharply when fewer than 30 years are available per calendar month.',
        'Index values near ±3 are extrapolations into the tail of the fitted distribution.',
      ],
      qualitative: result.warnings.length > 0 ? 'high' : 'moderate',
    });

  const chartData = result.months.map((m, i) => ({
    t: m,
    value: result.values[i],
    positive: result.values[i] !== null && (result.values[i] as number) > 0 ? result.values[i] : 0,
    negative: result.values[i] !== null && (result.values[i] as number) <= 0 ? result.values[i] : 0,
  }));

  return ok(
    `${index}-${timescale} for the most recent complete month is ${lastValue?.toFixed(2) ?? 'not computable'} (${classification.label}). ${events.length} drought episodes at or below −0.8 occurred over the record.`,
    {
      data: {
        index: result.index,
        timescaleMonths: timescale,
        distribution: result.distribution,
        calibration: { start: result.calibrationStart, end: result.calibrationEnd },
        months: result.months,
        values: result.values,
        categories: result.categories,
        events,
        current: { value: lastValue, classification },
      },
      metrics: { current: lastValue, eventCount: events.length, longestEventMonths: Math.max(0, ...events.map((e) => e.durationMonths)) },
      quantities: { currentIndex: q(lastValue, 'dimensionless') },
      charts: [
        lineChart({
          kind: 'area',
          title: `${index}-${timescale}`,
          subtitle: `${result.distribution}, calibrated ${result.calibrationStart} to ${result.calibrationEnd}`,
          xLabel: 'Month',
          yLabel: `${index}-${timescale}`,
          unit: 'dimensionless',
          series: [{ key: 'value', label: `${index}-${timescale}`, kind: 'observed', color: CHART_COLORS.observed }],
          data: chartData,
          annotations: [
            { kind: 'hline', value: -0.8, label: 'D1 moderate drought', color: '#fcd37f' },
            { kind: 'hline', value: -1.3, label: 'D2 severe drought', color: '#ffaa00' },
            { kind: 'hline', value: -1.6, label: 'D3 extreme drought', color: '#e60000' },
            { kind: 'hline', value: -2.0, label: 'D4 exceptional drought', color: '#730000' },
          ],
          caption: `Standardised index; negative values indicate drier-than-normal conditions relative to the ${result.calibrationStart}–${result.calibrationEnd} calibration period.`,
        }),
      ],
      warnings: result.warnings,
      provenance: p.build(args),
    },
  );
}

/** assess_drought — multi-index assessment with a narrative. */
export async function assessDrought(ctx: ToolContext, args: { startDate?: string; endDate?: string } = {}): Promise<ToolResult> {
  const p = new ProvenanceBuilder('assess_drought', { projectId: ctx.projectId, userId: ctx.userId });
  const { precip, pet, flow } = await loadClimate(ctx, args.startDate, args.endDate);
  const dates = precip.points.map((pt) => pt.t);
  if (dates.length < 365 * 5) {
    return insufficient(p, 'A drought assessment requires at least five years of record.', args);
  }

  const monthlyP = toMonthly(dates, precip.points.map((pt) => pt.v), 'sum');
  const monthlyPet = toMonthly(pet.points.map((pt) => pt.t), pet.points.map((pt) => pt.v), 'sum');
  const monthlyQ = toMonthly(flow.points.map((pt) => pt.t), flow.points.map((pt) => pt.v), 'mean');

  const scales = [1, 3, 6, 12];
  const spi = scales.map((s) => ({ scale: s, r: calculateSpi(monthlyP, { timescaleMonths: s }) }));
  const spei = calculateSpei(monthlyP, monthlyPet, { timescaleMonths: 6 });
  const ssi = calculateSsi(monthlyQ, 3);
  ctx.emit?.('Computed SPI-1/3/6/12, SPEI-6 and the streamflow drought index', 'ok', null);

  const last = <T,>(arr: (T | null)[]): T | null => [...arr].reverse().find((v) => v !== null) ?? null;

  const current = [
    ...spi.map((s) => ({ index: 'SPI' as const, timescaleMonths: s.scale, value: last(s.r.values) })),
    { index: 'SPEI' as const, timescaleMonths: 6, value: last(spei.values) },
    { index: 'SSI' as const, timescaleMonths: 3, value: last(ssi.values) },
  ]
    .filter((c) => c.value !== null)
    .map((c) => ({ ...c, value: c.value as number, classification: classifyIndex(c.value) }));

  const spi12 = spi.find((s) => s.scale === 12)!.r;
  const events = identifyDroughtEvents(spi12.months, spi12.values, -0.8);
  const ongoing = events.length > 0 && events[events.length - 1].end === spi12.months[spi12.months.length - 1] ? events[events.length - 1] : null;

  // Streamflow percentile relative to the seasonal climatology.
  const flowValues = flow.points.map((pt) => pt.v);
  const flowDates = flow.points.map((pt) => pt.t);
  const clim = smoothedClimatology(flowDates, flowValues);
  const latestFlow = last(flowValues);
  const doy = dayOfYear(flowDates[flowDates.length - 1] ?? '');
  const sameSeason = flowValues.filter((v, i): v is number => v !== null && Math.abs(dayOfYear(flowDates[i]) - doy) <= 7).sort((a, b) => a - b);
  const flowPercentile = latestFlow !== null && sameSeason.length > 30 ? percentileRank(sameSeason, latestFlow) : null;
  const seasonalMedian = clim.get(doy) ?? null;
  const flowDeparture = latestFlow !== null && seasonalMedian ? ((latestFlow - seasonalMedian) / seasonalMedian) * 100 : null;

  const worst = current.reduce((a, b) => (a.value < b.value ? a : b), current[0]);

  const narrative = buildNarrative(worst, flowDeparture, flowPercentile, ongoing);

  p.source(demoSource('Basin precipitation, reference ET and outlet discharge', ['precipitation', 'et_reference', 'discharge'], { precipitation: 'mm', et_reference: 'mm', discharge: 'm3/s' }, { start: dates[0], end: dates[dates.length - 1] }, dates.length, 'Potomac Demonstration Watershed'))
    .method({ name: 'SPI at 1, 3, 6 and 12 months', kind: 'index', implementation: '@hydro/hydrology-core calculateSpi', reference: METHOD_REFERENCES.spi, parameters: { timescales: scales } })
    .method({ name: 'SPEI-6', kind: 'index', implementation: '@hydro/hydrology-core calculateSpei', reference: METHOD_REFERENCES.spei, parameters: { timescaleMonths: 6 } })
    .method({ name: 'Standardized Streamflow Index (3 month)', kind: 'index', implementation: '@hydro/hydrology-core calculateSsi', reference: METHOD_REFERENCES.ssi, parameters: { timescaleMonths: 3 } })
    .method({ name: 'Streamflow percentile against a ±7-day seasonal window', kind: 'statistic', implementation: '@hydro/hydrology-core percentileRank', reference: null, parameters: { windowDays: 15 } })
    .step('index', 'Computed meteorological, agricultural-proxy and hydrological drought indices.', {})
    .step('classify', 'Applied US Drought Monitor category breakpoints to each index.', {})
    .step('compare', 'Compared the latest discharge with the same-season distribution from the full record.', {})
    .coverage(spi12.months[0], spi12.months[spi12.months.length - 1])
    .extent('Potomac Demonstration Watershed')
    .assume(
      'Drought categories follow US Drought Monitor breakpoints on the standardised index scale.',
      'A single basin-average series represents the whole catchment; spatial variability within the basin is not resolved.',
    )
    .limit(
      'This is an index-based assessment, not a US Drought Monitor determination. The operational USDM is a convergence-of-evidence product produced by human authors.',
    )
    .uncertain({
      sources: ['Different indices and timescales legitimately disagree; the assessment reports the spread rather than a single number.'],
      qualitative: 'moderate',
    });

  const assessment: DroughtAssessment = {
    stationId: null,
    watershedId: ctx.watershedId,
    asOf: spi12.months[spi12.months.length - 1],
    current,
    currentEventStart: ongoing?.start ?? null,
    currentEventDurationMonths: ongoing?.durationMonths ?? null,
    currentEventSeverity: ongoing?.severity ?? null,
    historicalEvents: events.slice(-12),
    streamflowPercentile: flowPercentile,
    narrative,
  };

  return ok(narrative, {
    data: {
      assessment,
      spiSeries: Object.fromEntries(spi.map((s) => [`SPI-${s.scale}`, { months: s.r.months, values: s.r.values }])),
      speiSeries: { months: spei.months, values: spei.values },
      ssiSeries: { months: ssi.months, values: ssi.values },
      classes: DROUGHT_CLASSES,
      flowDeparturePct: flowDeparture,
      seasonalMedianFlow: seasonalMedian,
    },
    metrics: {
      ...Object.fromEntries(current.map((c) => [`${c.index}-${c.timescaleMonths}`, c.value])),
      streamflowPercentile: flowPercentile,
      flowDeparturePct: flowDeparture,
      ongoingEventMonths: ongoing?.durationMonths ?? null,
    },
    quantities: { streamflowDeparture: q(flowDeparture, '%') },
    charts: [
      lineChart({
        title: 'Drought indices at multiple timescales',
        xLabel: 'Month',
        yLabel: 'Standardised index',
        unit: 'dimensionless',
        series: [
          { key: 'spi3', label: 'SPI-3', color: '#0f6fb8' },
          { key: 'spi12', label: 'SPI-12', color: '#12897b' },
          { key: 'spei6', label: 'SPEI-6', color: '#e0721c' },
          { key: 'ssi3', label: 'SSI-3 (streamflow)', color: '#7b3ff2' },
        ],
        data: alignMonthly(
          spi12.months.slice(-180),
          {
            spi3: mapByMonth(spi.find((s) => s.scale === 3)!.r),
            spi12: mapByMonth(spi12),
            spei6: mapByMonth(spei),
            ssi3: mapByMonth(ssi),
          },
        ),
        annotations: [
          { kind: 'hline', value: -0.8, label: 'D1', color: '#fcd37f' },
          { kind: 'hline', value: -1.3, label: 'D2', color: '#ffaa00' },
          { kind: 'hline', value: -1.6, label: 'D3', color: '#e60000' },
        ],
        caption: 'Short timescales respond to recent rainfall; long timescales track accumulated deficit. Disagreement between them is informative, not an error.',
      }),
    ],
    warnings: [...spi12.warnings, ...spei.warnings].slice(0, 4),
    provenance: p.build(args),
  });
}

function mapByMonth(r: { months: string[]; values: (number | null)[] }): Map<string, number | null> {
  return new Map(r.months.map((m, i) => [m, r.values[i]]));
}

function alignMonthly(months: string[], series: Record<string, Map<string, number | null>>) {
  return months.map((m) => {
    const row: Record<string, number | string | null> = { t: m };
    for (const [k, map] of Object.entries(series)) row[k] = map.get(m) ?? null;
    return row;
  });
}

function buildNarrative(
  worst: { index: string; timescaleMonths: number; value: number; classification: { label: string } },
  flowDeparture: number | null,
  flowPercentile: number | null,
  ongoing: { durationMonths: number; start: string } | null,
): string {
  const parts: string[] = [];
  if (worst.value > -0.5) {
    parts.push(`The watershed is not currently in drought by any computed index. The driest signal is ${worst.index}-${worst.timescaleMonths} at ${worst.value.toFixed(2)} (${worst.classification.label.toLowerCase()}).`);
  } else {
    parts.push(`The watershed shows ${worst.classification.label.toLowerCase()} conditions on ${worst.index}-${worst.timescaleMonths}, which stands at ${worst.value.toFixed(2)}.`);
  }
  if (flowDeparture !== null) {
    const dir = flowDeparture < 0 ? 'below' : 'above';
    parts.push(`Streamflow at the outlet is approximately ${Math.abs(flowDeparture).toFixed(0)} % ${dir} the long-term median for this time of year.`);
  }
  if (flowPercentile !== null) {
    parts.push(`That places current flow at the ${flowPercentile.toFixed(0)}th percentile of the same-season distribution.`);
  }
  if (ongoing) {
    parts.push(`The current SPI-12 drought episode began in ${ongoing.start} and has run for ${ongoing.durationMonths} months.`);
  }
  return parts.join(' ');
}
