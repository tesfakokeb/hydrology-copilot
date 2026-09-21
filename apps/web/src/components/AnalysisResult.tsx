import type { ToolResult } from '@hydro/shared-types';
import { formatQuantity } from '@hydro/units';
import type { ReactNode } from 'react';
import { ChartRenderer } from './ChartRenderer';
import { MapRenderer } from './MapRenderer';
import { ProvenancePanel } from './ProvenancePanel';
import { Card, InsufficientData, Metric, WarningList } from './ui';

/**
 * Renders a ToolResult — the single shape every analytical endpoint returns.
 *
 * Because the summary, quantities, metrics, charts, maps, warnings and
 * provenance all come from the same object, a page cannot show a figure
 * without also showing what produced it.
 */
export function AnalysisResult({
  result,
  title,
  subtitle,
  actions,
  children,
  showCharts = true,
  showMaps = true,
  chartHeight = 300,
}: {
  result: ToolResult;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
  showCharts?: boolean;
  showMaps?: boolean;
  chartHeight?: number;
}) {
  if (!result.ok && (result.data as { insufficientData?: boolean })?.insufficientData) {
    return (
      <Card title={title} subtitle={subtitle} actions={actions}>
        <InsufficientData message={result.summary} />
        <div className="mt-3">
          <ProvenancePanel record={result.provenance} />
        </div>
      </Card>
    );
  }

  const quantities = Object.entries(result.quantities ?? {});
  const metrics = Object.entries(result.metrics ?? {}).filter(
    ([k, v]) => v !== null && v !== undefined && Number.isFinite(v) && !quantities.some(([qk]) => qk === k),
  );

  return (
    <Card title={title} subtitle={subtitle} actions={actions} bodyClassName="space-y-4 p-4">
      <p className="text-sm leading-relaxed text-ink-800">{result.summary}</p>

      {quantities.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {quantities.map(([key, q]) => (
            <Metric key={key} label={humanise(key)} value={formatQuantity(q.value, q.unit, { hideUnit: true })} unit={unitLabel(q.unit)} />
          ))}
        </div>
      )}

      <WarningList warnings={result.warnings} />

      {children}

      {showCharts && result.charts.map((c) => <ChartRenderer key={c.id} spec={c} height={chartHeight} />)}
      {showMaps && result.maps.map((m) => <MapRenderer key={m.id} spec={m} />)}

      {metrics.length > 0 && (
        <details className="rounded-md border border-ink-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-600">
            All metrics ({metrics.length})
          </summary>
          <div className="border-t border-ink-200 p-3">
            <table className="table-scientific">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map(([k, v]) => (
                  <tr key={k}>
                    <td>{humanise(k)}</td>
                    <td className="num">{formatNumber(v as number)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <ProvenancePanel record={result.provenance} />
    </Card>
  );
}

export function humanise(key: string): string {
  return key
    .replace(/\./g, ' · ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export function formatNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function unitLabel(unit: string): string {
  const map: Record<string, string> = {
    'm3/s': 'm³/s',
    'ft3/s': 'ft³/s',
    km2: 'km²',
    mi2: 'mi²',
    degC: '°C',
    degF: '°F',
    dimensionless: '',
  };
  return map[unit] ?? unit;
}
