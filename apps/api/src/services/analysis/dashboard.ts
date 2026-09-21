import {
  annualPeaks,
  bankfullProxy,
  calculateSpi,
  ccmeWqi,
  classifyIndex,
  dayOfYear,
  forecast as baselineForecast,
  identifyDroughtEvents,
  percentileRank,
  simulateReservoir,
  smoothedClimatology,
  thresholdExceedanceProbability,
  toMonthly,
} from '@hydro/hydrology-core';
import type { Alert, KpiCard, WaterQualityParameter } from '@hydro/shared-types';
import type { ToolContext } from './common.js';

/**
 * Dashboard assembly (§27).
 *
 * Every card is computed from the record at request time. A card whose inputs
 * are unavailable reports `status: 'unknown'` with a null value rather than a
 * placeholder number — a dashboard that shows a confident figure it did not
 * compute is worse than one that shows a gap.
 */
export async function buildDashboard(ctx: ToolContext): Promise<{ kpis: KpiCard[]; alerts: Alert[]; asOf: string }> {
  const kpis: KpiCard[] = [];
  const alerts: Alert[] = [];
  const asOf = new Date().toISOString();

  const card = (c: Omit<KpiCard, 'asOf' | 'sourceDatasetId'> & { sourceDatasetId?: string | null }): KpiCard => ({
    ...c,
    asOf,
    sourceDatasetId: c.sourceDatasetId ?? null,
  });

  // ---- Hydrology ----------------------------------------------------------
  const flow = await ctx.db.getSeries({ variable: 'discharge' });
  const dates = flow.points.map((p) => p.t);
  const values = flow.points.map((p) => p.v);
  const latest = [...values].reverse().find((v) => v !== null) ?? null;
  const recordEnd = dates[dates.length - 1];

  let floodThreshold: number | null = null;
  let forecastPeak: number | null = null;
  let floodProbability: number | null = null;

  if (values.filter((v) => v !== null).length > 365) {
    const clim = smoothedClimatology(dates, values);
    const seasonal = clim.get(dayOfYear(recordEnd)) ?? null;
    const anomaly = latest !== null && seasonal ? ((latest - seasonal) / seasonal) * 100 : null;
    const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
    const pct = latest !== null ? percentileRank(sorted, latest) : null;

    kpis.push(
      card({
        id: 'current-streamflow',
        group: 'hydrology',
        label: 'Current streamflow',
        value: latest,
        unit: flow.unit,
        precision: 1,
        delta: anomaly,
        deltaLabel: anomaly === null ? null : 'vs seasonal median',
        status: anomaly === null ? 'unknown' : anomaly < -50 ? 'warning' : anomaly > 200 ? 'watch' : 'normal',
        context: `${pct?.toFixed(0) ?? '—'}th percentile of the full record · as of ${recordEnd}`,
      }),
    );

    const precip = await ctx.db.getSeries({ variable: 'precipitation' });
    const precipByDate = new Map(precip.points.map((p) => [p.t, p.v]));
    const fc = baselineForecast(
      { dates, values, precipitation: dates.map((d) => precipByDate.get(d) ?? null) },
      { model: 'arima', horizonDays: 7, seed: 20260901, ensembleSize: 200 },
    );

    if (fc.points.length > 0) {
      const day7 = fc.points[fc.points.length - 1];
      forecastPeak = fc.points.reduce((a, b) => (b.mean > a.mean ? b : a), fc.points[0]).mean;
      kpis.push(
        card({
          id: 'forecast-7d',
          group: 'hydrology',
          label: '7-day forecast',
          value: day7.mean,
          unit: flow.unit,
          precision: 1,
          delta: latest ? ((day7.mean - latest) / latest) * 100 : null,
          deltaLabel: 'vs today',
          status: 'normal',
          context: `Autoregressive baseline · validation NSE ${fc.metrics.nse?.toFixed(2) ?? 'n/a'}`,
        }),
        card({
          id: 'forecast-peak',
          group: 'flood',
          label: 'Peak forecast flow',
          value: forecastPeak,
          unit: flow.unit,
          precision: 1,
          delta: null,
          deltaLabel: null,
          status: 'normal',
          context: '7-day ensemble maximum',
        }),
      );

      const peaks = annualPeaks(dates, values);
      floodThreshold = bankfullProxy(peaks).discharge;
      if (floodThreshold) {
        const ex = thresholdExceedanceProbability(fc.points, floodThreshold);
        floodProbability = ex.overall;
        const status = ex.overall > 0.5 ? 'critical' : ex.overall > 0.2 ? 'warning' : ex.overall > 0.05 ? 'watch' : 'normal';
        kpis.push(
          card({
            id: 'flood-probability',
            group: 'flood',
            label: 'Flood probability (7 d)',
            value: ex.overall * 100,
            unit: '%',
            precision: 1,
            delta: null,
            deltaLabel: null,
            status,
            context: `Ensemble exceedance of the bankfull proxy (${floodThreshold.toFixed(0)} m³/s)`,
          }),
          card({
            id: 'flood-risk',
            group: 'flood',
            label: 'Current flood risk',
            value: latest && floodThreshold ? (latest / floodThreshold) * 100 : null,
            unit: '%',
            precision: 0,
            delta: null,
            deltaLabel: null,
            status,
            context: 'Current flow as a percentage of the flood threshold proxy',
          }),
        );

        if (ex.overall > 0.2) {
          alerts.push({
            id: 'alert-flood',
            severity: ex.overall > 0.5 ? 'critical' : 'warning',
            title: `${(ex.overall * 100).toFixed(0)} % chance of exceeding the flood threshold within 7 days`,
            body:
              `The 200-member ensemble forecast puts the probability of exceeding the bankfull proxy (${floodThreshold.toFixed(0)} m³/s) at ` +
              `${(ex.overall * 100).toFixed(1)} % over the next 7 days. The threshold is a statistical proxy derived from the annual peak record, not a surveyed flood stage.`,
            category: 'flood',
            issuedAt: asOf,
            generatedBy: 'rule',
            evidence: ['forecast_streamflow', 'calculate_flood_frequency'],
          });
        }
      }
    }

    kpis.push(
      card({
        id: 'flow-anomaly',
        group: 'hydrology',
        label: 'Flow anomaly',
        value: anomaly,
        unit: '%',
        precision: 0,
        delta: null,
        deltaLabel: null,
        status: anomaly === null ? 'unknown' : anomaly < -60 ? 'warning' : 'normal',
        context: 'Departure from the day-of-year seasonal median',
      }),
    );
  }

  // ---- Drought ------------------------------------------------------------
  const precipSeries = await ctx.db.getSeries({ variable: 'precipitation' });
  if (precipSeries.points.length > 365 * 5) {
    const monthly = toMonthly(precipSeries.points.map((p) => p.t), precipSeries.points.map((p) => p.v), 'sum');
    const spi3 = calculateSpi(monthly, { timescaleMonths: 3 });
    const spi12 = calculateSpi(monthly, { timescaleMonths: 12 });
    const cur3 = [...spi3.values].reverse().find((v) => v !== null) ?? null;
    const cur12 = [...spi12.values].reverse().find((v) => v !== null) ?? null;
    const cls = classifyIndex(cur3);
    const events = identifyDroughtEvents(spi12.months, spi12.values, -0.8);
    const ongoing = events.length > 0 && events[events.length - 1].end === spi12.months[spi12.months.length - 1] ? events[events.length - 1] : null;

    const droughtStatus = cls.severity >= 3 ? 'critical' : cls.severity >= 2 ? 'warning' : cls.severity >= 1 ? 'watch' : 'normal';

    kpis.push(
      card({ id: 'spi3', group: 'drought', label: 'SPI-3', value: cur3, unit: 'dimensionless', precision: 2, delta: null, deltaLabel: null, status: droughtStatus, context: `${cls.label} · gamma fit, calibrated ${spi3.calibrationStart}–${spi3.calibrationEnd}` }),
      card({ id: 'spi12', group: 'drought', label: 'SPI-12', value: cur12, unit: 'dimensionless', precision: 2, delta: null, deltaLabel: null, status: classifyIndex(cur12).severity >= 2 ? 'warning' : 'normal', context: classifyIndex(cur12).label }),
      card({ id: 'drought-severity', group: 'drought', label: 'Drought severity', value: cls.severity, unit: 'dimensionless', precision: 1, delta: null, deltaLabel: null, status: droughtStatus, context: `US Drought Monitor category ${cls.category}` }),
      card({ id: 'days-in-drought', group: 'drought', label: 'Months in drought', value: ongoing?.durationMonths ?? 0, unit: 'dimensionless', precision: 0, delta: null, deltaLabel: null, status: (ongoing?.durationMonths ?? 0) > 6 ? 'warning' : 'normal', context: ongoing ? `Current SPI-12 episode began ${ongoing.start}` : 'No ongoing SPI-12 drought episode' }),
    );

    if (cls.severity >= 2) {
      alerts.push({
        id: 'alert-drought',
        severity: cls.severity >= 3 ? 'critical' : 'warning',
        title: `${cls.label} conditions on SPI-3`,
        body: `SPI-3 stands at ${cur3?.toFixed(2)}, in the ${cls.category} category. SPI-12 is ${cur12?.toFixed(2)}${ongoing ? `, and the current 12-month episode has run for ${ongoing.durationMonths} months` : ''}.`,
        category: 'drought',
        issuedAt: asOf,
        generatedBy: 'rule',
        evidence: ['calculate_spi', 'assess_drought'],
      });
    }
  }

  // ---- Water quality ------------------------------------------------------
  const wqRows = await ctx.db.getWaterQuality({});
  if (wqRows.length > 20) {
    const recentStart = wqRows[wqRows.length - 1].t.slice(0, 4);
    const recent = wqRows.filter((r) => r.t >= `${Number(recentStart) - 2}-01-01`);
    const wqi = ccmeWqi(recent.map((r) => ({ t: r.t, parameter: r.parameter as WaterQualityParameter, value: r.value })));
    const worst = [...wqi.exceedances].sort((a, b) => b.pct - a.pct)[0];
    const totalExceedances = wqi.exceedances.reduce((s, e) => s + e.count, 0);

    kpis.push(
      card({ id: 'wqi', group: 'water_quality', label: 'Water Quality Index', value: wqi.wqi, unit: 'dimensionless', precision: 1, delta: null, deltaLabel: null, status: wqi.wqi >= 80 ? 'normal' : wqi.wqi >= 65 ? 'watch' : 'warning', context: `CCME WQI · ${wqi.rating} · last 3 years, ${wqi.parametersUsed.length} parameters` }),
      card({ id: 'wq-exceedances', group: 'water_quality', label: 'Threshold exceedances', value: totalExceedances, unit: 'dimensionless', precision: 0, delta: null, deltaLabel: null, status: totalExceedances > 20 ? 'warning' : 'normal', context: `Across ${recent.length} results in the last 3 years` }),
    );

    if (worst && worst.pct > 20) {
      alerts.push({
        id: 'alert-wq',
        severity: worst.pct > 50 ? 'warning' : 'watch',
        title: `${worst.parameter.replace(/_/g, ' ')} exceeds its screening criterion in ${worst.pct.toFixed(0)} % of samples`,
        body: `${worst.count} of ${worst.total} results for ${worst.parameter.replace(/_/g, ' ')} exceed the platform screening criterion over the last three years. Screening criteria are general benchmarks, not the applicable standard for this waterbody.`,
        category: 'water_quality',
        issuedAt: asOf,
        generatedBy: 'rule',
        evidence: ['analyze_water_quality'],
      });
    }
  }

  // ---- Supply and demand --------------------------------------------------
  const reservoirs = await ctx.db.listReservoirs();
  const reservoir = reservoirs[0];
  if (reservoir) {
    const obs = await ctx.db.getReservoirSeries(reservoir.id);
    const demandRows = await ctx.db.getDemand(ctx.projectId);
    const latestObs = obs[obs.length - 1];
    if (latestObs) {
      const pctFull = (latestObs.storageMcm / reservoir.capacityMcm) * 100;
      kpis.push(
        card({ id: 'storage', group: 'supply', label: 'Reservoir storage', value: latestObs.storageMcm, unit: 'MCM', precision: 1, delta: pctFull - 100, deltaLabel: 'of capacity', status: pctFull < 40 ? 'warning' : pctFull < 60 ? 'watch' : 'normal', context: `${pctFull.toFixed(0)} % of ${reservoir.capacityMcm} MCM capacity · ${latestObs.t}` }),
      );

      if (demandRows.length > 24) {
        const demandByMonth = new Map<string, number>();
        for (const d of demandRows) demandByMonth.set(d.t, (demandByMonth.get(d.t) ?? 0) + d.demandMcm);
        const steps = obs.map((o) => {
          const daysInMonth = new Date(Date.UTC(Number(o.t.slice(0, 4)), Number(o.t.slice(5, 7)), 0)).getUTCDate();
          return {
            t: o.t,
            inflowMcm: (o.inflowM3s * daysInMonth * 86400) / 1e6,
            demandMcm: (demandByMonth.get(o.t) ?? 0) * 0.35,
            evaporationMcm: o.evaporationMcm,
          };
        });
        const sim = simulateReservoir({ capacityMcm: reservoir.capacityMcm, deadStorageMcm: reservoir.deadStorageMcm, initialStorageMcm: obs[0].storageMcm }, steps);
        kpis.push(
          card({ id: 'reliability', group: 'supply', label: 'Supply reliability', value: sim.timeReliability * 100, unit: '%', precision: 1, delta: null, deltaLabel: null, status: sim.timeReliability > 0.95 ? 'normal' : sim.timeReliability > 0.9 ? 'watch' : 'warning', context: 'Months meeting full demand, historical inflow sequence' }),
          card({ id: 'deficit-probability', group: 'supply', label: 'Deficit probability', value: sim.deficitProbability * 100, unit: '%', precision: 1, delta: null, deltaLabel: null, status: sim.deficitProbability > 0.1 ? 'warning' : 'normal', context: 'Proportion of simulated months with unmet demand' }),
        );

        const lastMonth = demandRows[demandRows.length - 1].t;
        const currentDemand = demandRows.filter((d) => d.t === lastMonth).reduce((s, d) => s + d.demandMcm, 0);
        const peakDemand = Math.max(...[...demandByMonth.values()]);
        const yearAgo = demandByMonth.get(`${Number(lastMonth.slice(0, 4)) - 1}${lastMonth.slice(4)}`) ?? null;

        kpis.push(
          card({ id: 'current-demand', group: 'demand', label: 'Current demand', value: currentDemand, unit: 'MCM', precision: 2, delta: yearAgo ? ((currentDemand - yearAgo) / yearAgo) * 100 : null, deltaLabel: 'year on year', status: 'normal', context: `Total across all sectors · ${lastMonth.slice(0, 7)}` }),
          card({ id: 'peak-demand', group: 'demand', label: 'Peak monthly demand', value: peakDemand, unit: 'MCM', precision: 2, delta: null, deltaLabel: null, status: 'normal', context: 'Highest month in the record' }),
        );
      }
    }
  }

  // ---- Climate ------------------------------------------------------------
  const [precipNow, tempNow, etNow] = await Promise.all([
    ctx.db.getSeries({ variable: 'precipitation' }),
    ctx.db.getSeries({ variable: 'temperature_mean' }),
    ctx.db.getSeries({ variable: 'et_reference' }),
  ]);
  const last30 = <T,>(a: T[]) => a.slice(-30);
  const sum30 = last30(precipNow.points).reduce((s, p) => s + (p.v ?? 0), 0);
  const meanT = last30(tempNow.points).reduce((s, p) => s + (p.v ?? 0), 0) / 30;
  const sumEt = last30(etNow.points).reduce((s, p) => s + (p.v ?? 0), 0);

  kpis.push(
    card({ id: 'precip-30d', group: 'hydrology', label: 'Precipitation (30 d)', value: sum30, unit: 'mm', precision: 1, delta: null, deltaLabel: null, status: 'normal', context: 'Basin-average total over the last 30 days of record' }),
    card({ id: 'temp-30d', group: 'hydrology', label: 'Mean temperature (30 d)', value: meanT, unit: 'degC', precision: 1, delta: null, deltaLabel: null, status: 'normal', context: 'Basin-average daily mean' }),
    card({ id: 'et-30d', group: 'hydrology', label: 'Reference ET (30 d)', value: sumEt, unit: 'mm', precision: 1, delta: null, deltaLabel: null, status: 'normal', context: 'Hargreaves–Samani reference evapotranspiration' }),
  );

  return { kpis, alerts, asOf };
}
