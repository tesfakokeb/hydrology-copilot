import { describe, expect, it } from 'vitest';
import { annualPeaks } from '../src/flow.js';
import {
  classifyHazard,
  encounterProbability,
  estimateReturnPeriod,
  gevLMoments,
  logPearson3,
  REGULATORY_DISCLAIMER,
  wilsonHilfertyK,
} from '../src/flood.js';
import { normalInv } from '../src/stats.js';
import { syntheticCatchment } from './fixtures.js';

const c = syntheticCatchment(45, 3);
const peaks = annualPeaks(c.dates, c.flowM3s);

describe('Wilson–Hilferty frequency factor', () => {
  it('reduces to the standard normal deviate at zero skew', () => {
    for (const p of [0.5, 0.9, 0.99, 0.995]) {
      expect(wilsonHilfertyK(p, 0)).toBeCloseTo(normalInv(p), 8);
    }
  });

  it('matches published Bulletin 17B K values for positive skew', () => {
    // Bulletin 17B Appendix 3 tabulates K from the exact Pearson III quantile.
    // Wilson–Hilferty is the standard approximation to it and agrees to about
    // 0.01 in K for |G| <= 1, which is the tolerance asserted here.
    expect(Math.abs(wilsonHilfertyK(0.99, 0.4) - 2.615)).toBeLessThan(0.012);
    expect(Math.abs(wilsonHilfertyK(0.99, 0.8) - 2.891)).toBeLessThan(0.012);
    expect(Math.abs(wilsonHilfertyK(0.99, -0.4) - 2.029)).toBeLessThan(0.012);
  });
});

describe('log-Pearson III flood frequency', () => {
  const r = logPearson3(peaks, 'm3/s');

  it('produces increasing quantiles with return period', () => {
    for (let i = 1; i < r.quantiles.length; i++) {
      expect(r.quantiles[i].discharge).toBeGreaterThan(r.quantiles[i - 1].discharge);
    }
  });

  it('reports annual exceedance probability consistent with return period', () => {
    for (const q of r.quantiles) {
      expect(q.annualExceedanceProbability).toBeCloseTo(1 / q.returnPeriodYears, 10);
    }
  });

  it('brackets each quantile with a confidence interval', () => {
    for (const q of r.quantiles) {
      expect(q.lower95!).toBeLessThan(q.discharge);
      expect(q.upper95!).toBeGreaterThan(q.discharge);
    }
  });

  it('places the 2-year quantile near the median annual peak', () => {
    const sorted = peaks.map((p) => p.peak).sort((a, b) => a - b);
    const medianPeak = sorted[Math.floor(sorted.length / 2)];
    const q2 = r.quantiles.find((q) => q.returnPeriodYears === 2)!.discharge;
    expect(q2 / medianPeak).toBeGreaterThan(0.75);
    expect(q2 / medianPeak).toBeLessThan(1.35);
  });

  it('refuses to fit a record shorter than 10 water years', () => {
    const short = logPearson3(peaks.slice(0, 6), 'm3/s');
    expect(short.quantiles).toHaveLength(0);
    expect(short.notes[0]).toContain('at least 10 years');
  });

  it('states that it is not a regulatory determination', () => {
    expect(r.notes.join(' ')).toContain('Not a regulatory flood-frequency determination');
  });

  it('applies Bulletin 17B skew weighting when a regional skew is supplied', () => {
    const weighted = logPearson3(peaks, 'm3/s', { regionalSkew: 0.3 });
    expect(weighted.skewOption).toBe('weighted');
    expect(weighted.notes.join(' ')).toContain('regional skew');
  });
});

describe('GEV by L-moments', () => {
  it('produces increasing quantiles and reports its parameters', () => {
    const g = gevLMoments(peaks.map((p) => p.peak), 'm3/s');
    for (let i = 1; i < g.quantiles.length; i++) {
      expect(g.quantiles[i].discharge).toBeGreaterThan(g.quantiles[i - 1].discharge);
    }
    expect(g.notes[0]).toContain('Shape k');
  });

  it('lands within a factor of two of the LP3 100-year estimate', () => {
    const lp3 = logPearson3(peaks, 'm3/s').quantiles.find((q) => q.returnPeriodYears === 100)!.discharge;
    const gev = gevLMoments(peaks.map((p) => p.peak), 'm3/s').quantiles.find((q) => q.returnPeriodYears === 100)!.discharge;
    expect(gev / lp3).toBeGreaterThan(0.5);
    expect(gev / lp3).toBeLessThan(2.0);
  });
});

describe('empirical return period', () => {
  it('gives the largest observed peak a return period of about n+1', () => {
    const values = peaks.map((p) => p.peak);
    const max = Math.max(...values);
    const r = estimateReturnPeriod(values, max);
    expect(r.returnPeriodYears).toBeCloseTo(values.length + 1, 6);
  });

  it('refuses to extrapolate from a short record', () => {
    expect(estimateReturnPeriod([1, 2, 3], 5).returnPeriodYears).toBeNull();
  });

  it('warns about extrapolation beyond the record', () => {
    const r = estimateReturnPeriod(peaks.map((p) => p.peak), 1);
    expect(r.method).toContain('Extrapolation beyond');
  });
});

describe('hazard classification', () => {
  it('classifies by depth and depth-velocity product', () => {
    expect(classifyHazard(0.1, 0.2)).toBe('low');
    expect(classifyHazard(0.4, 0.5)).toBe('moderate');
    expect(classifyHazard(0.8, 0.5)).toBe('high');
    expect(classifyHazard(1.5, 0.5)).toBe('extreme');
    expect(classifyHazard(0.4, 3.5)).toBe('extreme');
  });

  it('handles a missing velocity by falling back to depth alone', () => {
    expect(classifyHazard(0.7, null)).toBe('high');
  });
});

describe('encounter probability', () => {
  it('matches the textbook 1 - (1 - 1/T)^n formula', () => {
    // 100-year flood over a 30-year mortgage ≈ 26 %
    expect(encounterProbability(100, 30)).toBeCloseTo(1 - 0.99 ** 30, 12);
    expect(encounterProbability(100, 30)).toBeGreaterThan(0.25);
    expect(encounterProbability(100, 30)).toBeLessThan(0.27);
  });
});

describe('regulatory disclaimer', () => {
  it('explicitly disclaims FEMA products', () => {
    expect(REGULATORY_DISCLAIMER.join(' ')).toContain('FEMA');
    expect(REGULATORY_DISCLAIMER.join(' ')).toContain('Base Flood Elevations');
  });
});
