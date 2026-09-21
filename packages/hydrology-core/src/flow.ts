import type { DischargeUnit, FlowStatistics, TimeSeriesPoint } from '@hydro/shared-types';
import { clean, mean, median, quantile, skewness, stdDev } from './stats.js';

export interface FlowSeries {
  dates: string[];
  values: (number | null)[];
  unit: DischargeUnit;
}

export function fromPoints(points: TimeSeriesPoint[], unit: DischargeUnit): FlowSeries {
  return { dates: points.map((p) => p.t), values: points.map((p) => p.v), unit };
}

/** US Geological Survey water year: Oct 1 (year-1) through Sep 30 (year). */
export function waterYear(dateIso: string): number {
  const d = new Date(dateIso + (dateIso.length === 10 ? 'T00:00:00Z' : ''));
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 9 ? y + 1 : y;
}

/**
 * Flow-duration curve using the Weibull plotting position
 * p = i / (n + 1), the convention in USGS practice.
 */
export function flowDurationCurve(values: (number | null)[]): { exceedanceProbability: number; discharge: number }[] {
  const v = clean(values).sort((a, b) => b - a);
  const n = v.length;
  return v.map((q, i) => ({ exceedanceProbability: (i + 1) / (n + 1), discharge: q }));
}

/** Discharge exceeded p% of the time (Q10, Q50, Q95 …). */
export function flowExceededPercent(values: (number | null)[], pct: number): number {
  const v = clean(values).sort((a, b) => a - b);
  // Q_pct is exceeded pct% of the time -> it is the (100-pct) percentile.
  return quantile(v, 1 - pct / 100);
}

/**
 * 7Q10 — the annual minimum 7-day mean flow with a 10-year recurrence
 * interval, estimated by fitting a log-normal distribution to annual 7-day
 * minima (the common regulatory low-flow statistic).
 */
export function sevenQTen(dates: string[], values: (number | null)[]): number | null {
  const roll7: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 6; i < values.length; i++) {
    const w = values.slice(i - 6, i + 1);
    if (w.some((x) => x === null || !Number.isFinite(x))) continue;
    roll7[i] = (w as number[]).reduce((a, b) => a + b, 0) / 7;
  }
  const byYear = new Map<number, number>();
  for (let i = 0; i < dates.length; i++) {
    const r = roll7[i];
    if (r === null) continue;
    const wy = waterYear(dates[i]);
    const cur = byYear.get(wy);
    if (cur === undefined || r < cur) byYear.set(wy, r);
  }
  const minima = [...byYear.values()].filter((v) => v > 0);
  if (minima.length < 10) return null;
  const logs = minima.map((v) => Math.log(v));
  const mu = mean(logs);
  const sigma = stdDev(logs);
  // 10-year non-exceedance for a low-flow statistic: p = 0.10 -> z = -1.2816
  const z = -1.2815515655446004;
  return Math.exp(mu + z * sigma);
}

/**
 * Lyne–Hollick recursive digital filter for baseflow separation, applied
 * forward-backward-forward with alpha = 0.925 (Nathan & McMahon 1990).
 * Returns the baseflow index BFI = baseflow volume / total volume.
 */
export function baseflowSeparation(values: (number | null)[], alpha = 0.925): { baseflow: (number | null)[]; bfi: number | null } {
  const q = values.map((v) => (v === null || !Number.isFinite(v) ? null : v));
  const idx = q.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (idx.length < 30) return { baseflow: q.map(() => null), bfi: null };

  const series = idx.map((i) => q[i] as number);
  let bf = [...series];

  const pass = (input: number[], reverse: boolean): number[] => {
    const arr = reverse ? [...input].reverse() : input;
    const qf: number[] = new Array(arr.length).fill(0);
    const out: number[] = new Array(arr.length).fill(0);
    out[0] = arr[0];
    for (let i = 1; i < arr.length; i++) {
      qf[i] = alpha * qf[i - 1] + ((1 + alpha) / 2) * (arr[i] - arr[i - 1]);
      out[i] = qf[i] > 0 ? arr[i] - qf[i] : arr[i];
      if (out[i] > arr[i]) out[i] = arr[i];
      if (out[i] < 0) out[i] = 0;
    }
    return reverse ? out.reverse() : out;
  };

  bf = pass(bf, false);
  bf = pass(bf, true);
  bf = pass(bf, false);
  // Baseflow can never exceed total flow.
  bf = bf.map((v, i) => Math.min(v, series[i]));

  const total = series.reduce((a, b) => a + b, 0);
  const base = bf.reduce((a, b) => a + b, 0);
  const out: (number | null)[] = new Array(values.length).fill(null);
  idx.forEach((origIndex, k) => {
    out[origIndex] = bf[k];
  });
  return { baseflow: out, bfi: total > 0 ? base / total : null };
}

/** Annual instantaneous maxima by water year — input to flood-frequency analysis. */
export function annualPeaks(dates: string[], values: (number | null)[]): { waterYear: number; peak: number; date: string }[] {
  const map = new Map<number, { peak: number; date: string }>();
  for (let i = 0; i < dates.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    const wy = waterYear(dates[i]);
    const cur = map.get(wy);
    if (!cur || v > cur.peak) map.set(wy, { peak: v, date: dates[i] });
  }
  return [...map.entries()]
    .map(([waterYear, r]) => ({ waterYear, ...r }))
    .sort((a, b) => a.waterYear - b.waterYear);
}

/** Complete descriptive statistics for a discharge record. */
export function flowStatistics(series: FlowSeries): FlowStatistics {
  const v = clean(series.values);
  const sorted = [...v].sort((a, b) => a - b);
  const fdcPercentiles = [1, 5, 10, 25, 50, 75, 90, 95, 99];
  const flowDuration: Record<string, number> = {};
  for (const p of fdcPercentiles) flowDuration[`Q${p}`] = flowExceededPercent(series.values, p);

  const { bfi } = baseflowSeparation(series.values);

  return {
    count: v.length,
    missing: series.values.length - v.length,
    startDate: series.dates[0] ?? '',
    endDate: series.dates[series.dates.length - 1] ?? '',
    unit: series.unit,
    mean: mean(v),
    median: median(v),
    min: sorted[0] ?? NaN,
    max: sorted[sorted.length - 1] ?? NaN,
    stdDev: stdDev(v),
    skew: skewness(v),
    cv: mean(v) === 0 ? NaN : stdDev(v) / mean(v),
    flowDuration,
    q7d10: sevenQTen(series.dates, series.values),
    baseflowIndex: bfi,
    annualPeaks: annualPeaks(series.dates, series.values),
  };
}

/** Day-of-year climatology, used for anomalies and the climatology forecast. */
export function dayOfYearClimatology(dates: string[], values: (number | null)[]): Map<number, { mean: number; p10: number; p50: number; p90: number; n: number }> {
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < dates.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    const doy = dayOfYear(dates[i]);
    if (!buckets.has(doy)) buckets.set(doy, []);
    buckets.get(doy)!.push(v);
  }
  const out = new Map<number, { mean: number; p10: number; p50: number; p90: number; n: number }>();
  for (const [doy, arr] of buckets) {
    const s = [...arr].sort((a, b) => a - b);
    out.set(doy, { mean: mean(arr), p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9), n: arr.length });
  }
  return out;
}

export function dayOfYear(dateIso: string): number {
  const d = new Date(dateIso + (dateIso.length === 10 ? 'T00:00:00Z' : ''));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

/** Smoothed (±window days) climatology so day-to-day sampling noise does not leak into anomalies. */
export function smoothedClimatology(dates: string[], values: (number | null)[], window = 5): Map<number, number> {
  const raw = dayOfYearClimatology(dates, values);
  const out = new Map<number, number>();
  for (let doy = 1; doy <= 366; doy++) {
    let sum = 0;
    let n = 0;
    for (let d = doy - window; d <= doy + window; d++) {
      const key = ((d - 1 + 366) % 366) + 1;
      const b = raw.get(key);
      if (b) {
        sum += b.mean * b.n;
        n += b.n;
      }
    }
    if (n > 0) out.set(doy, sum / n);
  }
  return out;
}

/** Flow anomaly relative to the smoothed seasonal climatology, in percent. */
export function flowAnomalyPct(dates: string[], values: (number | null)[], atIndex: number): number | null {
  const clim = smoothedClimatology(dates, values);
  const v = values[atIndex];
  if (v === null || v === undefined) return null;
  const c = clim.get(dayOfYear(dates[atIndex]));
  if (!c || c === 0) return null;
  return ((v - c) / c) * 100;
}

/**
 * Peak-over-threshold event detection. Events are contiguous runs above the
 * threshold, merged when separated by fewer than `minSeparationDays`.
 */
export interface FlowEvent {
  start: string;
  end: string;
  durationDays: number;
  peak: number;
  peakDate: string;
  volume: number;
  meanFlow: number;
}

export function detectEvents(
  dates: string[],
  values: (number | null)[],
  threshold: number,
  minSeparationDays = 3,
): FlowEvent[] {
  const raw: { s: number; e: number }[] = [];
  let start = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const above = v !== null && Number.isFinite(v) && v >= threshold;
    if (above && start < 0) start = i;
    if (!above && start >= 0) {
      raw.push({ s: start, e: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) raw.push({ s: start, e: values.length - 1 });

  const merged: { s: number; e: number }[] = [];
  for (const ev of raw) {
    const last = merged[merged.length - 1];
    if (last && ev.s - last.e <= minSeparationDays) last.e = ev.e;
    else merged.push({ ...ev });
  }

  return merged.map(({ s, e }) => {
    let peak = -Infinity;
    let peakDate = dates[s];
    let volume = 0;
    let n = 0;
    for (let i = s; i <= e; i++) {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) continue;
      if (v > peak) {
        peak = v;
        peakDate = dates[i];
      }
      volume += v * 86400; // daily volume in m3 when unit is m3/s
      n++;
    }
    return {
      start: dates[s],
      end: dates[e],
      durationDays: e - s + 1,
      peak,
      peakDate,
      volume,
      meanFlow: n > 0 ? volume / 86400 / n : NaN,
    };
  });
}

/**
 * Bankfull discharge proxy. In the absence of surveyed cross-section
 * geometry, the platform uses the widely-used regional approximation that
 * bankfull corresponds to roughly the 1.5-year recurrence-interval flood.
 * This is explicitly reported as an approximation, never as a survey.
 */
export function bankfullProxy(peaks: { peak: number }[]): { discharge: number | null; basis: string } {
  if (peaks.length < 10) {
    return { discharge: null, basis: 'Insufficient annual peak record (<10 water years) to estimate a bankfull proxy.' };
  }
  const sorted = peaks.map((p) => p.peak).sort((a, b) => b - a);
  const n = sorted.length;
  // Weibull plotting position, return period T = (n+1)/rank -> rank = (n+1)/T
  const targetRank = (n + 1) / 1.5;
  const lo = Math.floor(targetRank) - 1;
  const hi = Math.min(Math.ceil(targetRank) - 1, n - 1);
  const frac = targetRank - Math.floor(targetRank);
  const q = sorted[Math.max(lo, 0)] + frac * ((sorted[hi] ?? sorted[Math.max(lo, 0)]) - sorted[Math.max(lo, 0)]);
  return {
    discharge: q,
    basis: 'Approximated as the 1.5-year recurrence-interval annual peak (Weibull plotting position). Not a surveyed bankfull stage.',
  };
}
