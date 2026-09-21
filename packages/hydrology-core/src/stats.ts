/**
 * Statistical primitives used across the hydrology core.
 *
 * These are deliberately implemented from published algorithms rather than
 * pulled from a general-purpose stats package, so that the numerical basis of
 * every reported statistic is inspectable and citable.
 */

export function isFinite_(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Strip nulls/NaNs. Every downstream routine reports how many were removed. */
export function clean(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => isFinite_(v));
}

export function mean(x: number[]): number {
  if (x.length === 0) return NaN;
  return x.reduce((a, b) => a + b, 0) / x.length;
}

export function variance(x: number[], sample = true): number {
  const n = x.length;
  if (n < (sample ? 2 : 1)) return NaN;
  const m = mean(x);
  const ss = x.reduce((a, b) => a + (b - m) ** 2, 0);
  return ss / (sample ? n - 1 : n);
}

export function stdDev(x: number[], sample = true): number {
  return Math.sqrt(variance(x, sample));
}

export function skewness(x: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  const m = mean(x);
  const s = stdDev(x, true);
  if (s === 0) return 0;
  const sum = x.reduce((a, b) => a + ((b - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

export function kurtosis(x: number[]): number {
  const n = x.length;
  if (n < 4) return NaN;
  const m = mean(x);
  const s = stdDev(x, true);
  if (s === 0) return 0;
  const sum = x.reduce((a, b) => a + ((b - m) / s) ** 4, 0);
  const g2 = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum;
  return g2 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

/** Linear-interpolated quantile (numpy's default "linear" method). */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

export function median(x: number[]): number {
  return quantile([...x].sort((a, b) => a - b), 0.5);
}

export function percentileRank(sorted: number[], value: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return ((below + 0.5 * equal) / n) * 100;
}

export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(x: number[], y: number[]): number {
  return pearson(rank(x), rank(y));
}

/** Average ranks with tie handling. */
export function rank(x: number[]): number[] {
  const idx = x.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(x.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

/** Ordinary least squares y = a + b x. */
export function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
  const n = Math.min(x.length, y.length);
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r = pearson(x.slice(0, n), y.slice(0, n));
  return { slope, intercept, r2: r * r };
}

// ---------------------------------------------------------------------------
// Distribution functions
// ---------------------------------------------------------------------------

/** Lanczos approximation of ln Γ(x). Accurate to ~15 significant digits. */
export function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export function gammaFn(x: number): number {
  return Math.exp(lnGamma(x));
}

/** Regularised lower incomplete gamma P(a, x), series + continued fraction. */
export function gammaLowerRegularized(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    // Series expansion
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // Continued fraction for Q(a,x)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  return 1 - q;
}

/**
 * Standard normal CDF.
 *
 * Computed through the regularised incomplete gamma function using the
 * identity erf(x) = P(1/2, x²), which is accurate to ~1e-14 — far better than
 * the common Abramowitz & Stegun 7.1.26 rational approximation (~1e-7). The
 * accuracy matters: SPI, SPEI and flood-frequency quantiles all pass through
 * this function, and a 1e-7 error is visible in reported index values.
 */
export function normalCdf(z: number): number {
  if (z === 0) return 0.5;
  const p = gammaLowerRegularized(0.5, (z * z) / 2);
  return z > 0 ? 0.5 * (1 + p) : 0.5 * (1 - p);
}

/** erf(x) = sign(x) · P(1/2, x²). */
export function erf(x: number): number {
  if (x === 0) return 0;
  const p = gammaLowerRegularized(0.5, x * x);
  return x > 0 ? p : -p;
}

export function erfc(x: number): number {
  return 1 - erf(x);
}

/**
 * Inverse standard normal CDF. Acklam's rational approximation refined by one
 * Halley step; |error| < 1e-15 over the full range.
 */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  let q: number;
  let x: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - plow) {
    q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Halley refinement
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return x;
}

/**
 * Two-parameter gamma fit by Thom's (1958) maximum-likelihood approximation,
 * the standard estimator used in operational SPI implementations
 * (McKee et al. 1993; Edwards & McKee 1997; WMO-No. 1090).
 */
export function fitGamma(values: number[]): { shape: number; scale: number; zeroProbability: number } {
  const positives = values.filter((v) => v > 0);
  const zeros = values.length - positives.length;
  const q = values.length > 0 ? zeros / values.length : 1;
  if (positives.length < 2) return { shape: NaN, scale: NaN, zeroProbability: q };
  const xbar = mean(positives);
  const lnMean = mean(positives.map((v) => Math.log(v)));
  const A = Math.log(xbar) - lnMean;
  if (!(A > 0)) return { shape: 1e6, scale: xbar / 1e6, zeroProbability: q };
  const shape = (1 + Math.sqrt(1 + (4 * A) / 3)) / (4 * A);
  const scale = xbar / shape;
  return { shape, scale, zeroProbability: q };
}

export function gammaCdf(x: number, shape: number, scale: number): number {
  if (!(x > 0)) return 0;
  return gammaLowerRegularized(shape, x / scale);
}

/** Log-logistic (three-parameter) fit by L-moments — the SPEI standard. */
export function fitLogLogistic(values: number[]): { alpha: number; beta: number; gamma: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  // Probability-weighted moments (unbiased estimators)
  let w0 = 0;
  let w1 = 0;
  let w2 = 0;
  for (let i = 0; i < n; i++) {
    const x = sorted[i];
    const j = i + 1;
    w0 += x;
    w1 += x * ((n - j) / (n - 1));
    w2 += x * (((n - j) * (n - j - 1)) / ((n - 1) * (n - 2)));
  }
  w0 /= n;
  w1 /= n;
  w2 /= n;
  const beta = (2 * w1 - w0) / (6 * w1 - w0 - 6 * w2);
  const g1 = gammaFn(1 + 1 / beta);
  const g2 = gammaFn(1 - 1 / beta);
  const alpha = ((w0 - 2 * w1) * beta) / (g1 * g2);
  const gamma = w0 - alpha * g1 * g2;
  return { alpha, beta, gamma };
}

export function logLogisticCdf(x: number, alpha: number, beta: number, gamma: number): number {
  if (x <= gamma) return 1e-6;
  return 1 / (1 + (alpha / (x - gamma)) ** beta);
}

/** Student-t two-sided p-value via the incomplete beta function. */
export function tTestPValue(t: number, df: number): number {
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = (-((a + m) * (a + b + m)) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-12) break;
  }
  return front * (f - 1);
}

/** Rolling sum over a window; positions with insufficient history are null. */
export function rollingSum(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - window + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      s += v;
    }
    out[i] = ok ? s : null;
  }
  return out;
}

export function rollingMean(values: (number | null)[], window: number): (number | null)[] {
  return rollingSum(values, window).map((v) => (v === null ? null : v / window));
}

/** Modified z-score using the median absolute deviation (Iglewicz & Hoaglin). */
export function modifiedZScores(values: number[]): number[] {
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  if (mad === 0) return values.map(() => 0);
  return values.map((v) => (0.6745 * (v - med)) / mad);
}

export function iqrOutlierBounds(values: number[], k = 1.5): { lower: number; upper: number } {
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  return { lower: q1 - k * iqr, upper: q3 + k * iqr };
}
