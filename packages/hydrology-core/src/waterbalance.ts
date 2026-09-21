import { dischargeToDepth } from '@hydro/units';

/**
 * Catchment water balance and reservoir mass balance.
 *
 * P = Q + ET + ΔS   (over a closed catchment and a long enough period that
 * ΔS is small relative to the fluxes). The residual is reported rather than
 * forced to zero, because its size is the honest measure of how well the
 * input datasets close.
 */

export interface WaterBalanceInput {
  /** Basin-average precipitation depth per time step, mm. */
  precipitationMm: (number | null)[];
  /** Actual evapotranspiration depth per time step, mm. */
  etMm: (number | null)[];
  /** Outlet discharge per time step, m3/s. */
  dischargeM3s: (number | null)[];
  /** Time step in seconds (86400 for daily). */
  stepSeconds: number;
  catchmentAreaKm2: number;
}

export interface WaterBalanceResult {
  periodSteps: number;
  precipitationMm: number;
  evapotranspirationMm: number;
  runoffMm: number;
  storageChangeMm: number;
  residualMm: number;
  residualPctOfPrecip: number;
  runoffCoefficient: number;
  closureQuality: 'good' | 'acceptable' | 'poor';
  notes: string[];
}

export function waterBalance(input: WaterBalanceInput): WaterBalanceResult {
  const n = Math.min(input.precipitationMm.length, input.etMm.length, input.dischargeM3s.length);
  let p = 0;
  let et = 0;
  let q = 0;
  let counted = 0;
  const notes: string[] = [];

  for (let i = 0; i < n; i++) {
    const pi = input.precipitationMm[i];
    const ei = input.etMm[i];
    const qi = input.dischargeM3s[i];
    if (pi === null || ei === null || qi === null) continue;
    p += pi;
    et += ei;
    q += dischargeToDepth(qi, 'm3/s', input.catchmentAreaKm2, 'km2', input.stepSeconds, 'mm');
    counted++;
  }

  if (counted === 0) {
    return {
      periodSteps: 0, precipitationMm: 0, evapotranspirationMm: 0, runoffMm: 0,
      storageChangeMm: 0, residualMm: 0, residualPctOfPrecip: NaN, runoffCoefficient: NaN,
      closureQuality: 'poor', notes: ['No time steps had complete P, ET and Q — the balance could not be computed.'],
    };
  }
  if (counted < n) {
    notes.push(`${n - counted} of ${n} time steps were excluded because one or more fluxes were missing.`);
  }

  const residual = p - et - q;
  const residualPct = p === 0 ? NaN : (residual / p) * 100;
  const closure: WaterBalanceResult['closureQuality'] =
    Math.abs(residualPct) < 10 ? 'good' : Math.abs(residualPct) < 25 ? 'acceptable' : 'poor';

  if (closure === 'poor') {
    notes.push(
      `The balance residual is ${residualPct.toFixed(1)} % of precipitation. A residual this large usually means the ` +
        'ET estimate, the areal precipitation estimate, or the assumed catchment area is inconsistent with the gauge record, ' +
        'or that inter-basin transfers or regulation are present.',
    );
  }
  notes.push('Storage change ΔS is reported as the balance residual, not measured independently.');

  return {
    periodSteps: counted,
    precipitationMm: p,
    evapotranspirationMm: et,
    runoffMm: q,
    storageChangeMm: residual,
    residualMm: residual,
    residualPctOfPrecip: residualPct,
    runoffCoefficient: p === 0 ? NaN : q / p,
    closureQuality: closure,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Reservoir mass balance and supply reliability
// ---------------------------------------------------------------------------

export interface ReservoirStep {
  t: string;
  /** Inflow volume for the step, MCM. */
  inflowMcm: number;
  /** Demand (withdrawal target) for the step, MCM. */
  demandMcm: number;
  /** Net evaporation loss from the pool for the step, MCM. */
  evaporationMcm?: number;
  /** Minimum instream flow release requirement, MCM. */
  minimumReleaseMcm?: number;
}

export interface ReservoirConfig {
  capacityMcm: number;
  deadStorageMcm: number;
  initialStorageMcm: number;
}

export interface ReservoirSimulationResult {
  steps: {
    t: string;
    inflowMcm: number;
    demandMcm: number;
    deliveredMcm: number;
    shortfallMcm: number;
    releaseMcm: number;
    spillMcm: number;
    storageMcm: number;
    storagePct: number;
  }[];
  timeReliability: number;
  volumetricReliability: number;
  resilience: number;
  vulnerabilityMcm: number;
  deficitProbability: number;
  totalShortfallMcm: number;
  stepsInDeficit: number;
}

/**
 * Standard reservoir operation simulation (sequent-peak style mass balance
 * with a fixed rule curve of "meet demand if water is available above dead
 * storage"). Reliability, resilience and vulnerability follow the definitions
 * of Hashimoto, Stedinger & Loucks (1982).
 */
export function simulateReservoir(config: ReservoirConfig, steps: ReservoirStep[]): ReservoirSimulationResult {
  let storage = Math.min(config.initialStorageMcm, config.capacityMcm);
  const out: ReservoirSimulationResult['steps'] = [];
  let totalDemand = 0;
  let totalDelivered = 0;
  let failures = 0;
  let failureRuns = 0;
  let inFailure = false;
  let maxShortfall = 0;
  let totalShortfall = 0;

  for (const s of steps) {
    const evap = s.evaporationMcm ?? 0;
    const minRel = s.minimumReleaseMcm ?? 0;

    let available = storage + s.inflowMcm - evap - config.deadStorageMcm;
    available = Math.max(available, 0);

    const release = Math.min(minRel, available);
    available -= release;

    const delivered = Math.min(s.demandMcm, available);
    const shortfall = s.demandMcm - delivered;

    storage = storage + s.inflowMcm - evap - release - delivered;
    let spill = 0;
    if (storage > config.capacityMcm) {
      spill = storage - config.capacityMcm;
      storage = config.capacityMcm;
    }
    if (storage < config.deadStorageMcm) storage = config.deadStorageMcm;

    totalDemand += s.demandMcm;
    totalDelivered += delivered;
    if (shortfall > 1e-9) {
      failures++;
      totalShortfall += shortfall;
      maxShortfall = Math.max(maxShortfall, shortfall);
      if (!inFailure) {
        failureRuns++;
        inFailure = true;
      }
    } else {
      inFailure = false;
    }

    out.push({
      t: s.t,
      inflowMcm: s.inflowMcm,
      demandMcm: s.demandMcm,
      deliveredMcm: delivered,
      shortfallMcm: shortfall,
      releaseMcm: release,
      spillMcm: spill,
      storageMcm: storage,
      storagePct: (storage / config.capacityMcm) * 100,
    });
  }

  const n = steps.length || 1;
  return {
    steps: out,
    timeReliability: 1 - failures / n,
    volumetricReliability: totalDemand === 0 ? 1 : totalDelivered / totalDemand,
    resilience: failures === 0 ? 1 : failureRuns / failures,
    vulnerabilityMcm: maxShortfall,
    deficitProbability: failures / n,
    totalShortfallMcm: totalShortfall,
    stepsInDeficit: failures,
  };
}

/**
 * Safe yield: the largest constant withdrawal rate that can be met in every
 * step of the historical inflow record. Found by bisection on the simulation.
 */
export function safeYield(config: ReservoirConfig, inflows: { t: string; inflowMcm: number; evaporationMcm?: number; minimumReleaseMcm?: number }[], tolerance = 1e-4): number {
  const test = (demand: number) =>
    simulateReservoir(config, inflows.map((i) => ({ ...i, demandMcm: demand }))).stepsInDeficit === 0;

  let lo = 0;
  let hi = Math.max(...inflows.map((i) => i.inflowMcm)) * 1.5 + 1;
  if (!test(lo)) return 0;
  for (let i = 0; i < 60 && hi - lo > tolerance; i++) {
    const mid = (lo + hi) / 2;
    if (test(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Storage exceedance curve: P(storage >= s) from a simulated trace. */
export function storageExceedance(storages: number[], levels = [10, 25, 50, 75, 90]): { probability: number; storageMcm: number }[] {
  const sorted = [...storages].sort((a, b) => b - a);
  const n = sorted.length;
  return levels.map((pct) => {
    const idx = Math.min(Math.max(Math.round((pct / 100) * n) - 1, 0), n - 1);
    return { probability: pct / 100, storageMcm: sorted[idx] };
  });
}
