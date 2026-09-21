/**
 * @hydro/units — explicit, dimension-checked unit conversion.
 *
 * Guardrail #12 of the platform specification: units are never silently
 * changed. Every conversion is explicit, is dimension-checked, and throws on a
 * cross-dimension request rather than returning a plausible-looking number.
 */

export type Dimension =
  | 'discharge'
  | 'depth'
  | 'length'
  | 'area'
  | 'volume'
  | 'temperature'
  | 'concentration'
  | 'ratio';

export interface UnitDef {
  symbol: string;
  dimension: Dimension;
  /** Multiplicative factor to the dimension's base unit. */
  toBase: number;
  /** Additive offset applied after scaling (temperature only). */
  offset?: number;
  label: string;
  system: 'SI' | 'US' | 'both';
}

/** Base units: discharge m3/s, depth mm, length m, area km2, volume m3, temp degC. */
export const UNITS: Record<string, UnitDef> = {
  // Discharge -------------------------------------------------------------
  'm3/s': { symbol: 'm³/s', dimension: 'discharge', toBase: 1, label: 'cubic metres per second', system: 'SI' },
  'ft3/s': { symbol: 'ft³/s', dimension: 'discharge', toBase: 0.028316846592, label: 'cubic feet per second (cfs)', system: 'US' },
  'ML/d': { symbol: 'ML/d', dimension: 'discharge', toBase: 0.0115740740740741, label: 'megalitres per day', system: 'SI' },
  MGD: { symbol: 'MGD', dimension: 'discharge', toBase: 0.0438126363888889, label: 'million US gallons per day', system: 'US' },

  // Depth (precipitation, ET, runoff depth) -------------------------------
  mm: { symbol: 'mm', dimension: 'depth', toBase: 1, label: 'millimetres', system: 'SI' },
  in: { symbol: 'in', dimension: 'depth', toBase: 25.4, label: 'inches', system: 'US' },
  cm: { symbol: 'cm', dimension: 'depth', toBase: 10, label: 'centimetres', system: 'SI' },

  // Length / elevation / stage --------------------------------------------
  m: { symbol: 'm', dimension: 'length', toBase: 1, label: 'metres', system: 'SI' },
  ft: { symbol: 'ft', dimension: 'length', toBase: 0.3048, label: 'feet', system: 'US' },
  km: { symbol: 'km', dimension: 'length', toBase: 1000, label: 'kilometres', system: 'SI' },
  mi: { symbol: 'mi', dimension: 'length', toBase: 1609.344, label: 'miles', system: 'US' },

  // Area -------------------------------------------------------------------
  km2: { symbol: 'km²', dimension: 'area', toBase: 1, label: 'square kilometres', system: 'SI' },
  mi2: { symbol: 'mi²', dimension: 'area', toBase: 2.589988110336, label: 'square miles', system: 'US' },
  ha: { symbol: 'ha', dimension: 'area', toBase: 0.01, label: 'hectares', system: 'SI' },
  ac: { symbol: 'ac', dimension: 'area', toBase: 0.0040468564224, label: 'acres', system: 'US' },
  m2: { symbol: 'm²', dimension: 'area', toBase: 1e-6, label: 'square metres', system: 'SI' },

  // Volume -----------------------------------------------------------------
  m3: { symbol: 'm³', dimension: 'volume', toBase: 1, label: 'cubic metres', system: 'SI' },
  'ac-ft': { symbol: 'ac-ft', dimension: 'volume', toBase: 1233.4818375475, label: 'acre-feet', system: 'US' },
  MCM: { symbol: 'MCM', dimension: 'volume', toBase: 1e6, label: 'million cubic metres', system: 'SI' },
  L: { symbol: 'L', dimension: 'volume', toBase: 0.001, label: 'litres', system: 'SI' },

  // Temperature ------------------------------------------------------------
  degC: { symbol: '°C', dimension: 'temperature', toBase: 1, offset: 0, label: 'degrees Celsius', system: 'SI' },
  degF: { symbol: '°F', dimension: 'temperature', toBase: 5 / 9, offset: -32 * (5 / 9), label: 'degrees Fahrenheit', system: 'US' },
  K: { symbol: 'K', dimension: 'temperature', toBase: 1, offset: -273.15, label: 'kelvin', system: 'SI' },

  // Concentration ----------------------------------------------------------
  'mg/L': { symbol: 'mg/L', dimension: 'concentration', toBase: 1, label: 'milligrams per litre', system: 'both' },
  'ug/L': { symbol: 'µg/L', dimension: 'concentration', toBase: 0.001, label: 'micrograms per litre', system: 'both' },
  ppm: { symbol: 'ppm', dimension: 'concentration', toBase: 1, label: 'parts per million (≈ mg/L in freshwater)', system: 'both' },

  // Dimensionless ----------------------------------------------------------
  dimensionless: { symbol: '', dimension: 'ratio', toBase: 1, label: 'dimensionless', system: 'both' },
  '%': { symbol: '%', dimension: 'ratio', toBase: 0.01, label: 'percent', system: 'both' },
};

/** Units that carry no convertible dimension but must still be displayed. */
export const DISPLAY_ONLY_UNITS: Record<string, string> = {
  NTU: 'NTU',
  'uS/cm': 'µS/cm',
  'MPN/100mL': 'MPN/100 mL',
  pH: 'pH',
  'm3/s per km2': 'm³/s per km²',
};

export class UnitConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitConversionError';
  }
}

export function getUnit(symbol: string): UnitDef {
  const u = UNITS[symbol];
  if (!u) throw new UnitConversionError(`Unknown unit "${symbol}". Register it in @hydro/units before use.`);
  return u;
}

export function dimensionOf(symbol: string): Dimension {
  return getUnit(symbol).dimension;
}

export function areCompatible(a: string, b: string): boolean {
  try {
    return dimensionOf(a) === dimensionOf(b);
  } catch {
    return false;
  }
}

/**
 * Convert a value between two units of the same dimension.
 * Throws `UnitConversionError` on a cross-dimension request — the platform
 * must never quietly produce a wrong-dimension number.
 */
export function convert(value: number, from: string, to: string): number {
  if (from === to) return value;
  const f = getUnit(from);
  const t = getUnit(to);
  if (f.dimension !== t.dimension) {
    throw new UnitConversionError(
      `Cannot convert ${from} (${f.dimension}) to ${to} (${t.dimension}): incompatible dimensions.`,
    );
  }
  const base = value * f.toBase + (f.offset ?? 0);
  return (base - (t.offset ?? 0)) / t.toBase;
}

export function convertNullable(value: number | null, from: string, to: string): number | null {
  return value === null || Number.isNaN(value) ? null : convert(value, from, to);
}

export function convertSeries(values: (number | null)[], from: string, to: string): (number | null)[] {
  if (from === to) return values;
  return values.map((v) => convertNullable(v, from, to));
}

// ---------------------------------------------------------------------------
// Hydrology-specific derived conversions
// ---------------------------------------------------------------------------

/**
 * Convert a discharge to an equivalent runoff depth over a catchment area for
 * a given duration. Q [m3/s] * seconds / area [m2] -> depth [m] -> mm.
 */
export function dischargeToDepth(
  discharge: number,
  dischargeUnit: string,
  areaValue: number,
  areaUnit: string,
  durationSeconds: number,
  depthUnit = 'mm',
): number {
  const qm3s = convert(discharge, dischargeUnit, 'm3/s');
  const areaKm2 = convert(areaValue, areaUnit, 'km2');
  const areaM2 = areaKm2 * 1e6;
  if (areaM2 <= 0) throw new UnitConversionError('Catchment area must be positive.');
  const depthM = (qm3s * durationSeconds) / areaM2;
  return convert(depthM * 1000, 'mm', depthUnit);
}

/** Volume of water passing a section over a duration. */
export function dischargeToVolume(
  discharge: number,
  dischargeUnit: string,
  durationSeconds: number,
  volumeUnit = 'm3',
): number {
  const qm3s = convert(discharge, dischargeUnit, 'm3/s');
  return convert(qm3s * durationSeconds, 'm3', volumeUnit);
}

/** Specific discharge (unit runoff), a common inter-basin comparison metric. */
export function specificDischarge(
  discharge: number,
  dischargeUnit: string,
  areaValue: number,
  areaUnit: string,
): { value: number; unit: string } {
  const qm3s = convert(discharge, dischargeUnit, 'm3/s');
  const areaKm2 = convert(areaValue, areaUnit, 'km2');
  return { value: qm3s / areaKm2, unit: 'm3/s per km2' };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function unitSymbol(symbol: string): string {
  if (DISPLAY_ONLY_UNITS[symbol]) return DISPLAY_ONLY_UNITS[symbol];
  return UNITS[symbol]?.symbol ?? symbol;
}

export interface FormatOptions {
  precision?: number;
  /** Use compact SI-ish notation for large numbers (1.2k, 3.4M). */
  compact?: boolean;
  /** Omit the unit symbol (rare — prefer showing it). */
  hideUnit?: boolean;
  nullText?: string;
}

/** Always renders the unit alongside the value (spec §26). */
export function formatQuantity(value: number | null, unit: string, opts: FormatOptions = {}): string {
  const { precision, compact = false, hideUnit = false, nullText = '—' } = opts;
  if (value === null || value === undefined || Number.isNaN(value)) return nullText;

  const p = precision ?? defaultPrecision(value);
  let text: string;
  if (compact && Math.abs(value) >= 1000) {
    text = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  } else {
    text = new Intl.NumberFormat('en-US', { minimumFractionDigits: p, maximumFractionDigits: p }).format(value);
  }
  if (hideUnit) return text;
  const sym = unitSymbol(unit);
  if (!sym) return text;
  // Degree symbols and percent sit tight against the number.
  const tight = sym.startsWith('°') || sym === '%';
  return tight ? `${text}${sym}` : `${text} ${sym}`;
}

function defaultPrecision(value: number): number {
  const a = Math.abs(value);
  if (a === 0) return 1;
  if (a >= 1000) return 0;
  if (a >= 100) return 1;
  if (a >= 1) return 2;
  if (a >= 0.01) return 3;
  return 4;
}

/** Preferred display unit for a variable under a given unit system. */
export const PREFERRED_UNITS: Record<'SI' | 'US', Record<string, string>> = {
  SI: {
    discharge: 'm3/s',
    depth: 'mm',
    length: 'm',
    area: 'km2',
    volume: 'MCM',
    temperature: 'degC',
    concentration: 'mg/L',
    ratio: 'dimensionless',
  },
  US: {
    discharge: 'ft3/s',
    depth: 'in',
    length: 'ft',
    area: 'mi2',
    volume: 'ac-ft',
    temperature: 'degF',
    concentration: 'mg/L',
    ratio: 'dimensionless',
  },
};

export function preferredUnitFor(unit: string, system: 'SI' | 'US'): string {
  try {
    return PREFERRED_UNITS[system][dimensionOf(unit)] ?? unit;
  } catch {
    return unit;
  }
}

/** Convert a value into the project's unit system for display. */
export function toDisplay(value: number | null, unit: string, system: 'SI' | 'US'): { value: number | null; unit: string } {
  const target = preferredUnitFor(unit, system);
  return { value: convertNullable(value, unit, target), unit: target };
}
