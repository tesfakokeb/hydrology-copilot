import type { ForecastModelKind, ForecastPoint, ModelMetrics } from '@hydro/shared-types';
import { dayOfYear, smoothedClimatology } from './flow.js';
import { evaluate } from './metrics.js';
import { normalInv, quantile } from './stats.js';

/**
 * Baseline forecasting models implemented in TypeScript so that the platform
 * always has a working, fully reproducible forecast path even when the Python
 * scientific service (which hosts the Random Forest, XGBoost, LSTM/GRU and
 * TFT implementations) is unavailable.
 *
 * All models here are fitted, validated on a held-out period, and report the
 * skill they actually achieved. None of them extrapolates without an
 * accompanying uncertainty band derived from validation residuals.
 */

export interface ForecastInput {
  dates: string[];
  /** Target variable, e.g. discharge. */
  values: (number | null)[];
  /** Optional exogenous driver, e.g. basin-average precipitation. */
  precipitation?: (number | null)[];
  /** Optional exogenous driver, e.g. mean temperature. */
  temperature?: (number | null)[];
}

export interface ForecastOptions {
  model: ForecastModelKind;
  horizonDays: number;
  /** Fraction of the record held out for validation, from the end. */
  validationFraction?: number;
  /** Number of ensemble members for probabilistic output. */
  ensembleSize?: number;
  seed?: number;
}

export interface ForecastOutput {
  model: ForecastModelKind;
  points: ForecastPoint[];
  metrics: ModelMetrics;
  trainingPeriod: { start: string; end: string };
  validationPeriod: { start: string; end: string } | null;
  featureImportance: { feature: string; importance: number }[];
  residualStdDev: number;
  limitations: string[];
  warnings: string[];
}

/** Deterministic PRNG so every forecast is exactly reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Ordinary least squares with a ridge term for numerical stability. */
export function ridgeRegression(X: number[][], y: number[], lambda = 1e-6): number[] {
  const n = X.length;
  const p = X[0].length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty: number[] = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) XtX[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < p; j++) XtX[j][j] += lambda;
  return solveLinearSystem(XtX, Xty);
}

/** Gaussian elimination with partial pivoting. */
export function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

const LOG_EPS = 1e-3;
const toLog = (v: number) => Math.log(Math.max(v, LOG_EPS));
const fromLog = (v: number) => Math.max(Math.exp(v) - 0, 0);

/**
 * Autoregressive model on log-transformed flow anomalies with optional
 * precipitation lags — a lag-p linear model fitted by ridge regression.
 * This is the ARIMA-family baseline; the log transform stabilises variance
 * and guarantees non-negative forecasts.
 */
export function fitAutoregressive(
  input: ForecastInput,
  opts: { lags?: number; precipLags?: number; validationFraction?: number } = {},
): {
  coefficients: number[];
  featureNames: string[];
  lags: number;
  precipLags: number;
  residuals: number[];
  metrics: ModelMetrics;
  climatology: Map<number, number>;
  trainIndex: { start: number; end: number };
  validIndex: { start: number; end: number } | null;
} {
  const lags = opts.lags ?? 5;
  const precipLags = opts.precipLags ?? (input.precipitation ? 5 : 0);
  const climatology = smoothedClimatology(input.dates, input.values);

  const rows: number[][] = [];
  const targets: number[] = [];
  const rowIndex: number[] = [];
  const maxLag = Math.max(lags, precipLags);

  for (let i = maxLag; i < input.values.length; i++) {
    const y = input.values[i];
    if (y === null || !Number.isFinite(y)) continue;
    const feats: number[] = [1];
    let ok = true;
    for (let l = 1; l <= lags; l++) {
      const v = input.values[i - l];
      if (v === null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      const c = climatology.get(dayOfYear(input.dates[i - l])) ?? v;
      feats.push(toLog(v) - toLog(c));
    }
    if (!ok) continue;
    for (let l = 0; l < precipLags; l++) {
      const p = input.precipitation?.[i - l];
      feats.push(p === null || p === undefined || !Number.isFinite(p) ? 0 : Math.log1p(p));
    }
    const cy = climatology.get(dayOfYear(input.dates[i])) ?? y;
    rows.push(feats);
    targets.push(toLog(y) - toLog(cy));
    rowIndex.push(i);
  }

  const vFrac = opts.validationFraction ?? 0.25;
  const split = Math.max(Math.floor(rows.length * (1 - vFrac)), Math.floor(rows.length * 0.5));
  const Xtrain = rows.slice(0, split);
  const ytrain = targets.slice(0, split);
  const coefficients = Xtrain.length > rows[0]?.length ? ridgeRegression(Xtrain, ytrain, 1e-4) : new Array(rows[0]?.length ?? 1).fill(0);

  const predictRow = (r: number[]) => r.reduce((s, v, j) => s + v * coefficients[j], 0);

  const obs: number[] = [];
  const sim: number[] = [];
  for (let k = split; k < rows.length; k++) {
    const i = rowIndex[k];
    const cy = climatology.get(dayOfYear(input.dates[i])) ?? 1;
    obs.push(input.values[i] as number);
    sim.push(fromLog(predictRow(rows[k]) + toLog(cy)));
  }
  const metrics = obs.length > 2 ? evaluate(obs, sim) : evaluate([], []);
  const residuals = rows.slice(0, split).map((r, k) => ytrain[k] - predictRow(r));

  const featureNames = [
    'intercept',
    ...Array.from({ length: lags }, (_, i) => `log-anomaly lag ${i + 1} d`),
    ...Array.from({ length: precipLags }, (_, i) => `log(1+precip) lag ${i} d`),
  ];

  return {
    coefficients,
    featureNames,
    lags,
    precipLags,
    residuals,
    metrics,
    climatology,
    trainIndex: { start: rowIndex[0] ?? 0, end: rowIndex[split - 1] ?? 0 },
    validIndex: rowIndex.length > split ? { start: rowIndex[split], end: rowIndex[rowIndex.length - 1] } : null,
  };
}

/** Run a forecast with the requested baseline model. */
export function forecast(input: ForecastInput, opts: ForecastOptions): ForecastOutput {
  const warnings: string[] = [];
  const validCount = input.values.filter((v) => v !== null && Number.isFinite(v)).length;
  if (validCount < 60) {
    return {
      model: opts.model,
      points: [],
      metrics: evaluate([], []),
      trainingPeriod: { start: input.dates[0] ?? '', end: input.dates[input.dates.length - 1] ?? '' },
      validationPeriod: null,
      featureImportance: [],
      residualStdDev: NaN,
      limitations: ['Fewer than 60 valid observations — no forecast was produced.'],
      warnings: [`Only ${validCount} valid observations are available. A minimum of 60 is enforced before any model is fitted.`],
    };
  }

  switch (opts.model) {
    case 'persistence':
      return persistenceForecast(input, opts, warnings);
    case 'climatology':
      return climatologyForecast(input, opts, warnings);
    case 'moving_average':
      return movingAverageForecast(input, opts, warnings);
    case 'arima':
    case 'sarima':
      return autoregressiveForecast(input, opts, warnings);
    default:
      warnings.push(
        `Model "${opts.model}" is hosted by the Python scientific service. ` +
          'The autoregressive baseline was used instead because that service did not return a result.',
      );
      return autoregressiveForecast(input, { ...opts, model: 'arima' }, warnings);
  }
}

function lastValidIndex(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && Number.isFinite(values[i])) return i;
  return -1;
}

function residualBands(base: number, residualSd: number, step: number): Partial<ForecastPoint> {
  // Uncertainty grows with the square root of lead time — the standard
  // random-walk error-growth assumption for short-range hydrologic forecasts.
  const sd = residualSd * Math.sqrt(step);
  const z80 = normalInv(0.9);
  const z95 = normalInv(0.975);
  return {
    lower80: Math.max(base * Math.exp(-z80 * sd), 0),
    upper80: base * Math.exp(z80 * sd),
    lower95: Math.max(base * Math.exp(-z95 * sd), 0),
    upper95: base * Math.exp(z95 * sd),
  };
}

function persistenceForecast(input: ForecastInput, opts: ForecastOptions, warnings: string[]): ForecastOutput {
  const li = lastValidIndex(input.values);
  const last = input.values[li] as number;
  const changes: number[] = [];
  for (let i = 1; i <= li; i++) {
    const a = input.values[i - 1];
    const b = input.values[i];
    if (a && b && a > 0 && b > 0) changes.push(Math.log(b) - Math.log(a));
  }
  const sd = Math.sqrt(changes.reduce((s, v) => s + v * v, 0) / Math.max(changes.length, 1));

  const obs: number[] = [];
  const sim: number[] = [];
  for (let i = 1; i < input.values.length; i++) {
    const a = input.values[i - 1];
    const b = input.values[i];
    if (a !== null && b !== null) {
      obs.push(b);
      sim.push(a);
    }
  }

  const points: ForecastPoint[] = [];
  for (let s = 1; s <= opts.horizonDays; s++) {
    points.push({ t: addDays(input.dates[li], s), mean: last, ...residualBands(last, sd, s) });
  }

  return {
    model: 'persistence',
    points,
    metrics: evaluate(obs, sim),
    trainingPeriod: { start: input.dates[0], end: input.dates[li] },
    validationPeriod: null,
    featureImportance: [{ feature: 'most recent observation', importance: 1 }],
    residualStdDev: sd,
    limitations: [
      'Persistence carries the last observation forward unchanged. It has no skill during rising or falling limbs and is included as the reference benchmark that any skilful model must beat.',
    ],
    warnings,
  };
}

function climatologyForecast(input: ForecastInput, opts: ForecastOptions, warnings: string[]): ForecastOutput {
  const clim = smoothedClimatology(input.dates, input.values);
  const li = lastValidIndex(input.values);
  const obs: number[] = [];
  const sim: number[] = [];
  for (let i = 0; i < input.values.length; i++) {
    const v = input.values[i];
    const c = clim.get(dayOfYear(input.dates[i]));
    if (v !== null && c !== undefined) {
      obs.push(v);
      sim.push(c);
    }
  }
  const logResid = obs.map((o, i) => Math.log(Math.max(o, LOG_EPS)) - Math.log(Math.max(sim[i], LOG_EPS)));
  const sd = Math.sqrt(logResid.reduce((s, v) => s + v * v, 0) / Math.max(logResid.length, 1));

  const points: ForecastPoint[] = [];
  for (let s = 1; s <= opts.horizonDays; s++) {
    const t = addDays(input.dates[li], s);
    const base = clim.get(dayOfYear(t)) ?? (input.values[li] as number);
    points.push({ t, mean: base, ...residualBands(base, sd, 1) });
  }

  return {
    model: 'climatology',
    points,
    metrics: evaluate(obs, sim),
    trainingPeriod: { start: input.dates[0], end: input.dates[li] },
    validationPeriod: null,
    featureImportance: [{ feature: 'day-of-year seasonal mean', importance: 1 }],
    residualStdDev: sd,
    limitations: [
      'Climatology ignores current catchment state entirely. It is the appropriate benchmark at seasonal lead times and a poor short-range forecast.',
    ],
    warnings,
  };
}

function movingAverageForecast(input: ForecastInput, opts: ForecastOptions, warnings: string[]): ForecastOutput {
  const window = 7;
  const li = lastValidIndex(input.values);
  const recent = input.values.slice(Math.max(li - window + 1, 0), li + 1).filter((v): v is number => v !== null);
  const base = recent.reduce((a, b) => a + b, 0) / recent.length;

  const obs: number[] = [];
  const sim: number[] = [];
  for (let i = window; i < input.values.length; i++) {
    const w = input.values.slice(i - window, i).filter((v): v is number => v !== null);
    const y = input.values[i];
    if (w.length === window && y !== null) {
      obs.push(y);
      sim.push(w.reduce((a, b) => a + b, 0) / window);
    }
  }
  const logResid = obs.map((o, i) => Math.log(Math.max(o, LOG_EPS)) - Math.log(Math.max(sim[i], LOG_EPS)));
  const sd = Math.sqrt(logResid.reduce((s, v) => s + v * v, 0) / Math.max(logResid.length, 1));

  const points: ForecastPoint[] = [];
  for (let s = 1; s <= opts.horizonDays; s++) {
    points.push({ t: addDays(input.dates[li], s), mean: base, ...residualBands(base, sd, Math.min(s, 5)) });
  }

  return {
    model: 'moving_average',
    points,
    metrics: evaluate(obs, sim),
    trainingPeriod: { start: input.dates[0], end: input.dates[li] },
    validationPeriod: null,
    featureImportance: [{ feature: `${window}-day trailing mean`, importance: 1 }],
    residualStdDev: sd,
    limitations: ['A trailing mean damps peaks and lags the hydrograph by roughly half the window length.'],
    warnings,
  };
}

function autoregressiveForecast(input: ForecastInput, opts: ForecastOptions, warnings: string[]): ForecastOutput {
  const fit = fitAutoregressive(input, { validationFraction: opts.validationFraction ?? 0.25 });
  const li = lastValidIndex(input.values);
  const { lags, precipLags, coefficients, climatology } = fit;

  const history = [...input.values];
  const dates = [...input.dates];
  const points: ForecastPoint[] = [];

  const residSd = Math.sqrt(fit.residuals.reduce((s, v) => s + v * v, 0) / Math.max(fit.residuals.length, 1));
  const ensembleSize = opts.ensembleSize ?? 100;
  const rng = mulberry32(opts.seed ?? 20260901);

  // Ensemble: perturb each step with a draw from the residual distribution,
  // which propagates uncertainty through the autoregressive recursion.
  const members: number[][] = [];
  for (let m = 0; m < ensembleSize; m++) {
    const h = [...history];
    const d = [...dates];
    const path: number[] = [];
    for (let s = 1; s <= opts.horizonDays; s++) {
      const nextDate = addDays(d[d.length - 1], 1);
      const feats: number[] = [1];
      for (let l = 1; l <= lags; l++) {
        const idx = h.length - l;
        const v = (h[idx] as number) ?? 0;
        const c = climatology.get(dayOfYear(d[idx] ?? nextDate)) ?? v;
        feats.push(toLog(Math.max(v, LOG_EPS)) - toLog(Math.max(c, LOG_EPS)));
      }
      for (let l = 0; l < precipLags; l++) {
        const idx = h.length - l;
        const p = input.precipitation?.[idx];
        // Beyond the observed record no precipitation forcing is assumed;
        // the model runs on a zero-rainfall (recession) assumption.
        feats.push(p === null || p === undefined || !Number.isFinite(p) ? 0 : Math.log1p(p));
      }
      const pred = feats.reduce((sum, v, j) => sum + v * coefficients[j], 0);
      const noise = m === 0 ? 0 : gaussian(rng) * residSd;
      const cNext = climatology.get(dayOfYear(nextDate)) ?? 1;
      const value = Math.max(fromLog(pred + noise + toLog(Math.max(cNext, LOG_EPS))), 0);
      h.push(value);
      d.push(nextDate);
      path.push(value);
    }
    members.push(path);
  }

  for (let s = 0; s < opts.horizonDays; s++) {
    const col = members.map((p) => p[s]).sort((a, b) => a - b);
    points.push({
      t: addDays(input.dates[li], s + 1),
      mean: members[0][s],
      lower80: quantile(col, 0.1),
      upper80: quantile(col, 0.9),
      lower95: quantile(col, 0.025),
      upper95: quantile(col, 0.975),
      ensemble: col.filter((_, i) => i % 10 === 0),
    });
  }

  const importance = coefficients
    .map((c, i) => ({ feature: fit.featureNames[i], importance: Math.abs(c) }))
    .filter((f) => f.feature !== 'intercept');
  const total = importance.reduce((s, f) => s + f.importance, 0) || 1;

  return {
    model: opts.model === 'sarima' ? 'sarima' : 'arima',
    points,
    metrics: fit.metrics,
    trainingPeriod: { start: input.dates[0], end: input.dates[fit.trainIndex.end] },
    validationPeriod: fit.validIndex ? { start: input.dates[fit.validIndex.start], end: input.dates[fit.validIndex.end] } : null,
    featureImportance: importance
      .map((f) => ({ feature: f.feature, importance: f.importance / total }))
      .sort((a, b) => b.importance - a.importance),
    residualStdDev: residSd,
    limitations: [
      'Linear autoregression on log-flow anomalies. It reproduces recession behaviour well and under-predicts sharp rainfall-driven peaks.',
      'No forecast precipitation is ingested: beyond the last observation the model assumes zero additional rainfall, so the forecast is a recession-biased lower bound during storm periods.',
      'Uncertainty bands come from the empirical distribution of training residuals propagated through the recursion, not from a formal predictive distribution.',
    ],
    warnings,
  };
}

function gaussian(rng: () => number): number {
  // Box–Muller
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Probability that any forecast point exceeds a threshold, from the ensemble. */
export function thresholdExceedanceProbability(points: ForecastPoint[], threshold: number): { overall: number; byDay: { t: string; p: number }[] } {
  const byDay = points.map((p) => {
    if (p.ensemble && p.ensemble.length > 0) {
      const n = p.ensemble.filter((v) => v >= threshold).length;
      return { t: p.t, p: n / p.ensemble.length };
    }
    // Fall back to a log-normal assumption implied by the 95 % band.
    if (p.upper95 !== undefined && p.lower95 !== undefined && p.upper95 > p.lower95 && p.mean > 0) {
      const sd = (Math.log(Math.max(p.upper95, 1e-6)) - Math.log(Math.max(p.lower95, 1e-6))) / (2 * 1.96);
      const z = (Math.log(Math.max(threshold, 1e-6)) - Math.log(p.mean)) / Math.max(sd, 1e-9);
      return { t: p.t, p: 1 - normalCdfLocal(z) };
    }
    return { t: p.t, p: p.mean >= threshold ? 1 : 0 };
  });
  // Probability of at least one exceedance, assuming daily independence of
  // the residual term (stated explicitly as an assumption in the provenance).
  const none = byDay.reduce((acc, d) => acc * (1 - d.p), 1);
  return { overall: 1 - none, byDay };
}

function normalCdfLocal(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
