import type {
  TrendResult,
  WaterQualityIndexResult,
  WaterQualityParameter,
  WaterQualityThreshold,
} from '@hydro/shared-types';
import { median, modifiedZScores, normalCdf, rank } from './stats.js';

/**
 * Default screening criteria. These are widely used freshwater aquatic-life
 * and recreational screening values; a project may override any of them.
 * They are screening thresholds, not the applicable regulatory standard for
 * any specific waterbody — the applicable standard is set by the state or
 * tribal authority with jurisdiction.
 */
export const DEFAULT_THRESHOLDS: WaterQualityThreshold[] = [
  { parameter: 'temperature', unit: 'degC', direction: 'max', max: 25, source: 'General warmwater aquatic-life screening value' },
  { parameter: 'ph', unit: 'pH', direction: 'range', min: 6.5, max: 8.5, source: 'US EPA aquatic-life range' },
  { parameter: 'dissolved_oxygen', unit: 'mg/L', direction: 'min', min: 5.0, source: 'US EPA aquatic-life minimum' },
  { parameter: 'turbidity', unit: 'NTU', direction: 'max', max: 25, source: 'Common state narrative screening value' },
  { parameter: 'conductivity', unit: 'uS/cm', direction: 'max', max: 500, source: 'Aquatic-life screening benchmark' },
  { parameter: 'tds', unit: 'mg/L', direction: 'max', max: 500, source: 'US EPA secondary drinking-water standard' },
  { parameter: 'nitrate', unit: 'mg/L', direction: 'max', max: 10, source: 'US EPA MCL as N (drinking water)' },
  { parameter: 'phosphate', unit: 'mg/L', direction: 'max', max: 0.1, source: 'Nutrient screening value (total P)' },
  { parameter: 'ammonia', unit: 'mg/L', direction: 'max', max: 1.0, source: 'Aquatic-life screening value (pH/T dependent)' },
  { parameter: 'chlorophyll_a', unit: 'ug/L', direction: 'max', max: 25, source: 'Eutrophication screening value' },
  { parameter: 'e_coli', unit: 'MPN/100mL', direction: 'max', max: 126, source: 'US EPA recreational criterion, geometric mean' },
  { parameter: 'tss', unit: 'mg/L', direction: 'max', max: 30, source: 'Sediment screening value' },
  { parameter: 'toc', unit: 'mg/L', direction: 'max', max: 10, source: 'Screening value' },
];

export const PARAMETER_LABELS: Record<WaterQualityParameter, string> = {
  temperature: 'Water temperature',
  ph: 'pH',
  dissolved_oxygen: 'Dissolved oxygen',
  turbidity: 'Turbidity',
  conductivity: 'Specific conductance',
  tds: 'Total dissolved solids',
  nitrate: 'Nitrate (as N)',
  phosphate: 'Total phosphorus',
  ammonia: 'Ammonia (as N)',
  chlorophyll_a: 'Chlorophyll-a',
  e_coli: 'E. coli',
  tss: 'Total suspended solids',
  toc: 'Total organic carbon',
};

export interface QualityObservation {
  t: string;
  parameter: WaterQualityParameter;
  value: number;
}

export function isExceedance(value: number, th: WaterQualityThreshold): boolean {
  if (th.direction === 'max') return th.max !== undefined && value > th.max;
  if (th.direction === 'min') return th.min !== undefined && value < th.min;
  return (th.min !== undefined && value < th.min) || (th.max !== undefined && value > th.max);
}

/** Normalised excursion used by the CCME WQI amplitude term. */
function excursion(value: number, th: WaterQualityThreshold): number {
  if (th.direction === 'max' && th.max !== undefined) return value / th.max - 1;
  if (th.direction === 'min' && th.min !== undefined) return th.min / value - 1;
  if (th.direction === 'range') {
    if (th.max !== undefined && value > th.max) return value / th.max - 1;
    if (th.min !== undefined && value < th.min) return th.min / value - 1;
  }
  return 0;
}

/**
 * CCME Water Quality Index (Canadian Council of Ministers of the Environment,
 * 2001). Chosen over the NSF index because it accepts an arbitrary parameter
 * set and reports its three components separately, which makes the score
 * auditable.
 *
 *   F1 = (failed variables / total variables) * 100
 *   F2 = (failed tests / total tests) * 100
 *   F3 = nse / (0.01 * nse + 0.01)   where nse = sum(excursions) / total tests
 *   WQI = 100 - sqrt(F1^2 + F2^2 + F3^2) / 1.732
 */
export function ccmeWqi(
  observations: QualityObservation[],
  thresholds: WaterQualityThreshold[] = DEFAULT_THRESHOLDS,
): WaterQualityIndexResult {
  const thByParam = new Map(thresholds.map((t) => [t.parameter, t]));
  const usable = observations.filter((o) => thByParam.has(o.parameter) && Number.isFinite(o.value));
  const params = [...new Set(usable.map((o) => o.parameter))];

  if (usable.length === 0 || params.length === 0) {
    return {
      wqi: NaN,
      rating: 'Poor',
      method: 'CCME-WQI',
      parametersUsed: [],
      exceedances: [],
      period: { start: '', end: '' },
    };
  }

  const failedVariables = new Set<WaterQualityParameter>();
  let failedTests = 0;
  let excursionSum = 0;
  const perParam = new Map<WaterQualityParameter, { count: number; total: number }>();

  for (const o of usable) {
    const th = thByParam.get(o.parameter)!;
    const rec = perParam.get(o.parameter) ?? { count: 0, total: 0 };
    rec.total += 1;
    if (isExceedance(o.value, th)) {
      failedVariables.add(o.parameter);
      failedTests += 1;
      rec.count += 1;
      excursionSum += Math.max(excursion(o.value, th), 0);
    }
    perParam.set(o.parameter, rec);
  }

  const totalTests = usable.length;
  const f1 = (failedVariables.size / params.length) * 100;
  const f2 = (failedTests / totalTests) * 100;
  const nse = excursionSum / totalTests;
  const f3 = nse / (0.01 * nse + 0.01);
  const wqi = 100 - Math.sqrt(f1 * f1 + f2 * f2 + f3 * f3) / 1.732;

  const dates = usable.map((o) => o.t).sort();

  return {
    wqi: Math.max(0, Math.min(100, wqi)),
    rating: rateWqi(wqi),
    method: 'CCME-WQI',
    parametersUsed: params,
    f1Scope: f1,
    f2Frequency: f2,
    f3Amplitude: f3,
    exceedances: [...perParam.entries()].map(([parameter, r]) => ({
      parameter,
      count: r.count,
      total: r.total,
      pct: (r.count / r.total) * 100,
    })),
    period: { start: dates[0], end: dates[dates.length - 1] },
  };
}

export function rateWqi(wqi: number): WaterQualityIndexResult['rating'] {
  if (wqi >= 95) return 'Excellent';
  if (wqi >= 80) return 'Good';
  if (wqi >= 65) return 'Fair';
  if (wqi >= 45) return 'Marginal';
  return 'Poor';
}

/**
 * Mann–Kendall trend test with tie correction, plus the Theil–Sen slope.
 * The non-parametric pair is the standard for water-quality records, which
 * are typically non-normal, censored and irregularly sampled.
 */
export function mannKendall(
  times: number[],
  values: number[],
  alpha = 0.05,
  unitPerYear = 'unit/yr',
): TrendResult {
  const n = values.length;
  if (n < 8) {
    return {
      parameter: '',
      method: 'mann-kendall',
      n,
      tau: null,
      pValue: NaN,
      slopePerYear: NaN,
      slopeUnit: unitPerYear,
      significant: false,
      alpha,
      direction: 'no trend',
    };
  }

  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j] - values[i]);
  }

  // Variance with tie correction
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const c of counts.values()) if (c > 1) tieTerm += c * (c - 1) * (2 * c + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;

  const z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  const tau = s / (0.5 * n * (n - 1));

  // Theil–Sen slope over all pairwise slopes
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dt = times[j] - times[i];
      if (dt !== 0) slopes.push((values[j] - values[i]) / dt);
    }
  }
  const slope = slopes.length > 0 ? median(slopes) : NaN;

  return {
    parameter: '',
    method: 'mann-kendall',
    n,
    tau,
    pValue: p,
    slopePerYear: slope,
    slopeUnit: unitPerYear,
    significant: p < alpha,
    alpha,
    direction: p >= alpha ? 'no trend' : slope > 0 ? 'increasing' : 'decreasing',
  };
}

/**
 * Seasonal Mann–Kendall (Hirsch et al. 1982): the test is computed within
 * each season and the statistics are summed, which removes seasonality as a
 * confounder in water-quality records.
 */
export function seasonalMannKendall(
  months: number[],
  times: number[],
  values: number[],
  alpha = 0.05,
  unitPerYear = 'unit/yr',
): TrendResult {
  const seasons = new Map<number, { t: number[]; v: number[] }>();
  for (let i = 0; i < values.length; i++) {
    const m = months[i];
    if (!seasons.has(m)) seasons.set(m, { t: [], v: [] });
    seasons.get(m)!.t.push(times[i]);
    seasons.get(m)!.v.push(values[i]);
  }
  let sTotal = 0;
  let varTotal = 0;
  const allSlopes: number[] = [];
  for (const { t, v } of seasons.values()) {
    const n = v.length;
    if (n < 4) continue;
    let s = 0;
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) s += Math.sign(v[j] - v[i]);
    sTotal += s;
    varTotal += (n * (n - 1) * (2 * n + 5)) / 18;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const dt = t[j] - t[i];
        if (dt !== 0) allSlopes.push((v[j] - v[i]) / dt);
      }
    }
  }
  if (varTotal === 0 || allSlopes.length === 0) {
    return { parameter: '', method: 'seasonal-mann-kendall', n: values.length, tau: null, pValue: NaN, slopePerYear: NaN, slopeUnit: unitPerYear, significant: false, alpha, direction: 'no trend' };
  }
  const z = sTotal > 0 ? (sTotal - 1) / Math.sqrt(varTotal) : sTotal < 0 ? (sTotal + 1) / Math.sqrt(varTotal) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  const slope = median(allSlopes);
  return {
    parameter: '',
    method: 'seasonal-mann-kendall',
    n: values.length,
    tau: null,
    pValue: p,
    slopePerYear: slope,
    slopeUnit: unitPerYear,
    significant: p < alpha,
    alpha,
    direction: p >= alpha ? 'no trend' : slope > 0 ? 'increasing' : 'decreasing',
  };
}

export interface QualityAnomaly {
  t: string;
  parameter: WaterQualityParameter;
  value: number;
  modifiedZ: number;
  severity: 'moderate' | 'extreme';
}

/**
 * Anomaly detection by the modified z-score (Iglewicz & Hoaglin 1993), which
 * uses the median and MAD and is therefore robust to the anomalies it is
 * looking for. |Z| > 3.5 is the conventional flag.
 */
export function detectQualityAnomalies(observations: QualityObservation[], threshold = 3.5): QualityAnomaly[] {
  const byParam = new Map<WaterQualityParameter, QualityObservation[]>();
  for (const o of observations) {
    if (!byParam.has(o.parameter)) byParam.set(o.parameter, []);
    byParam.get(o.parameter)!.push(o);
  }
  const out: QualityAnomaly[] = [];
  for (const [parameter, arr] of byParam) {
    if (arr.length < 12) continue;
    const z = modifiedZScores(arr.map((a) => a.value));
    arr.forEach((o, i) => {
      if (Math.abs(z[i]) > threshold) {
        out.push({
          t: o.t,
          parameter,
          value: o.value,
          modifiedZ: Number(z[i].toFixed(2)),
          severity: Math.abs(z[i]) > 5 ? 'extreme' : 'moderate',
        });
      }
    });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

/** Spearman correlation matrix between water-quality parameters. */
export function parameterCorrelations(
  observations: QualityObservation[],
): { a: WaterQualityParameter; b: WaterQualityParameter; rho: number; n: number }[] {
  const byDate = new Map<string, Map<WaterQualityParameter, number>>();
  for (const o of observations) {
    if (!byDate.has(o.t)) byDate.set(o.t, new Map());
    byDate.get(o.t)!.set(o.parameter, o.value);
  }
  const params = [...new Set(observations.map((o) => o.parameter))];
  const out: { a: WaterQualityParameter; b: WaterQualityParameter; rho: number; n: number }[] = [];
  for (let i = 0; i < params.length; i++) {
    for (let j = i + 1; j < params.length; j++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const m of byDate.values()) {
        const a = m.get(params[i]);
        const b = m.get(params[j]);
        if (a !== undefined && b !== undefined) {
          xs.push(a);
          ys.push(b);
        }
      }
      if (xs.length >= 10) {
        const rx = rank(xs);
        const ry = rank(ys);
        const n = rx.length;
        const mx = rx.reduce((s, v) => s + v, 0) / n;
        const my = ry.reduce((s, v) => s + v, 0) / n;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let k = 0; k < n; k++) {
          sxy += (rx[k] - mx) * (ry[k] - my);
          sxx += (rx[k] - mx) ** 2;
          syy += (ry[k] - my) ** 2;
        }
        out.push({ a: params[i], b: params[j], rho: sxy / Math.sqrt(sxx * syy), n });
      }
    }
  }
  return out.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
}
