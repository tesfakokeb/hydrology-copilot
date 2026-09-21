import type { DroughtCategory, DroughtClassification, DroughtEvent } from '@hydro/shared-types';
import { fitGamma, fitLogLogistic, gammaCdf, logLogisticCdf, normalInv, rollingSum } from './stats.js';

/**
 * US Drought Monitor category breakpoints, expressed on the standardised
 * index scale used by SPI/SPEI (Svoboda et al. 2002; McKee et al. 1993).
 */
export const DROUGHT_CLASSES: DroughtClassification[] = [
  { category: 'D4', label: 'Exceptional drought', severity: 4, colorHex: '#730000' },
  { category: 'D3', label: 'Extreme drought', severity: 3, colorHex: '#e60000' },
  { category: 'D2', label: 'Severe drought', severity: 2, colorHex: '#ffaa00' },
  { category: 'D1', label: 'Moderate drought', severity: 1, colorHex: '#fcd37f' },
  { category: 'D0', label: 'Abnormally dry', severity: 0.5, colorHex: '#ffff00' },
  { category: 'Normal', label: 'Near normal', severity: 0, colorHex: '#e8ecef' },
  { category: 'W0', label: 'Abnormally wet', severity: -0.5, colorHex: '#d7f0ff' },
  { category: 'W1', label: 'Moderately wet', severity: -1, colorHex: '#9ed7f5' },
  { category: 'W2', label: 'Very wet', severity: -2, colorHex: '#5aabe0' },
  { category: 'W3', label: 'Extremely wet', severity: -3, colorHex: '#1f78b4' },
  { category: 'W4', label: 'Exceptionally wet', severity: -4, colorHex: '#0b3d6b' },
];

export function classifyIndex(value: number | null): DroughtClassification {
  if (value === null || !Number.isFinite(value)) {
    return { category: 'Normal', label: 'Insufficient data', severity: 0, colorHex: '#cbd5e1' };
  }
  if (value <= -2.0) return DROUGHT_CLASSES[0];
  if (value <= -1.6) return DROUGHT_CLASSES[1];
  if (value <= -1.3) return DROUGHT_CLASSES[2];
  if (value <= -0.8) return DROUGHT_CLASSES[3];
  if (value <= -0.5) return DROUGHT_CLASSES[4];
  if (value < 0.5) return DROUGHT_CLASSES[5];
  if (value < 0.8) return DROUGHT_CLASSES[6];
  if (value < 1.3) return DROUGHT_CLASSES[7];
  if (value < 1.6) return DROUGHT_CLASSES[8];
  if (value < 2.0) return DROUGHT_CLASSES[9];
  return DROUGHT_CLASSES[10];
}

export interface MonthlySeries {
  /** ISO month labels, YYYY-MM, strictly increasing and complete. */
  months: string[];
  values: (number | null)[];
}

/** Aggregate a daily series to monthly totals (precipitation) or means. */
export function toMonthly(
  dates: string[],
  values: (number | null)[],
  aggregation: 'sum' | 'mean',
  minCoveragePct = 80,
): MonthlySeries {
  const buckets = new Map<string, { sum: number; n: number; expected: number }>();
  for (let i = 0; i < dates.length; i++) {
    const key = dates[i].slice(0, 7);
    if (!buckets.has(key)) {
      const [y, m] = key.split('-').map(Number);
      buckets.set(key, { sum: 0, n: 0, expected: new Date(Date.UTC(y, m, 0)).getUTCDate() });
    }
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    const b = buckets.get(key)!;
    b.sum += v;
    b.n += 1;
  }
  const months = [...buckets.keys()].sort();
  const out: (number | null)[] = months.map((m) => {
    const b = buckets.get(m)!;
    if ((b.n / b.expected) * 100 < minCoveragePct) return null;
    return aggregation === 'sum' ? b.sum : b.sum / b.n;
  });
  return { months, values: out };
}

export interface SpiOptions {
  timescaleMonths: number;
  /** Fit distribution per calendar month (the operational standard). */
  perCalendarMonth?: boolean;
  calibrationStart?: string;
  calibrationEnd?: string;
}

export interface SpiResult {
  index: 'SPI';
  timescaleMonths: number;
  distribution: 'gamma (Thom MLE), zero-inflated';
  calibrationStart: string;
  calibrationEnd: string;
  months: string[];
  values: (number | null)[];
  categories: DroughtCategory[];
  warnings: string[];
}

/**
 * Standardized Precipitation Index (McKee et al. 1993; WMO-No. 1090).
 *
 * Accumulated precipitation over the chosen timescale is fitted to a
 * two-parameter gamma distribution — separately for each calendar month — and
 * the resulting non-exceedance probability is transformed to the standard
 * normal variate. Zero-precipitation months are handled with the mixed
 * distribution H(x) = q + (1 - q) G(x).
 */
export function calculateSpi(series: MonthlySeries, opts: SpiOptions): SpiResult {
  const { timescaleMonths, perCalendarMonth = true } = opts;
  const warnings: string[] = [];
  const acc = rollingSum(series.values, timescaleMonths);

  const calStart = opts.calibrationStart ?? series.months[0];
  const calEnd = opts.calibrationEnd ?? series.months[series.months.length - 1];
  const inCal = (m: string) => m >= calStart && m <= calEnd;

  const values: (number | null)[] = new Array(series.months.length).fill(null);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < series.months.length; i++) {
    const a = acc[i];
    if (a === null || !inCal(series.months[i])) continue;
    const key = perCalendarMonth ? Number(series.months[i].slice(5, 7)) : 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  const fits = new Map<number, { shape: number; scale: number; zeroProbability: number }>();
  for (const [key, arr] of groups) {
    if (arr.length < 20) {
      warnings.push(
        `Calendar month ${key || 'all'} has only ${arr.length} calibration values for SPI-${timescaleMonths}; ` +
          'WMO guidance recommends at least 30 years. Index values are provisional.',
      );
    }
    if (arr.length < 5) continue;
    fits.set(key, fitGamma(arr));
  }

  for (let i = 0; i < series.months.length; i++) {
    const a = acc[i];
    if (a === null) continue;
    const key = perCalendarMonth ? Number(series.months[i].slice(5, 7)) : 0;
    const fit = fits.get(key);
    if (!fit || !Number.isFinite(fit.shape)) continue;
    const q = fit.zeroProbability;
    const g = a > 0 ? gammaCdf(a, fit.shape, fit.scale) : 0;
    let h = q + (1 - q) * g;
    h = Math.min(Math.max(h, 1e-6), 1 - 1e-6);
    values[i] = clampIndex(normalInv(h));
  }

  return {
    index: 'SPI',
    timescaleMonths,
    distribution: 'gamma (Thom MLE), zero-inflated',
    calibrationStart: calStart,
    calibrationEnd: calEnd,
    months: series.months,
    values,
    categories: values.map((v) => classifyIndex(v).category),
    warnings,
  };
}

export interface SpeiResult extends Omit<SpiResult, 'index' | 'distribution'> {
  index: 'SPEI';
  distribution: 'log-logistic (L-moments)';
}

/**
 * Standardized Precipitation-Evapotranspiration Index
 * (Vicente-Serrano et al. 2010). Operates on the climatic water balance
 * D = P - PET, fitted to a three-parameter log-logistic distribution.
 */
export function calculateSpei(
  precipMonthly: MonthlySeries,
  petMonthly: MonthlySeries,
  opts: SpiOptions,
): SpeiResult {
  const warnings: string[] = [];
  const petByMonth = new Map(petMonthly.months.map((m, i) => [m, petMonthly.values[i]]));
  const d: (number | null)[] = precipMonthly.months.map((m, i) => {
    const p = precipMonthly.values[i];
    const pet = petByMonth.get(m);
    if (p === null || pet === null || pet === undefined) return null;
    return p - pet;
  });

  const acc = rollingSum(d, opts.timescaleMonths);
  const calStart = opts.calibrationStart ?? precipMonthly.months[0];
  const calEnd = opts.calibrationEnd ?? precipMonthly.months[precipMonthly.months.length - 1];
  const perCalendarMonth = opts.perCalendarMonth ?? true;

  const groups = new Map<number, number[]>();
  for (let i = 0; i < precipMonthly.months.length; i++) {
    const a = acc[i];
    const m = precipMonthly.months[i];
    if (a === null || m < calStart || m > calEnd) continue;
    const key = perCalendarMonth ? Number(m.slice(5, 7)) : 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  const fits = new Map<number, { alpha: number; beta: number; gamma: number }>();
  for (const [key, arr] of groups) {
    if (arr.length < 20) warnings.push(`Only ${arr.length} calibration values for calendar month ${key}; SPEI is provisional.`);
    if (arr.length < 5) continue;
    fits.set(key, fitLogLogistic(arr));
  }

  const values: (number | null)[] = new Array(precipMonthly.months.length).fill(null);
  for (let i = 0; i < precipMonthly.months.length; i++) {
    const a = acc[i];
    if (a === null) continue;
    const key = perCalendarMonth ? Number(precipMonthly.months[i].slice(5, 7)) : 0;
    const fit = fits.get(key);
    if (!fit || !Number.isFinite(fit.beta) || !Number.isFinite(fit.alpha)) continue;
    let p = logLogisticCdf(a, fit.alpha, fit.beta, fit.gamma);
    p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
    values[i] = clampIndex(normalInv(p));
  }

  return {
    index: 'SPEI',
    timescaleMonths: opts.timescaleMonths,
    distribution: 'log-logistic (L-moments)',
    calibrationStart: calStart,
    calibrationEnd: calEnd,
    months: precipMonthly.months,
    values,
    categories: values.map((v) => classifyIndex(v).category),
    warnings,
  };
}

/**
 * Standardized Streamflow Index — the SPI transform applied to accumulated
 * streamflow, giving a hydrological (as opposed to meteorological) drought
 * signal (Vicente-Serrano et al. 2012).
 */
export function calculateSsi(monthlyFlow: MonthlySeries, timescaleMonths: number): SpiResult {
  const r = calculateSpi(monthlyFlow, { timescaleMonths });
  return { ...r, index: 'SPI', distribution: 'gamma (Thom MLE), zero-inflated' };
}

/**
 * Reference evapotranspiration by the Hargreaves–Samani (1985) equation.
 * Chosen because it needs only temperature and extraterrestrial radiation —
 * the variables reliably present in a hydrology archive.
 * ET0 = 0.0023 * Ra * (Tmean + 17.8) * sqrt(Tmax - Tmin)   [mm/day]
 */
export function hargreavesPet(tmaxC: number, tminC: number, latitudeDeg: number, dayOfYear: number): number {
  const tmean = (tmaxC + tminC) / 2;
  const ra = extraterrestrialRadiation(latitudeDeg, dayOfYear); // MJ m-2 day-1
  const raMm = ra * 0.408; // MJ m-2 day-1 -> mm day-1 equivalent evaporation
  const tr = Math.max(tmaxC - tminC, 0);
  return Math.max(0.0023 * raMm * (tmean + 17.8) * Math.sqrt(tr), 0);
}

/** FAO-56 extraterrestrial radiation Ra [MJ m-2 day-1]. */
export function extraterrestrialRadiation(latitudeDeg: number, dayOfYear: number): number {
  const phi = (Math.PI / 180) * latitudeDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39);
  const x = Math.min(Math.max(-Math.tan(phi) * Math.tan(delta), -1), 1);
  const omega = Math.acos(x);
  const gsc = 0.0820; // MJ m-2 min-1
  return ((24 * 60) / Math.PI) * gsc * dr * (omega * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(omega));
}

/** Identify drought events as runs below a threshold on a standardised index. */
export function identifyDroughtEvents(months: string[], values: (number | null)[], threshold = -0.8): DroughtEvent[] {
  const events: DroughtEvent[] = [];
  let start = -1;
  const close = (endIdx: number) => {
    let severity = 0;
    let peak = 0;
    for (let i = start; i <= endIdx; i++) {
      const v = values[i];
      if (v === null) continue;
      severity += Math.abs(v);
      if (v < peak) peak = v;
    }
    events.push({
      start: months[start],
      end: months[endIdx],
      durationMonths: endIdx - start + 1,
      severity: Number(severity.toFixed(3)),
      peakIntensity: Number(peak.toFixed(3)),
      peakCategory: classifyIndex(peak).category,
    });
  };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const inDrought = v !== null && v <= threshold;
    if (inDrought && start < 0) start = i;
    if (!inDrought && start >= 0) {
      close(i - 1);
      start = -1;
    }
  }
  if (start >= 0) close(values.length - 1);
  return events;
}

function clampIndex(v: number): number {
  if (!Number.isFinite(v)) return NaN;
  // Standardised indices are conventionally truncated at +/-3.09 (p = 0.001).
  return Math.min(Math.max(v, -3.09), 3.09);
}
