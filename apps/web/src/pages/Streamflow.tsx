import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { Card, ErrorState, LoadingPanel, PageHeader, Tabs } from '@/components/ui';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';

type Tab = 'statistics' | 'events' | 'record';

export function Streamflow() {
  const { dateRange } = useApp();
  const [tab, setTab] = useState<Tab>('statistics');
  const [stationId, setStationId] = useState<string | undefined>();
  const [thresholdPercentile, setThresholdPercentile] = useState(99);

  const stations = useQuery({ queryKey: ['stations', 'streamgage'], queryFn: () => api.stations({ type: 'streamgage' }) });

  const params = { stationId, start: dateRange.start ?? undefined, end: dateRange.end ?? undefined };
  const statistics = useQuery({
    queryKey: ['streamflow-stats', params],
    queryFn: () => api.streamflowStatistics(params),
    enabled: tab === 'statistics',
  });
  const events = useQuery({
    queryKey: ['streamflow-events', stationId, thresholdPercentile],
    queryFn: () => api.streamflowEvents({ stationId, thresholdPercentile }),
    enabled: tab === 'events',
  });
  const record = useQuery({
    queryKey: ['streamflow-record', params],
    queryFn: () => api.streamflow(params),
    enabled: tab === 'record',
  });

  const stats = statistics.data?.data.statistics as
    | {
        count: number;
        missing: number;
        mean: number;
        median: number;
        min: number;
        max: number;
        stdDev: number;
        skew: number;
        cv: number;
        unit: string;
        flowDuration: Record<string, number>;
        q7d10: number | null;
        baseflowIndex: number | null;
        annualPeaks?: { waterYear: number; peak: number; date: string }[];
      }
    | undefined;

  return (
    <>
      <PageHeader
        title="Streamflow"
        description="Descriptive statistics, flow-duration analysis, low-flow statistics, baseflow separation and event extraction from the discharge record."
        actions={
          <select className="input !w-auto !py-1 text-xs" value={stationId ?? ''} onChange={(e) => setStationId(e.target.value || undefined)}>
            <option value="">Outlet gauge (default)</option>
            {(stations.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'statistics', label: 'Statistics & flow duration' },
          { id: 'events', label: 'Events & annual peaks' },
          { id: 'record', label: 'Record' },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === 'statistics' && (
          <>
            {statistics.isLoading && <LoadingPanel label="Computing flow statistics…" />}
            {statistics.error && <ErrorState error={statistics.error} retry={() => void statistics.refetch()} />}
            {statistics.data && (
              <>
                <AnalysisResult result={statistics.data} title="Flow statistics" chartHeight={320} />
                {stats && (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <Card title="Descriptive statistics" subtitle={`${stats.count.toLocaleString()} daily values, ${stats.missing} missing`}>
                      <table className="table-scientific">
                        <tbody>
                          {[
                            ['Mean', stats.mean],
                            ['Median', stats.median],
                            ['Minimum', stats.min],
                            ['Maximum', stats.max],
                            ['Standard deviation', stats.stdDev],
                            ['Coefficient of variation', stats.cv],
                            ['Skewness', stats.skew],
                            ['7Q10 low flow', stats.q7d10],
                            ['Baseflow index', stats.baseflowIndex],
                          ].map(([label, value]) => (
                            <tr key={label as string}>
                              <td>{label as string}</td>
                              <td className="num">{formatNumber(value as number)}</td>
                              <td className="w-16 text-ink-500">
                                {label === 'Coefficient of variation' || label === 'Skewness' || label === 'Baseflow index'
                                  ? ''
                                  : 'm³/s'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>

                    <Card title="Flow-duration percentiles" subtitle="Discharge equalled or exceeded p % of the time">
                      <table className="table-scientific">
                        <thead>
                          <tr>
                            <th>Percentile</th>
                            <th className="num">Discharge (m³/s)</th>
                            <th>Interpretation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(stats.flowDuration).map(([k, v]) => (
                            <tr key={k}>
                              <td>{k}</td>
                              <td className="num">{formatNumber(v)}</td>
                              <td className="text-ink-500">
                                {k === 'Q1' && 'High-flow / flood range'}
                                {k === 'Q10' && 'High flow'}
                                {k === 'Q50' && 'Median flow'}
                                {k === 'Q90' && 'Low flow'}
                                {k === 'Q95' && 'Low-flow threshold, common regulatory reference'}
                                {k === 'Q99' && 'Extreme low flow'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'events' && (
          <>
            <Card title="Event threshold" bodyClassName="p-4">
              <label className="label" htmlFor="threshold">
                Percentile of the daily record defining an event
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="threshold"
                  type="range"
                  min={90}
                  max={99.9}
                  step={0.1}
                  value={thresholdPercentile}
                  onChange={(e) => setThresholdPercentile(Number(e.target.value))}
                  className="w-64 accent-hydro-600"
                />
                <span className="text-sm font-semibold tabular text-ink-900">Q{thresholdPercentile.toFixed(1)}</span>
              </div>
              <p className="mt-2 text-2xs text-ink-500">
                A higher percentile identifies fewer, larger events. The choice materially affects the event count, which is
                why it is exposed rather than fixed.
              </p>
            </Card>

            {events.isLoading && <LoadingPanel label="Extracting events…" />}
            {events.error && <ErrorState error={events.error} />}
            {events.data && (
              <>
                <AnalysisResult result={events.data} title="Peak-over-threshold events" />
                <Card title="Largest events in the record" subtitle="Ranked by peak daily mean discharge">
                  <div className="max-h-80 overflow-y-auto">
                    <table className="table-scientific">
                      <thead className="sticky top-0">
                        <tr>
                          <th>Start</th>
                          <th>End</th>
                          <th className="num">Duration (d)</th>
                          <th className="num">Peak (m³/s)</th>
                          <th>Peak date</th>
                          <th className="num">Mean flow (m³/s)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {((events.data.data.largestEvents as Record<string, number | string>[]) ?? []).map((e, i) => (
                          <tr key={i}>
                            <td>{e.start as string}</td>
                            <td>{e.end as string}</td>
                            <td className="num">{e.durationDays as number}</td>
                            <td className="num font-semibold">{formatNumber(e.peak as number)}</td>
                            <td>{e.peakDate as string}</td>
                            <td className="num">{formatNumber(e.meanFlow as number)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            )}
          </>
        )}

        {tab === 'record' && (
          <>
            {record.isLoading && <LoadingPanel label="Loading the discharge record…" />}
            {record.error && <ErrorState error={record.error} />}
            {record.data && <AnalysisResult result={record.data} title="Discharge record" chartHeight={340} />}
          </>
        )}
      </div>
    </>
  );
}
