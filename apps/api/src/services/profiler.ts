import { iqrOutlierBounds, mean, stdDev } from '@hydro/hydrology-core';
import type { DatasetFormat, DatasetProfile, DatasetVariable, Unit } from '@hydro/shared-types';

/**
 * Dataset profiler (§17).
 *
 * Parses a delimited text upload and reports what is actually in it: column
 * roles, inferred units, temporal and spatial coverage, missing data and
 * outliers. Nothing is silently repaired — every problem found is reported so
 * the analyst decides what to do about it.
 *
 * Binary scientific formats (NetCDF, GeoTIFF, Parquet, shapefile) are profiled
 * by the Python scientific service, which has xarray, rasterio and geopandas.
 * When that service is unavailable the profiler says so rather than guessing.
 */

export const TEXT_FORMATS: DatasetFormat[] = ['csv', 'json', 'geojson'];
export const BINARY_FORMATS: DatasetFormat[] = ['xlsx', 'netcdf', 'geotiff', 'parquet', 'shapefile'];

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/,
  /^\d{2}\/\d{2}\/\d{4}$/,
  /^\d{1,2}-[A-Za-z]{3}-\d{4}$/,
];

const ROLE_HINTS: { role: DatasetVariable['role']; patterns: RegExp[] }[] = [
  { role: 'time', patterns: [/^(date|datetime|timestamp|time|dt|day|obs_date)$/i, /date/i, /time/i] },
  { role: 'latitude', patterns: [/^(lat|latitude|y|dec_lat_va)$/i] },
  { role: 'longitude', patterns: [/^(lon|long|lng|longitude|x|dec_long_va)$/i] },
  { role: 'station_id', patterns: [/^(station|station_id|site|site_no|gage|gauge|id|code)$/i, /site.?no/i] },
  { role: 'flag', patterns: [/(flag|qualif|qc|quality)/i] },
];

const UNIT_HINTS: [RegExp, Unit][] = [
  [/\b(cfs|ft3\/s|ft\^3\/s|cubic feet)/i, 'ft3/s'],
  [/\b(cms|m3\/s|m\^3\/s|cubic met)/i, 'm3/s'],
  [/\bmgd\b/i, 'MGD'],
  [/\b(mm)\b/i, 'mm'],
  [/\b(inch|inches|in)\b/i, 'in'],
  [/\b(deg\s?c|celsius|°c)/i, 'degC'],
  [/\b(deg\s?f|fahrenheit|°f)/i, 'degF'],
  [/\bmg\/l\b/i, 'mg/L'],
  [/\b(ug\/l|µg\/l)\b/i, 'ug/L'],
  [/\bntu\b/i, 'NTU'],
  [/\b(us\/cm|µs\/cm)\b/i, 'uS/cm'],
  [/\bacre.?f(ee)?t\b/i, 'ac-ft'],
  [/\bmcm\b/i, 'MCM'],
  [/\b(ft|feet)\b/i, 'ft'],
  [/\bm\b/, 'm'],
];

export function detectDelimiter(headerLine: string): string {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const n = headerLine.split(d).length;
    if (n > bestCount) {
      bestCount = n;
      best = d;
    }
  }
  return best;
}

/** Split a delimited line, honouring double-quoted fields. */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function looksLikeDate(v: string): boolean {
  return DATE_PATTERNS.some((p) => p.test(v));
}

function inferRole(name: string, sample: string[]): DatasetVariable['role'] {
  for (const hint of ROLE_HINTS) {
    if (hint.patterns.some((p) => p.test(name))) {
      // Confirm a time column actually parses as a date.
      if (hint.role === 'time' && sample.length > 0 && !sample.slice(0, 20).some(looksLikeDate)) continue;
      return hint.role;
    }
  }
  const numeric = sample.filter((s) => s !== '' && Number.isFinite(Number(s)));
  if (sample.length > 0 && numeric.length / sample.length > 0.8) return 'value';
  if (sample.slice(0, 20).some(looksLikeDate)) return 'time';
  return 'unknown';
}

function inferUnit(name: string): Unit | null {
  for (const [pattern, unit] of UNIT_HINTS) if (pattern.test(name)) return unit;
  return null;
}

export interface ProfileOptions {
  name: string;
  format: DatasetFormat;
  datasetId: string;
  maxRows?: number;
}

/** Profile a delimited text dataset. */
export function profileDelimited(content: string, opts: ProfileOptions): DatasetProfile {
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return emptyProfile(opts, ['The file contains fewer than two non-empty lines, so no header and data rows could be identified.']);
  }

  // Skip leading comment lines (USGS RDB files begin with '#').
  let headerIndex = 0;
  while (headerIndex < lines.length && lines[headerIndex].startsWith('#')) headerIndex++;
  if (headerIndex > 0) warnings.push(`${headerIndex} leading comment lines beginning with "#" were skipped.`);

  const delimiter = detectDelimiter(lines[headerIndex]);
  const header = splitLine(lines[headerIndex], delimiter).map((h) => h.replace(/^"|"$/g, ''));
  let dataLines = lines.slice(headerIndex + 1);

  // USGS RDB files carry a format line ("5s 15s 20d") after the header.
  if (dataLines.length > 0 && /^\d+[sdn](\s|$)/.test(splitLine(dataLines[0], delimiter)[0] ?? '')) {
    dataLines = dataLines.slice(1);
    warnings.push('A USGS RDB format-specification line was detected after the header and skipped.');
  }

  const maxRows = opts.maxRows ?? 200_000;
  if (dataLines.length > maxRows) {
    warnings.push(`The file has ${dataLines.length.toLocaleString()} rows; the profile was computed from the first ${maxRows.toLocaleString()}.`);
    dataLines = dataLines.slice(0, maxRows);
  }

  const columns: string[][] = header.map(() => []);
  let ragged = 0;
  for (const line of dataLines) {
    const cells = splitLine(line, delimiter);
    if (cells.length !== header.length) ragged++;
    for (let i = 0; i < header.length; i++) columns[i].push((cells[i] ?? '').replace(/^"|"$/g, ''));
  }
  if (ragged > 0) warnings.push(`${ragged} rows do not have the same number of fields as the header; missing fields were treated as empty.`);

  const variables: DatasetVariable[] = header.map((name, i) => {
    const raw = columns[i];
    const nonEmpty = raw.filter((v) => v !== '' && v.toLowerCase() !== 'na' && v.toLowerCase() !== 'nan' && v !== '-999' && v !== '-9999');
    const role = inferRole(name, nonEmpty);
    const numeric = nonEmpty.map(Number).filter((v) => Number.isFinite(v));
    const isNumeric = nonEmpty.length > 0 && numeric.length / nonEmpty.length > 0.9;
    const missingCount = raw.length - nonEmpty.length;

    let outlierCount = 0;
    if (isNumeric && numeric.length >= 20) {
      const { lower, upper } = iqrOutlierBounds(numeric, 3);
      outlierCount = numeric.filter((v) => v < lower || v > upper).length;
    }

    return {
      name,
      role,
      dtype: isNumeric ? 'number' : role === 'time' ? 'datetime' : 'string',
      unit: inferUnit(name),
      missingCount,
      missingPct: raw.length === 0 ? 0 : (missingCount / raw.length) * 100,
      min: isNumeric && numeric.length ? Math.min(...numeric) : null,
      max: isNumeric && numeric.length ? Math.max(...numeric) : null,
      mean: isNumeric && numeric.length ? mean(numeric) : null,
      stdDev: isNumeric && numeric.length > 1 ? stdDev(numeric) : null,
      outlierCount,
      distinctCount: isNumeric ? null : new Set(nonEmpty).size,
    };
  });

  // Temporal coverage from the first time column.
  const timeVar = variables.find((v) => v.role === 'time');
  let temporalCoverage: DatasetProfile['temporalCoverage'] = null;
  if (timeVar) {
    const idx = header.indexOf(timeVar.name);
    const dates = columns[idx].filter((v) => looksLikeDate(v)).map((v) => v.slice(0, 10)).sort();
    if (dates.length >= 2) {
      const spanDays = (Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86400000;
      const stepDays = spanDays / Math.max(dates.length - 1, 1);
      temporalCoverage = {
        start: dates[0],
        end: dates[dates.length - 1],
        step: stepDays < 0.5 ? 'sub-daily' : stepDays < 1.5 ? 'daily' : stepDays < 10 ? 'weekly' : stepDays < 40 ? 'monthly' : 'irregular',
      };
      const expected = Math.round(spanDays / Math.max(stepDays, 1e-9)) + 1;
      if (dates.length < expected * 0.95) {
        warnings.push(`The time column has ${dates.length.toLocaleString()} values but spans ${Math.round(spanDays)} days at an apparent ${temporalCoverage.step} step — the series has gaps.`);
      }
    } else {
      warnings.push('A time column was identified but fewer than two parseable dates were found.');
    }
  } else {
    warnings.push('No time column was identified. Time-series analyses need a column recognised as a date.');
  }

  // Spatial coverage from latitude/longitude columns.
  const latVar = variables.find((v) => v.role === 'latitude');
  const lonVar = variables.find((v) => v.role === 'longitude');
  let spatialCoverage: DatasetProfile['spatialCoverage'] = null;
  if (latVar && lonVar && latVar.min !== null && lonVar.min !== null) {
    spatialCoverage = { minLon: lonVar.min, minLat: latVar.min, maxLon: lonVar.max!, maxLat: latVar.max! };
    if (latVar.min < -90 || latVar.max! > 90 || lonVar.min < -180 || lonVar.max! > 180) {
      warnings.push('Latitude or longitude values fall outside valid WGS 84 ranges. The coordinates may be in a projected CRS.');
    }
  }

  const totalCells = variables.length * dataLines.length;
  const missingCells = variables.reduce((s, v) => s + v.missingCount, 0);

  const qualityFlags: string[] = [];
  for (const v of variables) {
    if (v.missingPct > 20) qualityFlags.push(`${v.name}: ${v.missingPct.toFixed(1)} % missing`);
    if (v.outlierCount > 0 && v.role === 'value') qualityFlags.push(`${v.name}: ${v.outlierCount} values beyond 3×IQR`);
    if (v.role === 'value' && v.unit === null) qualityFlags.push(`${v.name}: no unit could be inferred from the column name`);
  }
  if (variables.filter((v) => v.role === 'value').length === 0) {
    warnings.push('No numeric value column was identified. Check the delimiter and header row.');
  }

  return {
    datasetId: opts.datasetId,
    name: opts.name,
    format: opts.format,
    rows: dataLines.length,
    columns: header.length,
    temporalCoverage,
    spatialCoverage,
    crs: spatialCoverage ? 'EPSG:4326 (assumed)' : null,
    variables,
    missingDataPct: totalCells === 0 ? 0 : (missingCells / totalCells) * 100,
    qualityFlags,
    warnings,
    profiledAt: new Date().toISOString(),
  };
}

export function emptyProfile(opts: ProfileOptions, warnings: string[]): DatasetProfile {
  return {
    datasetId: opts.datasetId,
    name: opts.name,
    format: opts.format,
    rows: 0,
    columns: 0,
    temporalCoverage: null,
    spatialCoverage: null,
    crs: null,
    variables: [],
    missingDataPct: 0,
    qualityFlags: [],
    warnings,
    profiledAt: new Date().toISOString(),
  };
}

/** Profile for a binary format that needs the Python service. */
export function binaryFormatProfile(opts: ProfileOptions, serviceAvailable: boolean): DatasetProfile {
  return emptyProfile(opts, [
    `${opts.format.toUpperCase()} files are profiled by the Python scientific service, which has the xarray, rasterio, geopandas and pyarrow readers.`,
    serviceAvailable
      ? 'The service is reachable but returned no profile for this file. Check the service logs.'
      : 'The Python scientific service is not configured or not reachable, so this file has been stored but not profiled. Set SCIENCE_SERVICE_URL and restart the API.',
    'The file has been stored unchanged. No structure has been inferred or assumed.',
  ]);
}
