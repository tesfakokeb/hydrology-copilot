import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { Card, ErrorState, LoadingPanel, PageHeader, StatusPill, Tabs } from '@/components/ui';
import { api } from '@/services/api';

type Tab = 'index' | 'trends' | 'thresholds' | 'anomalies';

const RATING_STATUS: Record<string, 'normal' | 'watch' | 'warning' | 'critical'> = {
  Excellent: 'normal',
  Good: 'normal',
  Fair: 'watch',
  Marginal: 'warning',
  Poor: 'critical',
};

export function WaterQuality() {
  const [tab, setTab] = useState<Tab>('index');
  const [stationId, setStationId] = useState<string | undefined>();

  const stations = useQuery({ queryKey: ['stations', 'water_quality'], queryFn: () => api.stations({ type: 'water_quality' }) });
  const result = useQuery({ queryKey: ['water-quality', stationId], queryFn: () => api.waterQuality({ stationId }) });

  const data = result.data?.data as
    | {
        wqi: { wqi: number; rating: string; f1Scope: number; f2Frequency: number; f3Amplitude: number; parametersUsed: string[]; period: { start: string; end: string }; exceedances: { parameter: string; count: number; total: number; pct: number }[] };
        wqiByStation: { stationCode: string; stationName: string; result: { wqi: number; rating: string } }[];
        trends: { parameter: string; label: string; unit: string; n: number; slopePerYear: number; pValue: number; direction: string; significant: boolean; method: string }[];
        anomalies: { t: string; parameter: string; value: number; modifiedZ: number; severity: string }[];
        correlations: { a: string; b: string; rho: number; n: number }[];
        thresholds: { parameter: string; unit: string; direction: string; min?: number; max?: number; source: string }[];
        parameterLabels: Record<string, string>;
      }
    | undefined;

  return (
    <>
      <PageHeader
        title="Water Quality"
        description="CCME Water Quality Index, criterion exceedances, non-parametric trend tests, anomaly detection and parameter correlations."
        actions={
          <select className="input !w-auto !py-1 text-xs" value={stationId ?? ''} onChange={(e) => setStationId(e.target.value || undefined)}>
            <option value="">All stations</option>
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
          { id: 'index', label: 'Water Quality Index' },
          { id: 'trends', label: 'Trends', count: data?.trends.length },
          { id: 'thresholds', label: 'Criteria & exceedances' },
          { id: 'anomalies', label: 'Anomalies', count: data?.anomalies.length },
        ]}
      />

      <div className="mt-4 space-y-4">
        {result.isLoading && <LoadingPanel label="Screening results and computing the index…" lines={6} />}
        {result.error && <ErrorState error={result.error} retry={() => void result.refetch()} />}

        {result.data && data && (
          <>
            {tab === 'index' && (
              <>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <Card title="CCME Water Quality Index" subtitle={`${data.wqi.period.start} to ${data.wqi.period.end}`}>
                    <div className="flex items-baseline gap-3">
                      <span className="text-4xl font-semibold tabular text-ink-900">{data.wqi.wqi.toFixed(1)}</span>
                      <StatusPill status={RATING_STATUS[data.wqi.rating] ?? 'unknown'}>{data.wqi.rating}</StatusPill>
                    </div>
                    <table className="table-scientific mt-3">
                      <tbody>
                        <tr>
                          <td>F1 — scope (variables failing)</td>
                          <td className="num">{formatNumber(data.wqi.f1Scope)}</td>
                        </tr>
                        <tr>
                          <td>F2 — frequency (tests failing)</td>
                          <td className="num">{formatNumber(data.wqi.f2Frequency)}</td>
                        </tr>
                        <tr>
                          <td>F3 — amplitude (excursion size)</td>
                          <td className="num">{formatNumber(data.wqi.f3Amplitude)}</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="mt-2 text-2xs leading-snug text-ink-500">
                      The index is sensitive to which parameters are included: adding a parameter that never fails raises the
                      score. {data.wqi.parametersUsed.length} parameters were used.
                    </p>
                  </Card>

                  <Card title="Index by station" className="lg:col-span-2">
                    <table className="table-scientific">
                      <thead>
                        <tr>
                          <th>Station</th>
                          <th className="num">WQI</th>
                          <th>Rating</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.wqiByStation.map((s) => (
                          <tr key={s.stationCode}>
                            <td>{s.stationName}</td>
                            <td className="num font-semibold">{s.result.wqi.toFixed(1)}</td>
                            <td>
                              <StatusPill status={RATING_STATUS[s.result.rating] ?? 'unknown'} dot={false}>
                                {s.result.rating}
                              </StatusPill>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>

                <AnalysisResult result={result.data} title="Assessment" chartHeight={300} />
              </>
            )}

            {tab === 'trends' && (
              <Card
                title="Trend tests"
                subtitle="Seasonal Mann–Kendall where the record supports it, otherwise Mann–Kendall; slope by Theil–Sen. Non-parametric tests are used because water-quality records are typically non-normal and irregularly sampled."
              >
                <table className="table-scientific">
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      <th className="num">n</th>
                      <th className="num">Slope / year</th>
                      <th className="num">p-value</th>
                      <th>Direction</th>
                      <th>Method</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trends.map((t) => (
                      <tr key={t.parameter}>
                        <td>{t.label}</td>
                        <td className="num">{t.n}</td>
                        <td className="num">
                          {formatNumber(t.slopePerYear)} <span className="text-ink-400">{t.unit}</span>
                        </td>
                        <td className="num">{t.pValue < 0.001 ? '< 0.001' : t.pValue.toFixed(3)}</td>
                        <td>
                          {t.significant ? (
                            <StatusPill status={t.direction === 'increasing' ? 'warning' : 'normal'} dot={false}>
                              {t.direction}
                            </StatusPill>
                          ) : (
                            <span className="text-ink-500">no significant trend</span>
                          )}
                        </td>
                        <td className="text-ink-500">{t.method}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-2xs leading-relaxed text-ink-500">
                  Significance is assessed at α = 0.05. A statistically significant trend over a short record can be an
                  artefact of a changing monitoring programme rather than a change in the water.
                </p>
              </Card>
            )}

            {tab === 'thresholds' && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card title="Exceedance rates" subtitle="Proportion of samples outside the screening criterion">
                  <table className="table-scientific">
                    <thead>
                      <tr>
                        <th>Parameter</th>
                        <th className="num">Exceedances</th>
                        <th className="num">Samples</th>
                        <th className="num">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.wqi.exceedances]
                        .sort((a, b) => b.pct - a.pct)
                        .map((e) => (
                          <tr key={e.parameter}>
                            <td>{data.parameterLabels[e.parameter] ?? e.parameter}</td>
                            <td className="num">{e.count}</td>
                            <td className="num">{e.total}</td>
                            <td className="num">
                              <span className={e.pct > 25 ? 'font-semibold text-orange-700' : ''}>{e.pct.toFixed(1)} %</span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </Card>

                <Card title="Screening criteria" subtitle="General benchmarks, not the applicable standard for any specific waterbody">
                  <table className="table-scientific">
                    <thead>
                      <tr>
                        <th>Parameter</th>
                        <th>Criterion</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.thresholds.map((t) => (
                        <tr key={t.parameter}>
                          <td>{data.parameterLabels[t.parameter] ?? t.parameter}</td>
                          <td className="tabular">
                            {t.direction === 'max' && `≤ ${t.max} ${t.unit}`}
                            {t.direction === 'min' && `≥ ${t.min} ${t.unit}`}
                            {t.direction === 'range' && `${t.min} – ${t.max} ${t.unit}`}
                          </td>
                          <td className="text-ink-500">{t.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
            )}

            {tab === 'anomalies' && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card
                  title="Flagged results"
                  subtitle="Modified z-score above 3.5 (Iglewicz & Hoaglin). Robust to the anomalies it is looking for."
                >
                  {data.anomalies.length === 0 ? (
                    <p className="text-xs text-ink-500">No results were flagged.</p>
                  ) : (
                    <table className="table-scientific">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Parameter</th>
                          <th className="num">Value</th>
                          <th className="num">Modified z</th>
                          <th>Severity</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.anomalies.map((a, i) => (
                          <tr key={i}>
                            <td>{a.t}</td>
                            <td>{data.parameterLabels[a.parameter] ?? a.parameter}</td>
                            <td className="num">{formatNumber(a.value)}</td>
                            <td className="num">{a.modifiedZ}</td>
                            <td>
                              <StatusPill status={a.severity === 'extreme' ? 'critical' : 'warning'} dot={false}>
                                {a.severity}
                              </StatusPill>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card title="Parameter correlations" subtitle="Spearman rank correlation on paired samples">
                  <table className="table-scientific">
                    <thead>
                      <tr>
                        <th>Pair</th>
                        <th className="num">ρ</th>
                        <th className="num">n</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.correlations.map((c, i) => (
                        <tr key={i}>
                          <td>
                            {data.parameterLabels[c.a] ?? c.a} × {data.parameterLabels[c.b] ?? c.b}
                          </td>
                          <td className="num">
                            <span className={Math.abs(c.rho) > 0.6 ? 'font-semibold' : ''}>{c.rho.toFixed(2)}</span>
                          </td>
                          <td className="num">{c.n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-2xs text-ink-500">
                    Correlation between water-quality parameters usually reflects a shared driver — flow, temperature or a
                    common source — rather than a direct relationship between them.
                  </p>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
