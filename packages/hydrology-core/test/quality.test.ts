import { describe, expect, it } from 'vitest';
import type { QualityObservation } from '../src/quality.js';
import {
  ccmeWqi,
  DEFAULT_THRESHOLDS,
  detectQualityAnomalies,
  isExceedance,
  mannKendall,
  parameterCorrelations,
  rateWqi,
  seasonalMannKendall,
} from '../src/quality.js';

const th = (p: string) => DEFAULT_THRESHOLDS.find((t) => t.parameter === p)!;

describe('threshold evaluation', () => {
  it('flags a maximum-type exceedance', () => {
    expect(isExceedance(12, th('nitrate'))).toBe(true);
    expect(isExceedance(8, th('nitrate'))).toBe(false);
  });

  it('flags a minimum-type exceedance (dissolved oxygen)', () => {
    expect(isExceedance(3.5, th('dissolved_oxygen'))).toBe(true);
    expect(isExceedance(8.0, th('dissolved_oxygen'))).toBe(false);
  });

  it('flags both ends of a range criterion (pH)', () => {
    expect(isExceedance(5.9, th('ph'))).toBe(true);
    expect(isExceedance(9.1, th('ph'))).toBe(true);
    expect(isExceedance(7.2, th('ph'))).toBe(false);
  });
});

describe('CCME Water Quality Index', () => {
  it('returns 100 when nothing exceeds a criterion', () => {
    const obs: QualityObservation[] = [];
    for (let i = 0; i < 30; i++) {
      obs.push({ t: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, parameter: 'nitrate', value: 1 });
      obs.push({ t: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, parameter: 'dissolved_oxygen', value: 9 });
    }
    const r = ccmeWqi(obs);
    expect(r.wqi).toBeCloseTo(100, 6);
    expect(r.rating).toBe('Excellent');
    expect(r.f1Scope).toBe(0);
    expect(r.f2Frequency).toBe(0);
    expect(r.f3Amplitude).toBe(0);
  });

  it('drops sharply when every test fails badly', () => {
    const obs: QualityObservation[] = Array.from({ length: 20 }, (_, i) => ({
      t: `2024-02-${String(i + 1).padStart(2, '0')}`,
      parameter: 'nitrate' as const,
      value: 100,
    }));
    const r = ccmeWqi(obs);
    expect(r.wqi).toBeLessThan(45);
    expect(r.rating).toBe('Poor');
    expect(r.f1Scope).toBe(100);
    expect(r.f2Frequency).toBe(100);
  });

  it('reports per-parameter exceedance counts', () => {
    const obs: QualityObservation[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ t: `2024-03-0${(i % 9) + 1}`, parameter: 'nitrate' as const, value: i < 3 ? 20 : 2 })),
      ...Array.from({ length: 10 }, (_, i) => ({ t: `2024-03-0${(i % 9) + 1}`, parameter: 'ph' as const, value: 7.1 })),
    ];
    const r = ccmeWqi(obs);
    const nitrate = r.exceedances.find((e) => e.parameter === 'nitrate')!;
    expect(nitrate.count).toBe(3);
    expect(nitrate.total).toBe(10);
    expect(nitrate.pct).toBeCloseTo(30, 6);
    expect(r.parametersUsed.sort()).toEqual(['nitrate', 'ph']);
  });

  it('reports the period covered', () => {
    const r = ccmeWqi([
      { t: '2024-01-01', parameter: 'ph', value: 7 },
      { t: '2024-06-30', parameter: 'ph', value: 7 },
    ]);
    expect(r.period.start).toBe('2024-01-01');
    expect(r.period.end).toBe('2024-06-30');
  });

  it('does not fabricate a score from an empty record', () => {
    const r = ccmeWqi([]);
    expect(Number.isNaN(r.wqi)).toBe(true);
    expect(r.parametersUsed).toHaveLength(0);
  });

  it('applies the published rating bands', () => {
    expect(rateWqi(96)).toBe('Excellent');
    expect(rateWqi(85)).toBe('Good');
    expect(rateWqi(70)).toBe('Fair');
    expect(rateWqi(50)).toBe('Marginal');
    expect(rateWqi(20)).toBe('Poor');
  });
});

describe('Mann–Kendall trend test', () => {
  it('detects a strong monotonic increase', () => {
    const t = Array.from({ length: 40 }, (_, i) => i / 12);
    const v = t.map((x) => 2 + 0.5 * x);
    const r = mannKendall(t, v, 0.05, 'mg/L per year');
    expect(r.direction).toBe('increasing');
    expect(r.significant).toBe(true);
    expect(r.tau).toBeCloseTo(1, 6);
    expect(r.slopePerYear).toBeCloseTo(0.5, 6);
    expect(r.pValue).toBeLessThan(0.001);
  });

  it('detects a monotonic decrease', () => {
    const t = Array.from({ length: 40 }, (_, i) => i / 12);
    const v = t.map((x) => 10 - 0.8 * x);
    const r = mannKendall(t, v);
    expect(r.direction).toBe('decreasing');
    expect(r.slopePerYear).toBeCloseTo(-0.8, 6);
  });

  it('reports no trend for an alternating series', () => {
    const t = Array.from({ length: 40 }, (_, i) => i / 12);
    const v = t.map((_, i) => (i % 2 === 0 ? 5 : 6));
    const r = mannKendall(t, v);
    expect(r.direction).toBe('no trend');
    expect(r.significant).toBe(false);
  });

  it('declines to test a series shorter than 8 points', () => {
    const r = mannKendall([1, 2, 3], [1, 2, 3]);
    expect(r.n).toBe(3);
    expect(Number.isNaN(r.pValue)).toBe(true);
    expect(r.significant).toBe(false);
  });

  it('is robust to a single extreme outlier, unlike OLS', () => {
    const t = Array.from({ length: 30 }, (_, i) => i / 12);
    const v = t.map((x) => 2 + 0.3 * x);
    v[15] = 500;
    const r = mannKendall(t, v);
    expect(r.slopePerYear).toBeCloseTo(0.3, 4);
  });
});

describe('seasonal Mann–Kendall', () => {
  it('recovers a trend hidden under a strong seasonal cycle', () => {
    const months: number[] = [];
    const times: number[] = [];
    const values: number[] = [];
    for (let y = 0; y < 12; y++) {
      for (let m = 1; m <= 12; m++) {
        months.push(m);
        const t = y + (m - 1) / 12;
        times.push(t);
        values.push(10 + 6 * Math.sin((2 * Math.PI * m) / 12) + 0.4 * t);
      }
    }
    const r = seasonalMannKendall(months, times, values);
    expect(r.direction).toBe('increasing');
    expect(r.significant).toBe(true);
    expect(r.slopePerYear).toBeCloseTo(0.4, 2);
  });
});

describe('anomaly detection', () => {
  it('flags an implausible spike', () => {
    const obs: QualityObservation[] = Array.from({ length: 40 }, (_, i) => ({
      t: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
      parameter: 'turbidity' as const,
      value: 5 + (i % 3),
    }));
    obs[20] = { t: '2024-01-21', parameter: 'turbidity', value: 900 };
    const anomalies = detectQualityAnomalies(obs);
    expect(anomalies.some((a) => a.value === 900)).toBe(true);
    expect(anomalies.find((a) => a.value === 900)!.severity).toBe('extreme');
  });

  it('does not flag a well-behaved record', () => {
    const obs: QualityObservation[] = Array.from({ length: 40 }, (_, i) => ({
      t: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
      parameter: 'ph' as const,
      value: 7 + Math.sin(i) * 0.2,
    }));
    expect(detectQualityAnomalies(obs)).toHaveLength(0);
  });

  it('declines to run on fewer than 12 samples', () => {
    const obs: QualityObservation[] = Array.from({ length: 6 }, (_, i) => ({
      t: `2024-01-0${i + 1}`,
      parameter: 'ph' as const,
      value: i === 3 ? 99 : 7,
    }));
    expect(detectQualityAnomalies(obs)).toHaveLength(0);
  });
});

describe('parameter correlations', () => {
  it('finds a strong negative rank correlation between paired parameters', () => {
    const obs: QualityObservation[] = [];
    for (let i = 0; i < 30; i++) {
      const t = `2024-04-${String((i % 30) + 1).padStart(2, '0')}`;
      obs.push({ t, parameter: 'temperature', value: 10 + i * 0.5 });
      obs.push({ t, parameter: 'dissolved_oxygen', value: 12 - i * 0.15 });
    }
    const corr = parameterCorrelations(obs);
    expect(corr[0].rho).toBeLessThan(-0.9);
    expect(corr[0].n).toBe(30);
  });
});
