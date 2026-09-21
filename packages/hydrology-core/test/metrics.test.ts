import { describe, expect, it } from 'vitest';
import { bias, evaluate, kge, mae, mape, nse, pbias, peakErrorPct, ratePerformance, rmse, volumeErrorPct } from '../src/metrics.js';
import { mean } from '../src/stats.js';

const obs = [10, 12, 15, 20, 35, 60, 45, 30, 22, 18, 15, 12];

describe('Nash–Sutcliffe efficiency', () => {
  it('is exactly 1 for a perfect simulation', () => {
    expect(nse(obs, obs)).toBeCloseTo(1, 12);
  });

  it('is exactly 0 when the simulation equals the observed mean', () => {
    const m = mean(obs);
    expect(nse(obs, obs.map(() => m))).toBeCloseTo(0, 12);
  });

  it('is negative when the simulation is worse than the mean', () => {
    expect(nse(obs, obs.map(() => 0))).toBeLessThan(0);
  });

  it('matches a hand-computed value', () => {
    const o = [1, 2, 3, 4];
    const s = [1.1, 1.9, 3.2, 3.8];
    // SSE = 0.01 + 0.01 + 0.04 + 0.04 = 0.10 ; SST = 2.25+0.25+0.25+2.25 = 5
    expect(nse(o, s)).toBeCloseTo(1 - 0.1 / 5, 10);
  });
});

describe('Kling–Gupta efficiency', () => {
  it('is 1 with r = alpha = beta = 1', () => {
    const k = kge(obs, obs);
    expect(k.kge).toBeCloseTo(1, 12);
    expect(k.r).toBeCloseTo(1, 12);
    expect(k.alpha).toBeCloseTo(1, 12);
    expect(k.beta).toBeCloseTo(1, 12);
  });

  it('decomposes a pure bias error correctly', () => {
    const sim = obs.map((v) => v * 1.2);
    const k = kge(obs, sim);
    expect(k.r).toBeCloseTo(1, 10);
    expect(k.alpha).toBeCloseTo(1.2, 10);
    expect(k.beta).toBeCloseTo(1.2, 10);
    expect(k.kge).toBeCloseTo(1 - Math.sqrt(0.04 + 0.04), 10);
  });
});

describe('error magnitude metrics', () => {
  const o = [1, 2, 3, 4];
  const s = [2, 3, 4, 5];

  it('computes RMSE', () => {
    expect(rmse(o, s)).toBeCloseTo(1, 12);
  });

  it('computes MAE', () => {
    expect(mae(o, s)).toBeCloseTo(1, 12);
  });

  it('computes bias as the difference of means', () => {
    expect(bias(o, s)).toBeCloseTo(1, 12);
  });

  it('computes PBIAS as a percentage of observed volume', () => {
    // sum(sim - obs) = 4 ; sum(obs) = 10 -> 40 %
    expect(pbias(o, s)).toBeCloseTo(40, 10);
  });

  it('computes MAPE and skips zero observations', () => {
    expect(mape([0, 2, 4], [1, 3, 5])).toBeCloseTo(((1 / 2 + 1 / 4) / 2) * 100, 10);
  });
});

describe('hydrograph-specific errors', () => {
  it('computes peak error', () => {
    expect(peakErrorPct([10, 50, 20], [10, 45, 20])).toBeCloseTo(-10, 10);
  });

  it('computes volume error', () => {
    expect(volumeErrorPct([10, 10, 10], [11, 11, 11])).toBeCloseTo(10, 10);
  });
});

describe('metric suite', () => {
  it('handles missing values by pairwise deletion', () => {
    const m = evaluate([1, null, 3, 4], [1, 2, 3, null]);
    expect(m.n).toBe(2);
  });

  it('returns nulls rather than NaN when there is no usable data', () => {
    const m = evaluate([], []);
    expect(m.nse).toBeNull();
    expect(m.n).toBe(0);
  });

  it('reports a full suite for a realistic simulation', () => {
    const sim = obs.map((v, i) => v * 0.95 + (i % 3) - 1);
    const m = evaluate(obs, sim);
    expect(m.nse).toBeGreaterThan(0.9);
    expect(m.kge).toBeGreaterThan(0.8);
    expect(m.n).toBe(obs.length);
  });
});

describe('performance rating', () => {
  it('flags insufficient data rather than guessing', () => {
    expect(ratePerformance(evaluate([1, 2], [1, 2])).overall).toBe('insufficient data');
  });

  it('rates a near-perfect simulation as very good', () => {
    const o = Array.from({ length: 100 }, (_, i) => 10 + 5 * Math.sin(i / 5));
    const s = o.map((v) => v * 1.005);
    expect(ratePerformance(evaluate(o, s)).overall).toBe('very good');
  });

  it('rates a heavily biased simulation as unsatisfactory', () => {
    const o = Array.from({ length: 100 }, (_, i) => 10 + 5 * Math.sin(i / 5));
    const s = o.map((v) => v * 1.6);
    expect(ratePerformance(evaluate(o, s)).overall).toBe('unsatisfactory');
  });
});
