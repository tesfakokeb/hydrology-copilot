import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { Card, ErrorState, LoadingPanel, PageHeader, StatusPill, Tabs } from '@/components/ui';
import { api } from '@/services/api';

const DROUGHT_COLORS: Record<string, string> = {
  D4: '#730000', D3: '#e60000', D2: '#ffaa00', D1: '#fcd37f', D0: '#ffff00',
  Normal: '#e8ecef', W0: '#d7f0ff', W1: '#9ed7f5', W2: '#5aabe0', W3: '#1f78b4', W4: '#0b3d6b',
};

type Tab = 'assessment' | 'indices' | 'events';

export function Drought() {
  const [tab, setTab] = useState<Tab>('assessment');
  const [index, setIndex] = useState<'SPI' | 'SPEI' | 'SSI'>('SPI');
  const [timescale, setTimescale] = useState(3);

  const assessment = useQuery({ queryKey: ['drought'], queryFn: api.drought });
  const indexResult = useQuery({
    queryKey: ['drought-index', index, timescale],
    queryFn: () => api.droughtIndex({ index, timescaleMonths: timescale }),
    enabled: tab === 'indices' || tab === 'events',
  });

  const current = (assessment.data?.data.assessment as { current: { index: string; timescaleMonths: number; value: number; classification: { label: string; category: string } }[] } | undefined)?.current ?? [];
  const events = (indexResult.data?.data.events as { start: string; end: string; durationMonths: number; severity: number; peakIntensity: number; peakCategory: string }[]) ?? [];

  return (
    <>
      <PageHeader
        title="Drought"
        description="Standardised drought indices at multiple timescales, US Drought Monitor classification, event identification and a narrative assessment."
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'assessment', label: 'Assessment' },
          { id: 'indices', label: 'Index explorer' },
          { id: 'events', label: 'Historical events', count: events.length || undefined },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === 'assessment' && (
          <>
            {assessment.isLoading && <LoadingPanel label="Computing SPI, SPEI and the streamflow drought index…" lines={6} />}
            {assessment.error && <ErrorState error={assessment.error} retry={() => void assessment.refetch()} />}
            {assessment.data && (
              <>
                <Card title="Current conditions" subtitle="Each index answers a different question; disagreement between them is informative">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                    {current.map((c) => (
                      <div
                        key={`${c.index}-${c.timescaleMonths}`}
                        className="rounded-md border border-ink-200 p-2"
                        style={{ borderLeftWidth: 4, borderLeftColor: DROUGHT_COLORS[c.classification.category] ?? '#cbd5e1' }}
                      >
                        <p className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                          {c.index}-{c.timescaleMonths}
                        </p>
                        <p className="text-xl font-semibold tabular text-ink-900">{c.value.toFixed(2)}</p>
                        <p className="mt-0.5 text-2xs leading-snug text-ink-600">{c.classification.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {['D0', 'D1', 'D2', 'D3', 'D4'].map((cat) => (
                      <span key={cat} className="chip border-ink-200" style={{ background: DROUGHT_COLORS[cat], color: cat === 'D0' ? '#3f3f00' : '#fff' }}>
                        {cat}
                      </span>
                    ))}
                    <span className="ml-2 self-center text-2xs text-ink-500">US Drought Monitor category breakpoints on the standardised index scale</span>
                  </div>
                </Card>

                <AnalysisResult result={assessment.data} title="Multi-index drought assessment" chartHeight={320} />
              </>
            )}
          </>
        )}

        {(tab === 'indices' || tab === 'events') && (
          <Card title="Index configuration" bodyClassName="flex flex-wrap items-end gap-4 p-4">
            <div>
              <label className="label" htmlFor="index-select">
                Index
              </label>
              <select id="index-select" className="input !w-auto" value={index} onChange={(e) => setIndex(e.target.value as typeof index)}>
                <option value="SPI">SPI — Standardized Precipitation Index</option>
                <option value="SPEI">SPEI — with evapotranspiration</option>
                <option value="SSI">SSI — streamflow drought index</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="scale-select">
                Accumulation timescale
              </label>
              <select id="scale-select" className="input !w-auto" value={timescale} onChange={(e) => setTimescale(Number(e.target.value))}>
                {[1, 3, 6, 9, 12, 24].map((m) => (
                  <option key={m} value={m}>
                    {m} month{m > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="max-w-md text-2xs leading-snug text-ink-500">
              Short timescales respond to recent rainfall and track agricultural drought; long timescales accumulate deficit
              and track hydrological drought.
            </p>
          </Card>
        )}

        {tab === 'indices' && (
          <>
            {indexResult.isLoading && <LoadingPanel label={`Fitting ${index}-${timescale}…`} />}
            {indexResult.error && <ErrorState error={indexResult.error} />}
            {indexResult.data && <AnalysisResult result={indexResult.data} title={`${index}-${timescale}`} chartHeight={340} />}
          </>
        )}

        {tab === 'events' && (
          <>
            {indexResult.isLoading && <LoadingPanel label="Identifying drought episodes…" />}
            {indexResult.data && (
              <Card
                title={`Drought episodes on ${index}-${timescale}`}
                subtitle="Contiguous runs at or below −0.8 (moderate drought). Severity is the accumulated magnitude of the index over the episode."
              >
                {events.length === 0 ? (
                  <p className="text-xs text-ink-500">No episodes at or below −0.8 in this record.</p>
                ) : (
                  <div className="max-h-96 overflow-y-auto">
                    <table className="table-scientific">
                      <thead className="sticky top-0">
                        <tr>
                          <th>Start</th>
                          <th>End</th>
                          <th className="num">Duration (months)</th>
                          <th className="num">Severity</th>
                          <th className="num">Peak intensity</th>
                          <th>Peak category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...events].reverse().map((e, i) => (
                          <tr key={i}>
                            <td>{e.start}</td>
                            <td>{e.end}</td>
                            <td className="num">{e.durationMonths}</td>
                            <td className="num">{formatNumber(e.severity)}</td>
                            <td className="num">{formatNumber(e.peakIntensity)}</td>
                            <td>
                              <StatusPill
                                status={e.peakCategory === 'D4' || e.peakCategory === 'D3' ? 'critical' : e.peakCategory === 'D2' ? 'warning' : 'watch'}
                                dot={false}
                              >
                                {e.peakCategory}
                              </StatusPill>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
