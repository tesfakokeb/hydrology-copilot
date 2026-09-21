import { describe, expect, it } from 'vitest';
import {
  fitGamma,
  gammaCdf,
  gammaFn,
  gammaLowerRegularized,
  linearRegression,
  mean,
  median,
  normalCdf,
  normalInv,
  pearson,
  quantile,
  rank,
  rollingSum,
  skewness,
  stdDev,
} from '../src/stats.js';

describe('descriptive statistics', () => {
  const x = [2, 4, 4, 4, 5, 5, 7, 9];

  it('computes the mean', () => {
    expect(mean(x)).toBe(5);
  });

  it('computes the sample standard deviation', () => {
    // population sd = 2, sample sd = 2 * sqrt(8/7)
    expect(stdDev(x, false)).toBeCloseTo(2, 10);
    expect(stdDev(x, true)).toBeCloseTo(2 * Math.sqrt(8 / 7), 10);
  });

  it('computes the median with an even sample size', () => {
    expect(median(x)).toBe(4.5);
  });

  it('uses linear interpolation for quantiles, matching numpy', () => {
    const s = [1, 2, 3, 4];
    expect(quantile(s, 0.25)).toBeCloseTo(1.75, 10);
    expect(quantile(s, 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile(s, 0.75)).toBeCloseTo(3.25, 10);
  });

  it('assigns average ranks to ties', () => {
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('computes skewness of a symmetric sample as zero', () => {
    expect(skewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 10);
  });
});

describe('correlation and regression', () => {
  it('gives r = 1 for a perfect positive linear relationship', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
  });

  it('gives r = -1 for a perfect negative relationship', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });

  it('recovers the generating slope and intercept', () => {
    const x = Array.from({ length: 50 }, (_, i) => i);
    const y = x.map((v) => 3.5 * v + 12);
    const r = linearRegression(x, y);
    expect(r.slope).toBeCloseTo(3.5, 10);
    expect(r.intercept).toBeCloseTo(12, 10);
    expect(r.r2).toBeCloseTo(1, 10);
  });
});

describe('distribution functions', () => {
  it('matches the analytic incomplete gamma for shape 1', () => {
    // P(1, x) = 1 - exp(-x)
    for (const x of [0.1, 0.5, 1, 2, 5, 10]) {
      expect(gammaLowerRegularized(1, x)).toBeCloseTo(1 - Math.exp(-x), 10);
    }
  });

  it('matches the analytic incomplete gamma for shape 2', () => {
    // P(2, x) = 1 - (1 + x) exp(-x)
    for (const x of [0.5, 1, 3, 8]) {
      expect(gammaLowerRegularized(2, x)).toBeCloseTo(1 - (1 + x) * Math.exp(-x), 10);
    }
  });

  it('computes the gamma function at known points', () => {
    expect(gammaFn(1)).toBeCloseTo(1, 10);
    expect(gammaFn(5)).toBeCloseTo(24, 8);
    expect(gammaFn(0.5)).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });

  it('computes the standard normal CDF at reference points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 10);
    expect(normalCdf(1.959963985)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.281551566)).toBeCloseTo(0.1, 6);
  });

  it('inverts the normal CDF to published critical values', () => {
    expect(normalInv(0.975)).toBeCloseTo(1.959963985, 8);
    expect(normalInv(0.95)).toBeCloseTo(1.644853627, 8);
    expect(normalInv(0.5)).toBeCloseTo(0, 10);
    expect(normalInv(0.01)).toBeCloseTo(-2.326347874, 8);
  });

  it('round-trips CDF and inverse CDF', () => {
    for (const p of [0.001, 0.05, 0.3, 0.5, 0.8, 0.999]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 8);
    }
  });
});

describe('gamma fitting', () => {
  it('recovers the shape and scale of a synthetic gamma sample', () => {
    // Deterministic sample from Gamma(shape=2, scale=3) via inverse-CDF search.
    const shape = 2;
    const scale = 3;
    const sample: number[] = [];
    for (let i = 1; i <= 400; i++) {
      const p = i / 401;
      // bisection on the CDF
      let lo = 0;
      let hi = 200;
      for (let k = 0; k < 80; k++) {
        const mid = (lo + hi) / 2;
        if (gammaCdf(mid, shape, scale) < p) lo = mid;
        else hi = mid;
      }
      sample.push((lo + hi) / 2);
    }
    const fit = fitGamma(sample);
    expect(fit.shape).toBeGreaterThan(1.7);
    expect(fit.shape).toBeLessThan(2.4);
    expect(fit.shape * fit.scale).toBeCloseTo(shape * scale, 0);
    expect(fit.zeroProbability).toBe(0);
  });

  it('reports the zero fraction for an intermittent record', () => {
    const fit = fitGamma([0, 0, 1, 2, 3, 4, 0, 5, 6, 7]);
    expect(fit.zeroProbability).toBeCloseTo(0.3, 10);
  });
});

describe('rolling windows', () => {
  it('leaves the first window-1 positions null', () => {
    expect(rollingSum([1, 2, 3, 4], 3)).toEqual([null, null, 6, 9]);
  });

  it('propagates missing data rather than silently ignoring it', () => {
    expect(rollingSum([1, null, 3, 4], 3)).toEqual([null, null, null, null]);
  });
});
