import { describe, expect, it } from 'vitest';
import { safeYield, simulateReservoir, storageExceedance, waterBalance } from '../src/waterbalance.js';

describe('catchment water balance', () => {
  it('closes exactly for a consistent synthetic record', () => {
    // 1 m3/s over 86.4 km2 for one day = 1 mm of runoff.
    const n = 365;
    const r = waterBalance({
      precipitationMm: new Array(n).fill(4),
      etMm: new Array(n).fill(3),
      dischargeM3s: new Array(n).fill(1),
      stepSeconds: 86400,
      catchmentAreaKm2: 86.4,
    });
    expect(r.precipitationMm).toBeCloseTo(4 * n, 6);
    expect(r.evapotranspirationMm).toBeCloseTo(3 * n, 6);
    expect(r.runoffMm).toBeCloseTo(1 * n, 6);
    expect(r.residualMm).toBeCloseTo(0, 6);
    expect(r.closureQuality).toBe('good');
    expect(r.runoffCoefficient).toBeCloseTo(0.25, 6);
  });

  it('reports a poor closure rather than forcing the balance', () => {
    const n = 100;
    const r = waterBalance({
      precipitationMm: new Array(n).fill(4),
      etMm: new Array(n).fill(0.2),
      dischargeM3s: new Array(n).fill(1),
      stepSeconds: 86400,
      catchmentAreaKm2: 86.4,
    });
    expect(r.closureQuality).toBe('poor');
    expect(r.notes.join(' ')).toContain('residual');
  });

  it('excludes incomplete time steps and says how many', () => {
    const r = waterBalance({
      precipitationMm: [4, null, 4],
      etMm: [3, 3, 3],
      dischargeM3s: [1, 1, 1],
      stepSeconds: 86400,
      catchmentAreaKm2: 86.4,
    });
    expect(r.periodSteps).toBe(2);
    expect(r.notes.join(' ')).toContain('excluded');
  });

  it('does not compute a balance with no usable steps', () => {
    const r = waterBalance({ precipitationMm: [null], etMm: [null], dischargeM3s: [null], stepSeconds: 86400, catchmentAreaKm2: 100 });
    expect(r.periodSteps).toBe(0);
    expect(r.closureQuality).toBe('poor');
  });
});

describe('reservoir simulation', () => {
  const config = { capacityMcm: 100, deadStorageMcm: 10, initialStorageMcm: 80 };

  it('conserves mass across every step', () => {
    const steps = Array.from({ length: 24 }, (_, i) => ({
      t: `2025-${String((i % 12) + 1).padStart(2, '0')}`,
      inflowMcm: 10 + 5 * Math.sin(i),
      demandMcm: 12,
    }));
    const r = simulateReservoir(config, steps);
    let s = config.initialStorageMcm;
    r.steps.forEach((st) => {
      const expected = Math.min(s + st.inflowMcm - st.releaseMcm - st.deliveredMcm, config.capacityMcm);
      expect(st.storageMcm).toBeCloseTo(Math.max(expected, config.deadStorageMcm), 6);
      s = st.storageMcm;
    });
  });

  it('never draws below dead storage', () => {
    const steps = Array.from({ length: 36 }, (_, i) => ({ t: `m${i}`, inflowMcm: 1, demandMcm: 20 }));
    const r = simulateReservoir(config, steps);
    r.steps.forEach((s) => expect(s.storageMcm).toBeGreaterThanOrEqual(config.deadStorageMcm - 1e-9));
  });

  it('reports perfect reliability when inflow always exceeds demand', () => {
    const steps = Array.from({ length: 60 }, (_, i) => ({ t: `m${i}`, inflowMcm: 30, demandMcm: 10 }));
    const r = simulateReservoir(config, steps);
    expect(r.timeReliability).toBe(1);
    expect(r.volumetricReliability).toBeCloseTo(1, 10);
    expect(r.deficitProbability).toBe(0);
    expect(r.totalShortfallMcm).toBeCloseTo(0, 10);
  });

  it('spills when inflow exceeds capacity', () => {
    const steps = [{ t: 'm0', inflowMcm: 500, demandMcm: 0 }];
    const r = simulateReservoir(config, steps);
    expect(r.steps[0].spillMcm).toBeGreaterThan(0);
    expect(r.steps[0].storageMcm).toBeCloseTo(config.capacityMcm, 10);
  });

  it('computes reliability, resilience and vulnerability', () => {
    const steps = Array.from({ length: 48 }, (_, i) => ({
      t: `m${i}`,
      inflowMcm: i % 12 < 6 ? 20 : 2,
      demandMcm: 12,
    }));
    const r = simulateReservoir(config, steps);
    expect(r.timeReliability).toBeGreaterThan(0);
    expect(r.timeReliability).toBeLessThan(1);
    expect(r.resilience).toBeGreaterThan(0);
    expect(r.vulnerabilityMcm).toBeGreaterThan(0);
    expect(r.stepsInDeficit).toBeGreaterThan(0);
  });

  it('honours a minimum instream release before delivering demand', () => {
    const steps = [{ t: 'm0', inflowMcm: 5, demandMcm: 100, minimumReleaseMcm: 4 }];
    const r = simulateReservoir({ capacityMcm: 100, deadStorageMcm: 10, initialStorageMcm: 10 }, steps);
    expect(r.steps[0].releaseMcm).toBeCloseTo(4, 6);
    expect(r.steps[0].deliveredMcm).toBeCloseTo(1, 6);
  });
});

describe('safe yield', () => {
  it('equals the constant inflow for a steady record', () => {
    const inflows = Array.from({ length: 120 }, (_, i) => ({ t: `m${i}`, inflowMcm: 10 }));
    const y = safeYield({ capacityMcm: 100, deadStorageMcm: 0, initialStorageMcm: 100 }, inflows);
    expect(y).toBeGreaterThan(9.9);
    expect(y).toBeLessThan(10.9);
  });

  it('is bounded above by the mean inflow plus usable storage', () => {
    const inflows = Array.from({ length: 240 }, (_, i) => ({ t: `m${i}`, inflowMcm: 8 + 6 * Math.sin(i / 6) }));
    const y = safeYield({ capacityMcm: 60, deadStorageMcm: 5, initialStorageMcm: 60 }, inflows);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(14.1);
  });
});

describe('storage exceedance', () => {
  it('is monotonically decreasing with exceedance probability', () => {
    const s = storageExceedance([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].storageMcm).toBeLessThanOrEqual(s[i - 1].storageMcm);
    }
  });
});
