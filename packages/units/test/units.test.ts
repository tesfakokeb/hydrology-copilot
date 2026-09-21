import { describe, expect, it } from 'vitest';
import {
  convert,
  convertSeries,
  dischargeToDepth,
  dischargeToVolume,
  formatQuantity,
  specificDischarge,
  toDisplay,
  UnitConversionError,
} from '../src/index.js';

describe('discharge conversions', () => {
  it('converts cfs to cms using the exact international foot', () => {
    // 1 ft^3 = 0.028316846592 m^3 exactly
    expect(convert(1, 'ft3/s', 'm3/s')).toBeCloseTo(0.028316846592, 12);
    expect(convert(1000, 'ft3/s', 'm3/s')).toBeCloseTo(28.316846592, 9);
  });

  it('round-trips without drift', () => {
    const q = 1234.5678;
    expect(convert(convert(q, 'm3/s', 'ft3/s'), 'ft3/s', 'm3/s')).toBeCloseTo(q, 9);
  });

  it('converts MGD to cms', () => {
    // 1 MGD = 3785.411784 m3/d / 86400 s = 0.0438126 m3/s
    expect(convert(1, 'MGD', 'm3/s')).toBeCloseTo(0.0438126, 6);
  });
});

describe('depth and area conversions', () => {
  it('converts inches to mm exactly', () => {
    expect(convert(1, 'in', 'mm')).toBeCloseTo(25.4, 10);
    expect(convert(2.54, 'in', 'cm')).toBeCloseTo(6.4516, 6);
  });

  it('converts square miles to square kilometres', () => {
    expect(convert(1, 'mi2', 'km2')).toBeCloseTo(2.589988110336, 10);
  });

  it('converts acres to hectares', () => {
    expect(convert(1, 'ac', 'ha')).toBeCloseTo(0.40468564224, 10);
  });
});

describe('volume conversions', () => {
  it('converts acre-feet to cubic metres', () => {
    expect(convert(1, 'ac-ft', 'm3')).toBeCloseTo(1233.4818375475, 6);
  });

  it('converts MCM to acre-feet', () => {
    expect(convert(1, 'MCM', 'ac-ft')).toBeCloseTo(810.713193789913, 4);
  });
});

describe('temperature conversions', () => {
  it('handles the affine offset correctly', () => {
    expect(convert(32, 'degF', 'degC')).toBeCloseTo(0, 10);
    expect(convert(212, 'degF', 'degC')).toBeCloseTo(100, 10);
    expect(convert(-40, 'degF', 'degC')).toBeCloseTo(-40, 10);
    expect(convert(0, 'degC', 'K')).toBeCloseTo(273.15, 10);
  });
});

describe('dimension safety', () => {
  it('refuses cross-dimension conversion instead of guessing', () => {
    expect(() => convert(1, 'm3/s', 'mm')).toThrow(UnitConversionError);
    expect(() => convert(1, 'degC', 'mg/L')).toThrow(UnitConversionError);
  });

  it('refuses unknown units', () => {
    expect(() => convert(1, 'furlongs/fortnight', 'm3/s')).toThrow(UnitConversionError);
  });
});

describe('derived hydrologic conversions', () => {
  it('converts discharge to runoff depth over a catchment', () => {
    // 1 m3/s for 1 day over 86.4 km2 => 86400 m3 / 86.4e6 m2 = 0.001 m = 1 mm
    expect(dischargeToDepth(1, 'm3/s', 86.4, 'km2', 86400, 'mm')).toBeCloseTo(1, 9);
  });

  it('converts discharge to volume', () => {
    expect(dischargeToVolume(2, 'm3/s', 3600, 'm3')).toBeCloseTo(7200, 6);
  });

  it('computes specific discharge', () => {
    const s = specificDischarge(100, 'm3/s', 1000, 'km2');
    expect(s.value).toBeCloseTo(0.1, 9);
    expect(s.unit).toBe('m3/s per km2');
  });
});

describe('series conversion', () => {
  it('preserves nulls', () => {
    expect(convertSeries([1, null, 2], 'm3/s', 'ft3/s')).toEqual([
      convert(1, 'm3/s', 'ft3/s'),
      null,
      convert(2, 'm3/s', 'ft3/s'),
    ]);
  });
});

describe('formatting', () => {
  it('always renders the unit symbol', () => {
    expect(formatQuantity(12.345, 'm3/s')).toBe('12.35 m³/s');
    expect(formatQuantity(1500, 'ft3/s')).toBe('1,500 ft³/s');
    expect(formatQuantity(21.5, 'degC')).toBe('21.50°C');
  });

  it('renders an em dash for missing data rather than zero', () => {
    expect(formatQuantity(null, 'm3/s')).toBe('—');
  });
});

describe('unit system display', () => {
  it('maps to the project unit system', () => {
    const us = toDisplay(1, 'm3/s', 'US');
    expect(us.unit).toBe('ft3/s');
    expect(us.value).toBeCloseTo(35.3146667, 5);
    const si = toDisplay(1, 'm3/s', 'SI');
    expect(si.unit).toBe('m3/s');
  });
});
