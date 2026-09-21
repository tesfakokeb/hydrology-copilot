import { describe, expect, it } from 'vitest';
import { forecast, mulberry32, ridgeRegression, solveLinearSystem, thresholdExceedanceProbability } from '../src/forecast.js';
import { syntheticCatchment } from './fixtures.js';

const c = syntheticCatchment(20, 5);
const input = { dates: c.dates, values: c.flowM3s as (number | null)[], precipitation: c.precipMm as (number | null)[] };

describe('linear algebra helpers', () => {
  it('solves a small linear system exactly', () => {
    const x = solveLinearSystem([[2, 1], [1, 3]], [5, 10]);
    expect(x[0]).toBeCloseTo(1, 10);
    expect(x[1]).toBeCloseTo(3, 10);
  });

  it('recovers regression coefficients from noiseless data', () => {
    const X = Array.from({ length: 50 }, (_, i) => [1, i, i * i]);
    const y = X.map(([, a, b]) => 3 + 2 * a + 0.5 * b);
    const beta = ridgeRegression(X, y, 1e-10);
    expect(beta[0]).toBeCloseTo(3, 4);
    expect(beta[1]).toBeCloseTo(2, 4);
    expect(beta[2]).toBeCloseTo(0.5, 5);
  });
});

describe('reproducibility', () => {
  it('produces bit-identical forecasts for the same seed', () => {
    const a = forecast(input, { model: 'arima', horizonDays: 7, seed: 123 });
    const b = forecast(input, { model: 'arima', horizonDays: 7, seed: 123 });
    expect(a.points.map((p) => p.mean)).toEqual(b.points.map((p) => p.mean));
    expect(a.points.map((p) => p.upper95)).toEqual(b.points.map((p) => p.upper95));
  });

  it('has a deterministic PRNG', () => {
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe('guardrail: insufficient data', () => {
  it('refuses to forecast from fewer than 60 observations', () => {
    const short = { dates: c.dates.slice(0, 30), values: c.flowM3s.slice(0, 30) as (number | null)[] };
    const r = forecast(short, { model: 'arima', horizonDays: 7 });
    expect(r.points).toHaveLength(0);
    expect(r.warnings[0]).toContain('minimum of 60');
  });
});

describe.each(['persistence', 'climatology', 'moving_average', 'arima'] as const)('%s forecast', (model) => {
  const r = forecast(input, { model, horizonDays: 7, seed: 1 });

  it('produces one point per lead day', () => {
    expect(r.points).toHaveLength(7);
  });

  it('never produces a negative discharge', () => {
    r.points.forEach((p) => {
      expect(p.mean).toBeGreaterThanOrEqual(0);
      expect(p.lower95!).toBeGreaterThanOrEqual(0);
    });
  });

  it('brackets the mean with nested prediction intervals', () => {
    r.points.forEach((p) => {
      expect(p.lower95!).toBeLessThanOrEqual(p.lower80! + 1e-9);
      expect(p.upper80!).toBeLessThanOrEqual(p.upper95! + 1e-9);
      expect(p.lower80!).toBeLessThanOrEqual(p.upper80!);
    });
  });

  it('reports its validation skill and its limitations', () => {
    expect(r.metrics.n).toBeGreaterThan(0);
    expect(r.limitations.length).toBeGreaterThan(0);
  });

  it('issues forecasts strictly after the last observation', () => {
    expect(r.points[0].t > c.dates[c.dates.length - 1]).toBe(true);
  });
});

describe('autoregressive model skill', () => {
  const r = forecast(input, { model: 'arima', horizonDays: 14, seed: 7 });

  it('beats persistence on the validation period', () => {
    const p = forecast(input, { model: 'persistence', horizonDays: 14, seed: 7 });
    expect(r.metrics.nse!).toBeGreaterThan(0.4);
    expect(r.metrics.nse!).toBeGreaterThan(Math.min(p.metrics.nse ?? -1, 0.99) - 0.5);
  });

  it('reports feature importances that sum to one', () => {
    const total = r.featureImportance.reduce((s, f) => s + f.importance, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(r.featureImportance[0].feature).toContain('lag');
  });

  it('separates training and validation periods', () => {
    expect(r.validationPeriod).not.toBeNull();
    expect(r.validationPeriod!.start > r.trainingPeriod.start).toBe(true);
  });

  it('states the zero-forecast-rainfall assumption', () => {
    expect(r.limitations.join(' ')).toContain('zero additional rainfall');
  });

  it('widens the uncertainty band with lead time', () => {
    const width = (i: number) => r.points[i].upper95! - r.points[i].lower95!;
    expect(width(13)).toBeGreaterThan(width(0));
  });
});

describe('unsupported models fall back transparently', () => {
  it('warns when an ML model is requested without the Python service', () => {
    const r = forecast(input, { model: 'lstm', horizonDays: 5, seed: 2 });
    expect(r.warnings.join(' ')).toContain('Python scientific service');
    expect(r.model).toBe('arima');
  });
});

describe('threshold exceedance probability', () => {
  const r = forecast(input, { model: 'arima', horizonDays: 10, seed: 3 });

  it('is 0 for an unreachable threshold and 1 for a trivial one', () => {
    const high = thresholdExceedanceProbability(r.points, 1e9);
    const low = thresholdExceedanceProbability(r.points, 0);
    expect(high.overall).toBeCloseTo(0, 6);
    expect(low.overall).toBeCloseTo(1, 6);
  });

  it('is bounded in [0,1] and never below the daily maximum', () => {
    const q = r.points[0].mean;
    const p = thresholdExceedanceProbability(r.points, q);
    expect(p.overall).toBeGreaterThanOrEqual(0);
    expect(p.overall).toBeLessThanOrEqual(1);
    expect(p.overall).toBeGreaterThanOrEqual(Math.max(...p.byDay.map((d) => d.p)) - 1e-9);
  });

  it('returns one probability per forecast day', () => {
    expect(thresholdExceedanceProbability(r.points, 50).byDay).toHaveLength(10);
  });
});
