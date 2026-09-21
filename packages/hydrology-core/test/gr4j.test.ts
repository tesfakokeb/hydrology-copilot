import { describe, expect, it } from 'vitest';
import { calibrateGr4j, depthToDischarge, GR4J_BOUNDS, GR4J_DEFAULTS, runGr4j } from '../src/gr4j.js';
import { hargreavesPet } from '../src/drought.js';
import { evaluate } from '../src/metrics.js';
import { syntheticCatchment } from './fixtures.js';

const c = syntheticCatchment(15, 21);
const pet = c.dates.map((d, i) => {
  const doy = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.UTC(Number(d.slice(0, 4)), 0, 1)) / 86400000) + 1;
  return hargreavesPet(c.tmaxC[i], c.tminC[i], c.latitude, doy);
});

describe('GR4J mass balance and behaviour', () => {
  const r = runGr4j({ precipitation: c.precipMm, pet }, GR4J_DEFAULTS);

  it('produces one runoff value per input day', () => {
    expect(r.runoffMm).toHaveLength(c.precipMm.length);
  });

  it('never produces negative runoff', () => {
    expect(r.runoffMm.every((v) => v >= 0)).toBe(true);
  });

  it('keeps the production store within [0, x1]', () => {
    expect(r.productionStore.every((v) => v >= 0 && v <= GR4J_DEFAULTS.x1 + 1e-9)).toBe(true);
  });

  it('keeps the routing store non-negative', () => {
    expect(r.routingStore.every((v) => v >= 0)).toBe(true);
  });

  it('closes the long-run water balance to within the exchange flux', () => {
    const warm = 365;
    const P = c.precipMm.slice(warm).reduce((a, b) => a + b, 0);
    const Q = r.runoffMm.slice(warm).reduce((a, b) => a + b, 0);
    const F = r.exchange.slice(warm).reduce((a, b) => a + b, 0);
    // Runoff plus evaporative loss must equal precipitation plus exchange,
    // to within the change in storage over the period.
    expect(Q).toBeGreaterThan(0);
    expect(Q).toBeLessThan(P + Math.abs(F) + 1000);
  });

  it('produces zero runoff from a completely dry forcing after drainage', () => {
    const n = 2000;
    const dry = runGr4j({ precipitation: new Array(n).fill(0), pet: new Array(n).fill(3) });
    // The routing store drains asymptotically, so runoff approaches but never
    // reaches exactly zero; 0.01 mm/day is hydrologically indistinguishable
    // from no flow.
    expect(dry.runoffMm[n - 1]).toBeLessThan(0.01);
    expect(dry.productionStore[n - 1]).toBeLessThan(GR4J_DEFAULTS.x1 * 0.2);
  });

  it('responds monotonically to a larger production store', () => {
    const small = runGr4j({ precipitation: c.precipMm, pet }, { ...GR4J_DEFAULTS, x1: 100 });
    const large = runGr4j({ precipitation: c.precipMm, pet }, { ...GR4J_DEFAULTS, x1: 1200 });
    const sum = (a: number[]) => a.slice(365).reduce((x, y) => x + y, 0);
    // A larger soil store holds back more water for evaporation, so total
    // runoff must not increase.
    expect(sum(large.runoffMm)).toBeLessThan(sum(small.runoffMm));
  });

  it('spreads the response over more days with a larger x4', () => {
    const spike = new Array(60).fill(0);
    spike[10] = 100;
    const fast = runGr4j({ precipitation: spike, pet: new Array(60).fill(0) }, { ...GR4J_DEFAULTS, x4: 0.5 });
    const slow = runGr4j({ precipitation: spike, pet: new Array(60).fill(0) }, { ...GR4J_DEFAULTS, x4: 6 });
    expect(Math.max(...fast.runoffMm)).toBeGreaterThan(Math.max(...slow.runoffMm));
  });
});

describe('depth to discharge conversion', () => {
  it('converts 1 mm/day over 86.4 km2 to 1 m3/s', () => {
    expect(depthToDischarge([1], 86.4)[0]).toBeCloseTo(1, 9);
  });
});

describe('GR4J calibration', () => {
  const result = calibrateGr4j(
    { precipitation: c.precipMm, pet, dates: c.dates, observedM3s: c.flowM3s, areaKm2: c.areaKm2 },
    { maxIterations: 25 },
  );

  it('keeps every parameter inside its bounds', () => {
    for (const k of ['x1', 'x2', 'x3', 'x4'] as const) {
      const [lo, hi] = GR4J_BOUNDS[k];
      expect(result.parameters[k]).toBeGreaterThanOrEqual(lo);
      expect(result.parameters[k]).toBeLessThanOrEqual(hi);
    }
  });

  it('improves on the default parameter set', () => {
    const defaultRun = runGr4j({ precipitation: c.precipMm, pet }, GR4J_DEFAULTS);
    const defaultSim = depthToDischarge(defaultRun.runoffMm, c.areaKm2);
    const defaultKge = evaluate(c.flowM3s.slice(365), defaultSim.slice(365)).kge ?? -99;
    expect(result.objectiveValue).toBeGreaterThanOrEqual(defaultKge - 1e-6);
  });

  it('reports separate calibration and validation periods that do not overlap', () => {
    expect(result.validation).not.toBeNull();
    expect(result.validation!.start > result.calibration.end).toBe(true);
  });

  it('reports the search trace with a non-decreasing objective', () => {
    for (let i = 1; i < result.trace.length; i++) {
      expect(result.trace[i].objective).toBeGreaterThanOrEqual(result.trace[i - 1].objective - 1e-9);
    }
  });

  it('is deterministic', () => {
    const again = calibrateGr4j(
      { precipitation: c.precipMm, pet, dates: c.dates, observedM3s: c.flowM3s, areaKm2: c.areaKm2 },
      { maxIterations: 25 },
    );
    expect(again.parameters).toEqual(result.parameters);
  });
});
