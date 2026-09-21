import type { DischargeUnit, FloodFrequencyResult, FloodHazardClass } from '@hydro/shared-types';
import { mean, normalInv, skewness, stdDev } from './stats.js';

export const STANDARD_RETURN_PERIODS = [1.25, 2, 5, 10, 25, 50, 100, 200, 500];

/**
 * Log-Pearson Type III flood-frequency analysis following the method of
 * USGS Bulletin 17B / 17C: fit Pearson III to log10 of the annual peak
 * series and evaluate quantiles with the Wilson–Hilferty frequency factor.
 *
 * The station skew is used by default. Bulletin 17C's Expected Moments
 * Algorithm and regional skew weighting are not implemented here; the result
 * is labelled as an at-site analysis and must not be represented as a
 * regulatory flood-frequency determination.
 */
export function logPearson3(
  peaks: { waterYear: number; peak: number }[],
  unit: DischargeUnit,
  options: { returnPeriods?: number[]; regionalSkew?: number; regionalSkewMse?: number } = {},
): FloodFrequencyResult {
  const returnPeriods = options.returnPeriods ?? STANDARD_RETURN_PERIODS;
  const valid = peaks.filter((p) => p.peak > 0);
  const notes: string[] = [];

  if (valid.length < 10) {
    return {
      method: 'log-pearson-iii',
      stationId: null,
      nYears: valid.length,
      waterYears: valid.map((p) => p.waterYear),
      unit,
      quantiles: [],
      notes: [
        `Only ${valid.length} annual peaks are available. Bulletin 17C guidance calls for at least 10 years, ` +
          'and 25+ for a defensible 100-year estimate. No quantiles were computed.',
      ],
    };
  }

  const logs = valid.map((p) => Math.log10(p.peak));
  const n = logs.length;
  const m = mean(logs);
  const s = stdDev(logs);
  let g = skewness(logs);

  let skewOption: 'station' | 'weighted' = 'station';
  if (options.regionalSkew !== undefined) {
    // Bulletin 17B weighted skew: G_w = (MSE_R * G_s + MSE_s * G_R) / (MSE_R + MSE_s)
    const mseStation = stationSkewMse(g, n);
    const mseRegional = options.regionalSkewMse ?? 0.302;
    g = (mseRegional * g + mseStation * options.regionalSkew) / (mseRegional + mseStation);
    skewOption = 'weighted';
    notes.push(`Station skew weighted with a supplied regional skew of ${options.regionalSkew} (Bulletin 17B §4.3).`);
  }

  if (n < 25) {
    notes.push(
      `Record length is ${n} water years. Quantiles beyond the 50-year return period are extrapolations well ` +
        'outside the sampled range and carry substantial uncertainty.',
    );
  }
  notes.push('At-site analysis using station skew. Not a regulatory flood-frequency determination.');

  const quantiles = returnPeriods.map((T) => {
    const p = 1 - 1 / T; // non-exceedance
    const k = wilsonHilfertyK(p, g);
    const logQ = m + k * s;
    const q = 10 ** logQ;
    // Approximate confidence limits from the variance of the fitted quantile
    // (Bulletin 17B Appendix 9 first-order approximation).
    const seLog = s * Math.sqrt((1 + 0.5 * k * k) / n);
    const lower = 10 ** (logQ - 1.96 * seLog);
    const upper = 10 ** (logQ + 1.96 * seLog);
    return {
      returnPeriodYears: T,
      annualExceedanceProbability: 1 / T,
      discharge: q,
      lower95: lower,
      upper95: upper,
    };
  });

  return {
    method: 'log-pearson-iii',
    stationId: null,
    nYears: n,
    waterYears: valid.map((p) => p.waterYear),
    skewOption,
    unit,
    quantiles,
    notes,
  };
}

function stationSkewMse(g: number, n: number): number {
  // Bulletin 17B eq. 6 approximation of MSE of the station skew.
  const a = Math.abs(g) <= 0.9 ? -0.33 + 0.08 * Math.abs(g) : -0.52 + 0.3 * Math.abs(g);
  const b = Math.abs(g) <= 1.5 ? 0.94 - 0.26 * Math.abs(g) : 0.55;
  return 10 ** (a - b * Math.log10(n / 10));
}

/** Wilson–Hilferty frequency factor for the Pearson III distribution. */
export function wilsonHilfertyK(nonExceedance: number, skew: number): number {
  const z = normalInv(nonExceedance);
  if (Math.abs(skew) < 1e-6) return z;
  const k = skew / 6;
  return (2 / skew) * ((1 + k * z - k * k) ** 3 - 1);
}

/**
 * Generalised Extreme Value fit by L-moments (Hosking 1990) — a common
 * alternative to LP3, offered so results can be compared across distributions.
 */
export function gevLMoments(peaks: number[], unit: DischargeUnit, returnPeriods = STANDARD_RETURN_PERIODS): FloodFrequencyResult {
  const x = [...peaks].filter((v) => v > 0).sort((a, b) => a - b);
  const n = x.length;
  if (n < 10) {
    return { method: 'gev', stationId: null, nYears: n, waterYears: [], unit, quantiles: [], notes: ['Fewer than 10 annual peaks; GEV not fitted.'] };
  }
  // Sample L-moments via probability-weighted moments
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    b0 += x[i];
    b1 += (x[i] * (j - 1)) / (n - 1);
    b2 += (x[i] * (j - 1) * (j - 2)) / ((n - 1) * (n - 2));
  }
  b0 /= n;
  b1 /= n;
  b2 /= n;
  const l1 = b0;
  const l2 = 2 * b1 - b0;
  const l3 = 6 * b2 - 6 * b1 + b0;
  const t3 = l3 / l2;

  // Hosking's approximation for the GEV shape parameter
  const c = (2 / (3 + t3)) - Math.LN2 / Math.log(3);
  const k = 7.8590 * c + 2.9554 * c * c;
  const gk = Math.exp(lnGammaLocal(1 + k));
  const alpha = (l2 * k) / ((1 - 2 ** -k) * gk);
  const xi = l1 - (alpha * (1 - gk)) / k;

  const quantiles = returnPeriods.map((T) => {
    const p = 1 - 1 / T;
    const y = -Math.log(-Math.log(p));
    const q = Math.abs(k) < 1e-6 ? xi + alpha * y : xi + (alpha / k) * (1 - Math.exp(-k * y));
    return { returnPeriodYears: T, annualExceedanceProbability: 1 / T, discharge: q, lower95: null, upper95: null };
  });

  return {
    method: 'gev',
    stationId: null,
    nYears: n,
    waterYears: [],
    unit,
    quantiles,
    notes: [`GEV fitted by L-moments (Hosking 1990). Shape k = ${k.toFixed(4)}, scale = ${alpha.toFixed(3)}, location = ${xi.toFixed(3)}.`],
  };
}

function lnGammaLocal(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGammaLocal(1 - z);
  z -= 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Empirical return period of a discharge from an annual-peak record. */
export function estimateReturnPeriod(peaks: number[], discharge: number): { returnPeriodYears: number | null; aep: number | null; method: string } {
  const sorted = [...peaks].sort((a, b) => b - a);
  const n = sorted.length;
  if (n < 10) return { returnPeriodYears: null, aep: null, method: 'insufficient record' };
  let rank = sorted.findIndex((v) => v <= discharge);
  if (rank === -1) rank = n;
  else rank = rank + 1;
  if (rank === 0) rank = 1;
  const T = (n + 1) / rank;
  return {
    returnPeriodYears: T,
    aep: 1 / T,
    method: `Weibull plotting position over ${n} annual peaks. Extrapolation beyond ${(n + 1).toFixed(0)}-year return period is not supported by this record.`,
  };
}

/**
 * Flood hazard classification from depth and velocity, following the
 * depth-velocity product convention used in Australian (AR&R) and several
 * US floodplain-management guidelines. D*V thresholds are for pedestrian and
 * vehicle stability.
 */
export function classifyHazard(depthM: number, velocityMs: number | null): FloodHazardClass {
  const v = velocityMs ?? 0;
  const dv = depthM * v;
  if (depthM >= 1.2 || dv >= 1.0 || v >= 3.0) return 'extreme';
  if (depthM >= 0.6 || dv >= 0.6) return 'high';
  if (depthM >= 0.3 || dv >= 0.3) return 'moderate';
  return 'low';
}

export const REGULATORY_DISCLAIMER = [
  'Results are analytical model outputs produced by Hydrology Copilot.',
  'They are not FEMA-issued flood hazard determinations, effective Flood Insurance Rate Map (FIRM) products, or regulatory Base Flood Elevations.',
  'Regulatory floodplain, floodway and BFE determinations may only be made from effective FEMA products or an accepted Letter of Map Change.',
];

/**
 * Probability that at least one exceedance of a T-year event occurs within a
 * planning horizon of `years` — the "risk" formula 1 - (1 - 1/T)^n.
 */
export function encounterProbability(returnPeriodYears: number, years: number): number {
  return 1 - (1 - 1 / returnPeriodYears) ** years;
}
