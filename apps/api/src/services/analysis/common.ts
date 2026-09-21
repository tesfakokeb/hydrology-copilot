import type { ChartSpec, MapSpec, Quantity, ToolResult, Unit } from '@hydro/shared-types';
import { formatQuantity } from '@hydro/units';
import type { DataAccess } from '../../store/types.js';
import { ProvenanceBuilder } from '../provenance.js';

export interface ToolContext {
  db: DataAccess;
  projectId: string;
  userId: string | null;
  watershedId: string | null;
  unitSystem: 'SI' | 'US';
  scienceServiceUrl: string | null;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** Streams tool-progress lines to the client over the WebSocket. */
  emit?: (label: string, status: 'ok' | 'warn' | 'fail', detail?: string | null) => void;
}

export function q(value: number | null, unit: Unit): Quantity {
  return { value: value === null || !Number.isFinite(value) ? null : value, unit };
}

export function fmt(value: number | null, unit: string, precision?: number): string {
  return formatQuantity(value, unit, { precision });
}

export function ok(
  summary: string,
  parts: Partial<Omit<ToolResult, 'ok' | 'summary'>> & { provenance: ToolResult['provenance'] },
): ToolResult {
  return {
    ok: true,
    summary,
    data: parts.data ?? {},
    charts: parts.charts ?? [],
    maps: parts.maps ?? [],
    metrics: parts.metrics ?? {},
    quantities: parts.quantities ?? {},
    warnings: parts.warnings ?? [],
    provenance: parts.provenance,
  };
}

export function insufficient(builder: ProvenanceBuilder, reason: string, inputs: unknown): ToolResult {
  builder.limit(reason);
  return {
    ok: false,
    summary: reason,
    data: { insufficientData: true },
    charts: [],
    maps: [],
    metrics: {},
    quantities: {},
    warnings: [reason],
    provenance: builder.build(inputs),
  };
}

export const CHART_COLORS = {
  observed: '#0f6fb8',
  simulated: '#e0721c',
  forecast: '#7b3ff2',
  band: '#c7ddf0',
  threshold: '#c0392b',
  secondary: '#12897b',
  neutral: '#64748b',
};

export function lineChart(spec: Omit<ChartSpec, 'id' | 'kind'> & { kind?: ChartSpec['kind'] }): ChartSpec {
  return { id: `chart-${Math.random().toString(36).slice(2, 10)}`, kind: spec.kind ?? 'line', ...spec };
}

export function mapSpec(spec: Omit<MapSpec, 'id'>): MapSpec {
  return { id: `map-${Math.random().toString(36).slice(2, 10)}`, ...spec };
}

/** ISO date arithmetic helpers used throughout the analysis services. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Resolve a requested period against the extent of the available record. */
export function resolvePeriod(
  available: { start: string; end: string },
  requested?: { start?: string; end?: string },
): { start: string; end: string; clipped: string[] } {
  const clipped: string[] = [];
  let start = requested?.start ?? available.start;
  let end = requested?.end ?? available.end;
  if (start < available.start) {
    clipped.push(`Requested start ${start} precedes the record, which begins ${available.start}.`);
    start = available.start;
  }
  if (end > available.end) {
    clipped.push(`Requested end ${end} follows the record, which ends ${available.end}.`);
    end = available.end;
  }
  if (start > end) {
    clipped.push('Requested period is empty after clipping to the available record; the full record was used.');
    start = available.start;
    end = available.end;
  }
  return { start, end, clipped };
}
