import { mulberry32 } from '../src/forecast.js';

/**
 * Deterministic synthetic catchment used across the scientific test suite.
 * Every test that needs a "record" uses this, so results are reproducible
 * bit-for-bit across machines and CI runs.
 */
export interface SyntheticCatchment {
  dates: string[];
  precipMm: number[];
  tmaxC: number[];
  tminC: number[];
  flowM3s: number[];
  areaKm2: number;
  latitude: number;
}

export function syntheticCatchment(years = 30, seed = 42): SyntheticCatchment {
  const rng = mulberry32(seed);
  const dates: string[] = [];
  const precipMm: number[] = [];
  const tmaxC: number[] = [];
  const tminC: number[] = [];
  const flowM3s: number[] = [];

  const areaKm2 = 2900;
  const latitude = 39.3;

  // Two linear reservoirs: quick response and baseflow.
  let quick = 0;
  let slow = 12;
  let soil = 120;

  const start = new Date(Date.UTC(2026 - years, 0, 1));
  const totalDays = Math.round((Date.UTC(2026, 0, 1) - start.getTime()) / 86400000);

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    const seasonal = Math.sin((2 * Math.PI * (doy - 100)) / 365);

    // Multi-year wet/dry oscillation so drought indices have something to find.
    const decadal = Math.sin((2 * Math.PI * i) / (365.25 * 7));

    // Precipitation: occurrence then intensity.
    const pOccur = 0.28 + 0.06 * seasonal + 0.05 * decadal;
    let p = 0;
    if (rng() < pOccur) {
      const u = Math.max(rng(), 1e-9);
      p = -Math.log(u) * (6.5 + 2.5 * seasonal + 1.5 * decadal);
    }
    p = Math.max(p, 0);

    // Temperature: seasonal cycle plus noise.
    const tmean = 12.5 + 12 * Math.sin((2 * Math.PI * (doy - 110)) / 365) + (rng() - 0.5) * 4;
    const range = 9 + (rng() - 0.5) * 3;
    const tmax = tmean + range / 2;
    const tmin = tmean - range / 2;

    // Simple soil-moisture accounting -> runoff generation.
    const pet = Math.max(0.0023 * 15 * (tmean + 17.8) * Math.sqrt(Math.max(range, 0.5)), 0);
    soil = Math.min(soil + p, 320);
    const aet = Math.min(pet * (soil / 320), soil);
    soil -= aet;
    const runoffCoef = 0.08 + 0.42 * (soil / 320) ** 2;
    const runoff = p * runoffCoef;
    const recharge = Math.max(soil - 250, 0) * 0.05;
    soil -= recharge;

    quick = quick * 0.55 + runoff * 0.45;
    slow = slow * 0.985 + recharge * 0.5 + 0.06;

    // mm/day over the catchment -> m3/s
    const depthToFlow = (areaKm2 * 1e6) / (1000 * 86400);
    const q = Math.max((quick * 1.9 + slow * 0.06) * depthToFlow * 0.02 + 3.0, 0.6);

    dates.push(iso);
    precipMm.push(Number(p.toFixed(2)));
    tmaxC.push(Number(tmax.toFixed(2)));
    tminC.push(Number(tmin.toFixed(2)));
    flowM3s.push(Number(q.toFixed(3)));
  }

  return { dates, precipMm, tmaxC, tminC, flowM3s, areaKm2, latitude };
}
