import { describe, expect, it } from 'vitest';
import {
  calculateSpei,
  calculateSpi,
  classifyIndex,
  extraterrestrialRadiation,
  hargreavesPet,
  identifyDroughtEvents,
  toMonthly,
} from '../src/drought.js';
import { mean, stdDev } from '../src/stats.js';
import { syntheticCatchment } from './fixtures.js';

const catchment = syntheticCatchment(40, 7);
const monthlyPrecip = toMonthly(catchment.dates, catchment.precipMm, 'sum');

describe('drought classification', () => {
  it('applies the US Drought Monitor breakpoints', () => {
    expect(classifyIndex(-2.5).category).toBe('D4');
    expect(classifyIndex(-2.0).category).toBe('D4');
    expect(classifyIndex(-1.7).category).toBe('D3');
    expect(classifyIndex(-1.4).category).toBe('D2');
    expect(classifyIndex(-1.0).category).toBe('D1');
    expect(classifyIndex(-0.6).category).toBe('D0');
    expect(classifyIndex(0).category).toBe('Normal');
    expect(classifyIndex(1.0).category).toBe('W1');
    expect(classifyIndex(2.5).category).toBe('W4');
  });

  it('does not invent a category when the index is missing', () => {
    expect(classifyIndex(null).label).toBe('Insufficient data');
  });
});

describe('monthly aggregation', () => {
  it('produces one value per calendar month', () => {
    expect(monthlyPrecip.months.length).toBeGreaterThan(400);
    expect(monthlyPrecip.months[0]).toMatch(/^\d{4}-\d{2}$/);
    expect(monthlyPrecip.values.length).toBe(monthlyPrecip.months.length);
  });

  it('returns null for months below the coverage threshold', () => {
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03'];
    const r = toMonthly(dates, [1, 2, 3], 'sum', 80);
    expect(r.values[0]).toBeNull();
  });
});

describe('Standardized Precipitation Index', () => {
  const spi3 = calculateSpi(monthlyPrecip, { timescaleMonths: 3 });
  const values = spi3.values.filter((v): v is number => v !== null);

  it('leaves the first (timescale - 1) months undefined', () => {
    expect(spi3.values[0]).toBeNull();
    expect(spi3.values[1]).toBeNull();
    expect(spi3.values[2]).not.toBeNull();
  });

  it('is standard normal by construction: mean near 0, sd near 1', () => {
    expect(Math.abs(mean(values))).toBeLessThan(0.15);
    expect(stdDev(values)).toBeGreaterThan(0.85);
    expect(stdDev(values)).toBeLessThan(1.15);
  });

  it('is bounded by the conventional +/-3.09 truncation', () => {
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-3.09);
    expect(Math.max(...values)).toBeLessThanOrEqual(3.09);
  });

  it('produces roughly the expected fraction of drought months', () => {
    // Under a correct standardisation, P(SPI <= -0.8) ≈ 0.212
    const frac = values.filter((v) => v <= -0.8).length / values.length;
    expect(frac).toBeGreaterThan(0.13);
    expect(frac).toBeLessThan(0.30);
  });

  it('records the distribution and calibration period used', () => {
    expect(spi3.distribution).toContain('gamma');
    expect(spi3.calibrationStart).toBe(monthlyPrecip.months[0]);
  });

  it('assigns a category to every computed value', () => {
    spi3.values.forEach((v, i) => {
      if (v !== null) expect(spi3.categories[i]).toBe(classifyIndex(v).category);
    });
  });

  it('longer accumulation windows give a smoother index', () => {
    const spi12 = calculateSpi(monthlyPrecip, { timescaleMonths: 12 });
    const diff = (arr: (number | null)[]) => {
      const v = arr.filter((x): x is number => x !== null);
      let s = 0;
      for (let i = 1; i < v.length; i++) s += Math.abs(v[i] - v[i - 1]);
      return s / (v.length - 1);
    };
    expect(diff(spi12.values)).toBeLessThan(diff(spi3.values));
  });

  it('warns when the calibration record is short', () => {
    const short = { months: monthlyPrecip.months.slice(0, 24), values: monthlyPrecip.values.slice(0, 24) };
    const r = calculateSpi(short, { timescaleMonths: 3 });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toContain('provisional');
  });
});

describe('Standardized Precipitation-Evapotranspiration Index', () => {
  it('is standardised and responds to the water balance', () => {
    const pet: number[] = catchment.dates.map((d, i) => {
      const doy = Math.floor((Date.parse(d + 'T00:00:00Z') - Date.UTC(Number(d.slice(0, 4)), 0, 1)) / 86400000) + 1;
      return hargreavesPet(catchment.tmaxC[i], catchment.tminC[i], catchment.latitude, doy);
    });
    const monthlyPet = toMonthly(catchment.dates, pet, 'sum');
    const spei = calculateSpei(monthlyPrecip, monthlyPet, { timescaleMonths: 6 });
    const v = spei.values.filter((x): x is number => x !== null);
    expect(v.length).toBeGreaterThan(300);
    expect(Math.abs(mean(v))).toBeLessThan(0.25);
    expect(stdDev(v)).toBeGreaterThan(0.7);
    expect(stdDev(v)).toBeLessThan(1.4);
    expect(spei.distribution).toContain('log-logistic');
  });
});

describe('Hargreaves reference evapotranspiration', () => {
  it('gives physically plausible summer and winter values at mid-latitude', () => {
    const summer = hargreavesPet(30, 18, 39.3, 182);
    const winter = hargreavesPet(6, -2, 39.3, 15);
    expect(summer).toBeGreaterThan(3);
    expect(summer).toBeLessThan(9);
    expect(winter).toBeGreaterThanOrEqual(0);
    expect(winter).toBeLessThan(2);
    expect(summer).toBeGreaterThan(winter);
  });

  it('never returns a negative value', () => {
    expect(hargreavesPet(-5, -5, 60, 1)).toBeGreaterThanOrEqual(0);
  });

  it('computes extraterrestrial radiation close to the FAO-56 table', () => {
    // FAO-56 Table: Ra at 40 deg N, mid-July ≈ 41.5 MJ m-2 d-1
    expect(extraterrestrialRadiation(40, 196)).toBeGreaterThan(38);
    expect(extraterrestrialRadiation(40, 196)).toBeLessThan(43);
    // Mid-January at 40 deg N ≈ 13.9
    expect(extraterrestrialRadiation(40, 15)).toBeGreaterThan(11);
    expect(extraterrestrialRadiation(40, 15)).toBeLessThan(17);
  });

  it('is symmetric about the equator on the equinox', () => {
    const north = extraterrestrialRadiation(30, 80);
    const south = extraterrestrialRadiation(-30, 80);
    expect(Math.abs(north - south)).toBeLessThan(1.5);
  });
});

describe('drought event identification', () => {
  it('finds contiguous runs below the threshold', () => {
    const months = ['2020-01', '2020-02', '2020-03', '2020-04', '2020-05', '2020-06'];
    const values = [0.2, -1.0, -1.5, -0.9, 0.4, -1.2];
    const events = identifyDroughtEvents(months, values, -0.8);
    expect(events).toHaveLength(2);
    expect(events[0].start).toBe('2020-02');
    expect(events[0].end).toBe('2020-04');
    expect(events[0].durationMonths).toBe(3);
    expect(events[0].severity).toBeCloseTo(3.4, 6);
    expect(events[0].peakIntensity).toBeCloseTo(-1.5, 6);
    expect(events[0].peakCategory).toBe('D2');
  });

  it('closes an event that runs to the end of the record', () => {
    const events = identifyDroughtEvents(['2020-01', '2020-02'], [-1, -2], -0.8);
    expect(events).toHaveLength(1);
    expect(events[0].end).toBe('2020-02');
  });
});
