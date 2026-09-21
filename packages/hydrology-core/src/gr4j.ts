/**
 * GR4J — a four-parameter daily lumped rainfall-runoff model
 * (Perrin, Michel & Andréassian, 2003, J. Hydrol. 279, 275–289).
 *
 * GR4J is included because it is a genuinely runnable, peer-reviewed
 * conceptual hydrologic model with a small parameter space, which lets the
 * platform demonstrate a complete model workflow — run, calibrate, validate,
 * evaluate — without depending on an external executable. The HEC-HMS,
 * HEC-RAS, SWAT and MODFLOW adapters describe how to reach those engines when
 * they are installed; GR4J is what runs out of the box.
 *
 * Parameters:
 *   x1  production store capacity                 [mm]
 *   x2  groundwater exchange coefficient          [mm/day]
 *   x3  routing store capacity                    [mm]
 *   x4  time base of the unit hydrograph          [days]
 */

import { evaluate } from './metrics.js';
import type { ModelMetrics } from '@hydro/shared-types';

export interface Gr4jParameters {
  x1: number;
  x2: number;
  x3: number;
  x4: number;
}

export const GR4J_DEFAULTS: Gr4jParameters = { x1: 350, x2: 0, x3: 90, x4: 1.7 };

export const GR4J_BOUNDS: Record<keyof Gr4jParameters, [number, number]> = {
  x1: [50, 3000],
  x2: [-8, 6],
  x3: [10, 500],
  x4: [0.5, 8],
};

export const GR4J_PARAMETER_DESCRIPTIONS: Record<keyof Gr4jParameters, string> = {
  x1: 'Maximum capacity of the production (soil moisture) store, in mm.',
  x2: 'Groundwater exchange coefficient, in mm/day. Positive imports water into the catchment, negative exports it.',
  x3: 'One-day-ahead maximum capacity of the routing store, in mm.',
  x4: 'Time base of unit hydrograph UH1, in days. Must be at least 0.5.',
};

export interface Gr4jInput {
  /** Daily precipitation depth, mm. */
  precipitation: number[];
  /** Daily potential evapotranspiration, mm. */
  pet: number[];
}

export interface Gr4jResult {
  /** Simulated runoff depth, mm/day. */
  runoffMm: number[];
  /** Production store level, mm. */
  productionStore: number[];
  /** Routing store level, mm. */
  routingStore: number[];
  /** Groundwater exchange flux, mm/day. */
  exchange: number[];
  parameters: Gr4jParameters;
  warmupDays: number;
}

function uh1Ordinates(x4: number): number[] {
  const n = Math.ceil(x4);
  const sh = (t: number) => (t <= 0 ? 0 : t < x4 ? (t / x4) ** 2.5 : 1);
  return Array.from({ length: n }, (_, i) => sh(i + 1) - sh(i));
}

function uh2Ordinates(x4: number): number[] {
  const n = Math.ceil(2 * x4);
  const sh = (t: number) => {
    if (t <= 0) return 0;
    if (t < x4) return 0.5 * (t / x4) ** 2.5;
    if (t < 2 * x4) return 1 - 0.5 * (2 - t / x4) ** 2.5;
    return 1;
  };
  return Array.from({ length: n }, (_, i) => sh(i + 1) - sh(i));
}

/** Run GR4J over a daily series. */
export function runGr4j(input: Gr4jInput, params: Gr4jParameters = GR4J_DEFAULTS, warmupDays = 365): Gr4jResult {
  const { x1, x2, x3, x4 } = params;
  const n = Math.min(input.precipitation.length, input.pet.length);

  const uh1 = uh1Ordinates(Math.max(x4, 0.5));
  const uh2 = uh2Ordinates(Math.max(x4, 0.5));
  const s1 = new Array(uh1.length).fill(0);
  const s2 = new Array(uh2.length).fill(0);

  // Stores initialised at the conventional fractions of capacity.
  let S = 0.6 * x1;
  let R = 0.7 * x3;

  const runoffMm: number[] = new Array(n).fill(0);
  const productionStore: number[] = new Array(n).fill(0);
  const routingStore: number[] = new Array(n).fill(0);
  const exchange: number[] = new Array(n).fill(0);

  for (let t = 0; t < n; t++) {
    const P = Math.max(input.precipitation[t] ?? 0, 0);
    const E = Math.max(input.pet[t] ?? 0, 0);

    // --- Net rainfall / net evaporation ------------------------------------
    const Pn = Math.max(P - E, 0);
    const En = Math.max(E - P, 0);

    // --- Production store ---------------------------------------------------
    let Ps = 0;
    let Es = 0;
    if (Pn > 0) {
      const tanhTerm = Math.tanh(Pn / x1);
      Ps = (x1 * (1 - (S / x1) ** 2) * tanhTerm) / (1 + (S / x1) * tanhTerm);
      S += Ps;
    } else if (En > 0) {
      const tanhTerm = Math.tanh(En / x1);
      Es = (S * (2 - S / x1) * tanhTerm) / (1 + (1 - S / x1) * tanhTerm);
      S -= Es;
    }
    S = Math.min(Math.max(S, 0), x1);

    // Percolation from the production store.
    const perc = S * (1 - (1 + ((4 / 9) * (S / x1)) ** 4) ** -0.25);
    S -= perc;

    // --- Routing ------------------------------------------------------------
    const Pr = perc + (Pn - Ps);
    const toUh1 = 0.9 * Pr;
    const toUh2 = 0.1 * Pr;

    for (let i = 0; i < uh1.length; i++) s1[i] += uh1[i] * toUh1;
    for (let i = 0; i < uh2.length; i++) s2[i] += uh2[i] * toUh2;

    const q9 = s1[0];
    const q1 = s2[0];
    s1.copyWithin(0, 1);
    s1[s1.length - 1] = 0;
    s2.copyWithin(0, 1);
    s2[s2.length - 1] = 0;

    // Groundwater exchange.
    const F = x2 * (R / x3) ** 3.5;

    // Routing store.
    R = Math.max(R + q9 + F, 0);
    const Qr = R * (1 - (1 + (R / x3) ** 4) ** -0.25);
    R -= Qr;

    // Direct branch.
    const Qd = Math.max(q1 + F, 0);

    runoffMm[t] = Qr + Qd;
    productionStore[t] = S;
    routingStore[t] = R;
    exchange[t] = F;
  }

  return { runoffMm, productionStore, routingStore, exchange, parameters: params, warmupDays };
}

/** Convert a runoff depth series [mm/day] to discharge [m3/s]. */
export function depthToDischarge(runoffMm: number[], areaKm2: number): number[] {
  const factor = (areaKm2 * 1e6) / (1000 * 86400);
  return runoffMm.map((v) => v * factor);
}

export interface Gr4jCalibrationResult {
  parameters: Gr4jParameters;
  calibration: { start: string; end: string; metrics: ModelMetrics };
  validation: { start: string; end: string; metrics: ModelMetrics } | null;
  iterations: number;
  objective: 'KGE' | 'NSE';
  objectiveValue: number;
  trace: { iteration: number; objective: number; parameters: Gr4jParameters }[];
}

/**
 * Calibrate GR4J by a bounded coordinate-descent search on log-transformed
 * parameters, maximising KGE over a calibration period with a warm-up
 * discarded, then evaluated on an independent validation period.
 *
 * Deliberately simple and deterministic: reproducibility matters more here
 * than squeezing out the last hundredth of an efficiency, and the calibration
 * trace is reported so the search can be inspected.
 */
export function calibrateGr4j(
  input: Gr4jInput & { dates: string[]; observedM3s: (number | null)[]; areaKm2: number },
  options: {
    calibrationFraction?: number;
    warmupDays?: number;
    maxIterations?: number;
    objective?: 'KGE' | 'NSE';
    start?: Gr4jParameters;
  } = {},
): Gr4jCalibrationResult {
  const warmup = options.warmupDays ?? 365;
  const calFrac = options.calibrationFraction ?? 0.65;
  const maxIter = options.maxIterations ?? 40;
  const objective = options.objective ?? 'KGE';
  const n = input.dates.length;
  const calEnd = Math.floor(n * calFrac);

  const score = (params: Gr4jParameters): number => {
    const r = runGr4j(input, params, warmup);
    const sim = depthToDischarge(r.runoffMm, input.areaKm2);
    const m = evaluate(input.observedM3s.slice(warmup, calEnd), sim.slice(warmup, calEnd));
    const v = objective === 'KGE' ? m.kge : m.nse;
    return v === null || !Number.isFinite(v) ? -1e6 : v;
  };

  let best = { ...(options.start ?? GR4J_DEFAULTS) };
  let bestScore = score(best);
  const trace: Gr4jCalibrationResult['trace'] = [{ iteration: 0, objective: bestScore, parameters: { ...best } }];
  const keys: (keyof Gr4jParameters)[] = ['x1', 'x3', 'x4', 'x2'];
  let stepFrac = 0.6;
  let iterations = 0;

  for (let it = 1; it <= maxIter; it++) {
    iterations = it;
    let improved = false;
    for (const k of keys) {
      const [lo, hi] = GR4J_BOUNDS[k];
      const range = hi - lo;
      for (const dir of [1, -1]) {
        const candidate = { ...best, [k]: clamp(best[k] + dir * stepFrac * range * 0.15, lo, hi) } as Gr4jParameters;
        const s = score(candidate);
        if (s > bestScore + 1e-6) {
          best = candidate;
          bestScore = s;
          improved = true;
        }
      }
    }
    trace.push({ iteration: it, objective: bestScore, parameters: { ...best } });
    if (!improved) {
      stepFrac *= 0.5;
      if (stepFrac < 0.01) break;
    }
  }

  const finalRun = runGr4j(input, best, warmup);
  const sim = depthToDischarge(finalRun.runoffMm, input.areaKm2);

  return {
    parameters: best,
    calibration: {
      start: input.dates[warmup] ?? input.dates[0],
      end: input.dates[calEnd - 1] ?? input.dates[n - 1],
      metrics: evaluate(input.observedM3s.slice(warmup, calEnd), sim.slice(warmup, calEnd)),
    },
    validation:
      calEnd < n - 30
        ? {
            start: input.dates[calEnd],
            end: input.dates[n - 1],
            metrics: evaluate(input.observedM3s.slice(calEnd), sim.slice(calEnd)),
          }
        : null,
    iterations,
    objective,
    objectiveValue: bestScore,
    trace,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export const GR4J_REFERENCE =
  'Perrin, C., Michel, C., Andréassian, V. (2003). Improvement of a parsimonious model for streamflow simulation. Journal of Hydrology 279, 275–289.';
