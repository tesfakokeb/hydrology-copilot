import { describe, expect, it } from 'vitest';
import {
  annualPeaks,
  bankfullProxy,
  baseflowSeparation,
  detectEvents,
  flowDurationCurve,
  flowExceededPercent,
  flowStatistics,
  sevenQTen,
  waterYear,
} from '../src/flow.js';
import { syntheticCatchment } from './fixtures.js';

const c = syntheticCatchment(35, 11);

describe('water year', () => {
  it('starts on 1 October', () => {
    expect(waterYear('2023-09-30')).toBe(2023);
    expect(waterYear('2023-10-01')).toBe(2024);
    expect(waterYear('2024-01-15')).toBe(2024);
  });
});

describe('flow-duration curve', () => {
  const fdc = flowDurationCurve(c.flowM3s);

  it('is monotonically decreasing in discharge', () => {
    for (let i = 1; i < fdc.length; i++) {
      expect(fdc[i].discharge).toBeLessThanOrEqual(fdc[i - 1].discharge);
    }
  });

  it('uses Weibull plotting positions strictly inside (0,1)', () => {
    expect(fdc[0].exceedanceProbability).toBeGreaterThan(0);
    expect(fdc[fdc.length - 1].exceedanceProbability).toBeLessThan(1);
  });

  it('orders Q95 below Q50 below Q10', () => {
    const q10 = flowExceededPercent(c.flowM3s, 10);
    const q50 = flowExceededPercent(c.flowM3s, 50);
    const q95 = flowExceededPercent(c.flowM3s, 95);
    expect(q95).toBeLessThan(q50);
    expect(q50).toBeLessThan(q10);
  });

  it('matches a hand-checked case', () => {
    // Q50 of [1..9] exceeded 50 % of the time is the median, 5.
    expect(flowExceededPercent([1, 2, 3, 4, 5, 6, 7, 8, 9], 50)).toBeCloseTo(5, 10);
  });
});

describe('baseflow separation', () => {
  it('returns BFI = 1 for a perfectly constant flow', () => {
    const constant = new Array(365).fill(10);
    const { bfi } = baseflowSeparation(constant);
    expect(bfi).toBeCloseTo(1, 6);
  });

  it('keeps baseflow at or below total flow everywhere', () => {
    const { baseflow } = baseflowSeparation(c.flowM3s);
    baseflow.forEach((b, i) => {
      if (b !== null) {
        expect(b).toBeLessThanOrEqual(c.flowM3s[i] + 1e-9);
        expect(b).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('gives a BFI inside the physically meaningful range', () => {
    const { bfi } = baseflowSeparation(c.flowM3s);
    expect(bfi).toBeGreaterThan(0.2);
    expect(bfi).toBeLessThanOrEqual(1);
  });

  it('declines to estimate from a short record', () => {
    expect(baseflowSeparation([1, 2, 3]).bfi).toBeNull();
  });
});

describe('annual peaks', () => {
  const peaks = annualPeaks(c.dates, c.flowM3s);

  it('produces one peak per water year', () => {
    expect(peaks.length).toBeGreaterThan(30);
    const years = new Set(peaks.map((p) => p.waterYear));
    expect(years.size).toBe(peaks.length);
  });

  it('is sorted by water year', () => {
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i].waterYear).toBeGreaterThan(peaks[i - 1].waterYear);
    }
  });

  it('each peak is the maximum within its water year', () => {
    const p = peaks[5];
    const inYear = c.dates
      .map((d, i) => ({ d, v: c.flowM3s[i] }))
      .filter((r) => waterYear(r.d) === p.waterYear)
      .map((r) => r.v);
    expect(p.peak).toBeCloseTo(Math.max(...inYear), 6);
  });
});

describe('7Q10 low-flow statistic', () => {
  it('is positive and below the median flow', () => {
    const v = sevenQTen(c.dates, c.flowM3s);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0);
    expect(v!).toBeLessThan(flowExceededPercent(c.flowM3s, 50));
  });

  it('returns null when fewer than 10 water years are available', () => {
    const short = { d: c.dates.slice(0, 900), v: c.flowM3s.slice(0, 900) };
    expect(sevenQTen(short.d, short.v)).toBeNull();
  });
});

describe('event detection', () => {
  it('finds a single event and its peak', () => {
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05'];
    const values = [1, 12, 30, 8, 1];
    const ev = detectEvents(dates, values, 10, 0);
    expect(ev).toHaveLength(1);
    expect(ev[0].start).toBe('2020-01-02');
    expect(ev[0].end).toBe('2020-01-03');
    expect(ev[0].peak).toBe(30);
    expect(ev[0].peakDate).toBe('2020-01-03');
  });

  it('merges events separated by less than the minimum separation', () => {
    const dates = Array.from({ length: 8 }, (_, i) => `2020-01-0${i + 1}`);
    const values = [20, 1, 20, 1, 1, 1, 1, 1];
    expect(detectEvents(dates, values, 10, 3)).toHaveLength(1);
    expect(detectEvents(dates, values, 10, 0)).toHaveLength(2);
  });
});

describe('flow statistics', () => {
  const stats = flowStatistics({ dates: c.dates, values: c.flowM3s, unit: 'm3/s' });

  it('reports the record extent and completeness', () => {
    expect(stats.count).toBe(c.flowM3s.length);
    expect(stats.missing).toBe(0);
    expect(stats.startDate).toBe(c.dates[0]);
    expect(stats.endDate).toBe(c.dates[c.dates.length - 1]);
    expect(stats.unit).toBe('m3/s');
  });

  it('orders min <= median <= mean-ish <= max for a right-skewed record', () => {
    expect(stats.min).toBeLessThanOrEqual(stats.median);
    expect(stats.median).toBeLessThanOrEqual(stats.max);
    expect(stats.skew).toBeGreaterThan(0);
  });

  it('includes the standard flow-duration percentiles', () => {
    for (const k of ['Q1', 'Q10', 'Q50', 'Q90', 'Q99']) {
      expect(stats.flowDuration[k]).toBeGreaterThan(0);
    }
  });
});

describe('bankfull proxy', () => {
  it('declines to estimate from a short peak record', () => {
    const r = bankfullProxy([{ peak: 10 }, { peak: 20 }]);
    expect(r.discharge).toBeNull();
    expect(r.basis).toContain('Insufficient');
  });

  it('labels itself as an approximation, never a survey', () => {
    const peaks = annualPeaks(c.dates, c.flowM3s);
    const r = bankfullProxy(peaks);
    expect(r.discharge).toBeGreaterThan(0);
    expect(r.basis).toContain('Not a surveyed bankfull stage');
  });
});
