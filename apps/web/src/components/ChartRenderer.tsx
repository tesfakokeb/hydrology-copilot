import type { ChartSpec } from '@hydro/shared-types';
import { unitSymbol } from '@hydro/units';
import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Renders a ChartSpec produced by the API.
 *
 * The API decides what the chart means — its title, axis labels, unit,
 * annotations and caption. This component only decides how it looks. That
 * split is deliberate: a caption written next to the computation cannot drift
 * away from the numbers the way a caption written in the UI would.
 */

const AXIS = { fontSize: 11, fill: '#697a90' };
const GRID = '#eceff3';

function niceNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  if (a === 0) return '0';
  return v.toFixed(3);
}

function ChartTooltip({ active, payload, label, unit }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; unit: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-ink-200 bg-white/97 px-2.5 py-2 shadow-panel">
      <p className="mb-1 text-2xs font-semibold text-ink-700">{label}</p>
      <ul className="space-y-0.5">
        {payload
          .filter((p) => p.value !== null && p.value !== undefined)
          .map((p, i) => (
            <li key={i} className="flex items-center gap-2 text-2xs">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden />
              <span className="text-ink-600">{p.name}</span>
              <span className="ml-auto font-medium tabular text-ink-900">
                {niceNumber(p.value)} {unitSymbol(unit)}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

export function ChartRenderer({ spec, height = 280 }: { spec: ChartSpec; height?: number }) {
  const [logScale, setLogScale] = useState(false);
  const canLog = useMemo(
    () => spec.kind === 'hydrograph' || spec.kind === 'fdc' || spec.kind === 'forecast',
    [spec.kind],
  );

  const bandKeys = spec.series.filter((s) => s.kind === 'band').map((s) => s.key);
  const lower = bandKeys.find((k) => k.toLowerCase().includes('lower'));
  const upper = bandKeys.find((k) => k.toLowerCase().includes('upper'));

  // Recharts stacks an Area range by drawing the lower bound transparent and
  // the band as the difference, so the band is computed here.
  const data = useMemo(() => {
    if (!lower || !upper) return spec.data;
    return spec.data.map((row) => {
      const lo = row[lower];
      const up = row[upper];
      return {
        ...row,
        __bandBase: typeof lo === 'number' ? lo : null,
        __bandSpan: typeof lo === 'number' && typeof up === 'number' ? up - lo : null,
      };
    });
  }, [spec.data, lower, upper]);

  if (spec.data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-ink-200 text-xs text-ink-500">
        No data to plot for this analysis.
      </div>
    );
  }

  const visibleSeries = spec.series.filter((s) => s.kind !== 'band');

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">{spec.title}</p>
          {spec.subtitle && <p className="text-2xs text-ink-500">{spec.subtitle}</p>}
        </div>
        {canLog && (
          <button
            type="button"
            className="btn btn-ghost !px-2 !py-0.5 text-2xs"
            onClick={() => setLogScale((v) => !v)}
            aria-pressed={logScale}
          >
            {logScale ? 'Linear scale' : 'Log scale'}
          </button>
        )}
      </figcaption>

      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="t"
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              minTickGap={36}
              label={{ value: spec.xLabel, position: 'insideBottom', offset: -2, style: { ...AXIS, fontSize: 10 } }}
            />
            <YAxis
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={58}
              scale={logScale ? 'log' : 'auto'}
              domain={logScale ? ['auto', 'auto'] : undefined}
              allowDataOverflow={logScale}
              tickFormatter={niceNumber}
              label={{
                value: `${spec.yLabel} (${unitSymbol(spec.unit)})`,
                angle: -90,
                position: 'insideLeft',
                style: { ...AXIS, fontSize: 10, textAnchor: 'middle' },
              }}
            />
            <Tooltip content={<ChartTooltip unit={spec.unit} />} />
            {visibleSeries.length > 1 && (
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="line" iconSize={10} />
            )}

            {lower && upper && (
              <>
                <Area dataKey="__bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                <Area
                  dataKey="__bandSpan"
                  stackId="band"
                  stroke="none"
                  fill="#c7ddf0"
                  fillOpacity={0.55}
                  name="Prediction interval"
                  legendType="none"
                  isAnimationActive={false}
                />
              </>
            )}

            {visibleSeries.map((s) => {
              const color = s.color ?? '#0f6fb8';
              if (spec.kind === 'bar') {
                return <Bar key={s.key} dataKey={s.key} name={s.label} fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} maxBarSize={42} />;
              }
              if (spec.kind === 'scatter') {
                return <Scatter key={s.key} dataKey={s.key} name={s.label} fill={color} isAnimationActive={false} />;
              }
              if (spec.kind === 'area') {
                return (
                  <Area
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stroke={color}
                    strokeWidth={1.4}
                    fill={color}
                    fillOpacity={0.16}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                );
              }
              return (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={color}
                  strokeWidth={s.kind === 'forecast' ? 2 : 1.4}
                  strokeDasharray={s.kind === 'forecast' ? '5 3' : undefined}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              );
            })}

            {(spec.annotations ?? []).map((a, i) =>
              a.kind === 'hline' ? (
                <ReferenceLine
                  key={i}
                  y={a.value as number}
                  stroke={a.color ?? '#c0392b'}
                  strokeDasharray="4 3"
                  strokeWidth={1}
                  label={{ value: a.label, position: 'insideTopRight', fontSize: 9.5, fill: a.color ?? '#c0392b' }}
                />
              ) : a.kind === 'vline' ? (
                <ReferenceLine
                  key={i}
                  x={a.value as string}
                  stroke={a.color ?? '#697a90'}
                  strokeDasharray="4 3"
                  label={{ value: a.label, position: 'insideTopLeft', fontSize: 9.5, fill: a.color ?? '#697a90' }}
                />
              ) : null,
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-2xs leading-relaxed text-ink-500">{spec.caption}</p>
    </figure>
  );
}
