import type { ModelMetrics } from '@hydro/shared-types';
import { mean, pearson, stdDev } from './stats.js';

export interface PairedSeries {
  observed: (number | null)[];
  simulated: (number | null)[];
}

/** Drop pairs where either member is missing; report how many survived. */
export function pairComplete(obs: (number | null)[], sim: (number | null)[]): { o: number[]; s: number[]; dropped: number } {
  const o: number[] = [];
  const s: number[] = [];
  let dropped = 0;
  const n = Math.min(obs.length, sim.length);
  for (let i = 0; i < n; i++) {
    const a = obs[i];
    const b = sim[i];
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) {
      dropped++;
      continue;
    }
    o.push(a);
    s.push(b);
  }
  return { o, s, dropped };
}

/** Nash–Sutcliffe efficiency (Nash & Sutcliffe 1970). */
export function nse(obs: number[], sim: number[]): number {
  const mo = mean(obs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < obs.length; i++) {
    num += (obs[i] - sim[i]) ** 2;
    den += (obs[i] - mo) ** 2;
  }
  return den === 0 ? NaN : 1 - num / den;
}

/**
 * Kling–Gupta efficiency, 2009 formulation (Gupta et al., J. Hydrol. 377).
 * KGE = 1 - sqrt((r-1)^2 + (alpha-1)^2 + (beta-1)^2)
 */
export function kge(obs: number[], sim: number[]): { kge: number; r: number; alpha: number; beta: number } {
  const r = pearson(obs, sim);
  const so = stdDev(obs);
  const ss = stdDev(sim);
  const mo = mean(obs);
  const ms = mean(sim);
  const alpha = so === 0 ? NaN : ss / so;
  const beta = mo === 0 ? NaN : ms / mo;
  const value = 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2);
  return { kge: value, r, alpha, beta };
}

/** KGE' (Kling et al. 2012) — variability measured by the coefficient of variation. */
export function kgePrime(obs: number[], sim: number[]): number {
  const r = pearson(obs, sim);
  const mo = mean(obs);
  const ms = mean(sim);
  const cvO = stdDev(obs) / mo;
  const cvS = stdDev(sim) / ms;
  const gamma = cvS / cvO;
  const beta = ms / mo;
  return 1 - Math.sqrt((r - 1) ** 2 + (gamma - 1) ** 2 + (beta - 1) ** 2);
}

export function rmse(obs: number[], sim: number[]): number {
  let s = 0;
  for (let i = 0; i < obs.length; i++) s += (obs[i] - sim[i]) ** 2;
  return Math.sqrt(s / obs.length);
}

export function mae(obs: number[], sim: number[]): number {
  let s = 0;
  for (let i = 0; i < obs.length; i++) s += Math.abs(obs[i] - sim[i]);
  return s / obs.length;
}

/** MAPE, undefined where the observation is zero — those pairs are excluded. */
export function mape(obs: number[], sim: number[]): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < obs.length; i++) {
    if (obs[i] === 0) continue;
    s += Math.abs((obs[i] - sim[i]) / obs[i]);
    n++;
  }
  return n === 0 ? NaN : (s / n) * 100;
}

export function bias(obs: number[], sim: number[]): number {
  return mean(sim) - mean(obs);
}

/** Percent bias — the standard model-calibration criterion (Moriasi et al. 2007). */
export function pbias(obs: number[], sim: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < obs.length; i++) {
    num += sim[i] - obs[i];
    den += obs[i];
  }
  return den === 0 ? NaN : (num / den) * 100;
}

export function peakErrorPct(obs: number[], sim: number[]): number {
  const po = Math.max(...obs);
  const ps = Math.max(...sim);
  return po === 0 ? NaN : ((ps - po) / po) * 100;
}

export function volumeErrorPct(obs: number[], sim: number[]): number {
  const vo = obs.reduce((a, b) => a + b, 0);
  const vs = sim.reduce((a, b) => a + b, 0);
  return vo === 0 ? NaN : ((vs - vo) / vo) * 100;
}

const nz = (v: number) => (Number.isFinite(v) ? v : null);

/** The full metric suite required by §29 of the specification. */
export function evaluate(observed: (number | null)[], simulated: (number | null)[]): ModelMetrics {
  const { o, s } = pairComplete(observed, simulated);
  if (o.length < 2) {
    return {
      nse: null, kge: null, rmse: null, mae: null, mape: null, r2: null,
      bias: null, pbias: null, correlation: null, peakErrorPct: null, volumeErrorPct: null,
      n: o.length,
    };
  }
  const r = pearson(o, s);
  return {
    nse: nz(nse(o, s)),
    kge: nz(kge(o, s).kge),
    rmse: nz(rmse(o, s)),
    mae: nz(mae(o, s)),
    mape: nz(mape(o, s)),
    r2: nz(r * r),
    bias: nz(bias(o, s)),
    pbias: nz(pbias(o, s)),
    correlation: nz(r),
    peakErrorPct: nz(peakErrorPct(o, s)),
    volumeErrorPct: nz(volumeErrorPct(o, s)),
    n: o.length,
  };
}

/**
 * Performance rating for streamflow simulation following the widely-cited
 * Moriasi et al. (2007) / Moriasi et al. (2015) guidance. Ratings are a
 * convention, not a certification — the platform labels them as such.
 */
export function ratePerformance(m: ModelMetrics): {
  overall: 'very good' | 'good' | 'satisfactory' | 'unsatisfactory' | 'insufficient data';
  detail: { criterion: string; value: number | null; rating: string }[];
} {
  if (m.n < 10) return { overall: 'insufficient data', detail: [] };
  const rate = (v: number | null, bands: [number, string][], higherIsBetter: boolean): string => {
    if (v === null) return 'not evaluated';
    for (const [threshold, label] of bands) {
      if (higherIsBetter ? v > threshold : Math.abs(v) < threshold) return label;
    }
    return 'unsatisfactory';
  };
  const nseRating = rate(m.nse, [[0.8, 'very good'], [0.7, 'good'], [0.5, 'satisfactory']], true);
  const pbiasRating = rate(m.pbias, [[5, 'very good'], [10, 'good'], [15, 'satisfactory']], false);
  const kgeRating = rate(m.kge, [[0.85, 'very good'], [0.75, 'good'], [0.5, 'satisfactory']], true);
  const order = ['very good', 'good', 'satisfactory', 'unsatisfactory', 'not evaluated'];
  const worst = [nseRating, pbiasRating, kgeRating]
    .filter((r) => r !== 'not evaluated')
    .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  return {
    overall: (worst ?? 'unsatisfactory') as 'very good' | 'good' | 'satisfactory' | 'unsatisfactory',
    detail: [
      { criterion: 'NSE (Moriasi 2015, daily streamflow)', value: m.nse, rating: nseRating },
      { criterion: 'PBIAS % (Moriasi 2015, daily streamflow)', value: m.pbias, rating: pbiasRating },
      { criterion: 'KGE (Knoben 2019 reference thresholds)', value: m.kge, rating: kgeRating },
    ],
  };
}
