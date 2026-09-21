import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { Card, ErrorState, LoadingPanel, PageHeader, StatusPill, Tabs, WarningList } from '@/components/ui';
import { api } from '@/services/api';

type Tab = 'frequency' | 'risk' | 'query';

export function FloodRisk() {
  const [tab, setTab] = useState<Tab>('frequency');
  const [discharge, setDischarge] = useState('');
  const [submitted, setSubmitted] = useState<number | null>(null);

  const frequency = useQuery({ queryKey: ['flood-frequency'], queryFn: () => api.floodFrequency({}) });
  const risk = useQuery({ queryKey: ['flood-risk', 7], queryFn: () => api.floodRisk({ horizonDays: 7 }), enabled: tab === 'risk' });
  const returnPeriod = useQuery({
    queryKey: ['return-period', submitted],
    queryFn: () => api.returnPeriod(submitted!),
    enabled: submitted !== null,
  });

  const comparison = (frequency.data?.data.comparison as { returnPeriodYears: number; lp3: number; gev: number | null; lower95: number | null; upper95: number | null }[]) ?? [];
  const encounter = (frequency.data?.data.encounterProbabilities as { horizonYears: number; p100: number; p500: number }[]) ?? [];

  return (
    <>
      <PageHeader
        title="Flood Risk"
        description="Flood-frequency analysis by log-Pearson III and GEV, a probabilistic short-range outlook, and return-period lookup."
      />

      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-xs font-semibold text-amber-900">These are analytical model outputs, not regulatory products</p>
        <p className="mt-1 text-2xs leading-relaxed text-amber-900">
          Nothing on this page is a FEMA flood hazard determination, an effective Flood Insurance Rate Map product, or a
          regulatory Base Flood Elevation. Regulatory floodplain, floodway and BFE determinations may only be made from
          effective FEMA products or an accepted Letter of Map Change.
        </p>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'frequency', label: 'Flood frequency' },
          { id: 'risk', label: 'Risk outlook' },
          { id: 'query', label: 'Return-period lookup' },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === 'frequency' && (
          <>
            {frequency.isLoading && <LoadingPanel label="Fitting flood-frequency distributions…" />}
            {frequency.error && <ErrorState error={frequency.error} retry={() => void frequency.refetch()} />}
            {frequency.data && (
              <>
                <AnalysisResult result={frequency.data} title="Flood-frequency analysis" chartHeight={320} />

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card title="Design discharges" subtitle="Two distributions fitted to the same annual peak series">
                    <table className="table-scientific">
                      <thead>
                        <tr>
                          <th className="num">Return period (yr)</th>
                          <th className="num">AEP</th>
                          <th className="num">LP3 (m³/s)</th>
                          <th className="num">GEV (m³/s)</th>
                          <th className="num">LP3 95 % interval</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.map((q) => (
                          <tr key={q.returnPeriodYears}>
                            <td className="num">{q.returnPeriodYears}</td>
                            <td className="num">{(100 / q.returnPeriodYears).toFixed(1)} %</td>
                            <td className="num font-semibold">{formatNumber(q.lp3)}</td>
                            <td className="num">{formatNumber(q.gev)}</td>
                            <td className="num text-ink-500">
                              {q.lower95 ? `${formatNumber(q.lower95)} – ${formatNumber(q.upper95)}` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-2xs leading-relaxed text-ink-500">
                      The spread between LP3 and GEV at long return periods is a direct measure of distribution-choice
                      uncertainty, which is usually larger than people expect and is rarely reported.
                    </p>
                  </Card>

                  <Card title="Encounter probability" subtitle="Chance of at least one exceedance within a planning horizon: 1 − (1 − 1/T)ⁿ">
                    <table className="table-scientific">
                      <thead>
                        <tr>
                          <th className="num">Horizon (yr)</th>
                          <th className="num">1 %-annual-chance flood</th>
                          <th className="num">0.2 %-annual-chance flood</th>
                        </tr>
                      </thead>
                      <tbody>
                        {encounter.map((e) => (
                          <tr key={e.horizonYears}>
                            <td className="num">{e.horizonYears}</td>
                            <td className="num">{(e.p100 * 100).toFixed(1)} %</td>
                            <td className="num">{(e.p500 * 100).toFixed(1)} %</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-2xs leading-relaxed text-ink-500">
                      A “100-year flood” has roughly a 26 % chance of occurring at least once over a 30-year mortgage. The
                      return period is not a schedule.
                    </p>
                  </Card>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'risk' && (
          <>
            {risk.isLoading && <LoadingPanel label="Running the 300-member ensemble…" lines={5} />}
            {risk.error && <ErrorState error={risk.error} />}
            {risk.data && <AnalysisResult result={risk.data} title="Flood risk outlook" chartHeight={300} />}
          </>
        )}

        {tab === 'query' && (
          <>
            <Card title="Return-period lookup" bodyClassName="p-4">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = Number(discharge);
                  if (Number.isFinite(v) && v > 0) setSubmitted(v);
                }}
              >
                <div>
                  <label className="label" htmlFor="q">
                    Discharge (m³/s)
                  </label>
                  <input
                    id="q"
                    type="number"
                    min={0}
                    step="any"
                    className="input !w-48"
                    value={discharge}
                    onChange={(e) => setDischarge(e.target.value)}
                    placeholder="e.g. 2500"
                  />
                </div>
                <button type="submit" className="btn btn-primary">
                  Estimate return period
                </button>
              </form>
            </Card>

            {returnPeriod.isLoading && <LoadingPanel label="Ranking the annual peak series…" />}
            {returnPeriod.error && <ErrorState error={returnPeriod.error} />}
            {returnPeriod.data && <AnalysisResult result={returnPeriod.data} title="Return-period estimate" />}
          </>
        )}
      </div>
    </>
  );
}

export function FloodForecasting() {
  const [horizon, setHorizon] = useState(7);
  const risk = useQuery({ queryKey: ['flood-forecast', horizon], queryFn: () => api.floodRisk({ horizonDays: horizon }) });

  const byDay = (risk.data?.data.exceedanceByDay as { t: string; p: number }[]) ?? [];
  const actionByDay = (risk.data?.data.actionExceedanceByDay as { t: string; p: number }[]) ?? [];
  const thresholds = risk.data?.data.thresholds as { floodStage: number | null; actionStage: number | null; basis: string } | undefined;

  return (
    <>
      <PageHeader
        title="Flood Forecasting"
        description="Ensemble streamflow forecast converted into daily threshold-exceedance probabilities, a forecast peak, and a hazard classification."
        actions={
          <select className="input !w-auto !py-1 text-xs" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {[3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d}-day horizon
              </option>
            ))}
          </select>
        }
      />

      <Card
        title="Forecast chain"
        subtitle="What this deployment runs, and what a complete operational chain would add"
        className="mb-4"
      >
        <ol className="flex flex-wrap items-center gap-2 text-2xs">
          {[
            { label: 'Meteorological forecast', ok: false },
            { label: 'Hydrologic model', ok: true },
            { label: 'Streamflow ensemble', ok: true },
            { label: 'Hydraulic model', ok: false },
            { label: 'Flood inundation', ok: false },
            { label: 'Risk assessment', ok: true },
          ].map((step, i, arr) => (
            <li key={step.label} className="flex items-center gap-2">
              <StatusPill status={step.ok ? 'normal' : 'unknown'} dot={false}>
                {step.label}
              </StatusPill>
              {i < arr.length - 1 && <span className="text-ink-300">→</span>}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-2xs leading-relaxed text-ink-600">
          Two stages are not connected in this deployment. No quantitative precipitation forecast is ingested, so the
          streamflow ensemble runs on a zero-future-rainfall assumption and its exceedance probabilities are lower bounds
          during an approaching storm. No hydraulic model is configured, so inundation extent is illustrative rather than
          modelled. Both are adapter points, not missing science.
        </p>
      </Card>

      {risk.isLoading && <LoadingPanel label="Generating the ensemble…" lines={5} />}
      {risk.error && <ErrorState error={risk.error} retry={() => void risk.refetch()} />}

      {risk.data && (
        <div className="space-y-4">
          {thresholds && (
            <Card title="Thresholds in use" subtitle={thresholds.basis}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-md border border-ink-200 px-3 py-2">
                  <p className="text-2xs uppercase tracking-wide text-ink-500">Flood threshold</p>
                  <p className="text-lg font-semibold tabular text-ink-900">{formatNumber(thresholds.floodStage)} <span className="text-xs text-ink-500">m³/s</span></p>
                </div>
                <div className="rounded-md border border-ink-200 px-3 py-2">
                  <p className="text-2xs uppercase tracking-wide text-ink-500">Action threshold</p>
                  <p className="text-lg font-semibold tabular text-ink-900">{formatNumber(thresholds.actionStage)} <span className="text-xs text-ink-500">m³/s</span></p>
                </div>
              </div>
              <WarningList
                title="Threshold provenance"
                warnings={[
                  'These are statistical proxies derived from the annual peak record, not surveyed stages and not National Weather Service flood categories. Replace them with gauge-specific NWS categories before any operational use.',
                ]}
              />
            </Card>
          )}

          <Card title="Daily exceedance probability" subtitle="Fraction of the ensemble above each threshold on each forecast day">
            <table className="table-scientific">
              <thead>
                <tr>
                  <th>Forecast day</th>
                  <th className="num">P(flood threshold)</th>
                  <th className="num">P(action threshold)</th>
                </tr>
              </thead>
              <tbody>
                {byDay.map((d, i) => (
                  <tr key={d.t}>
                    <td>{d.t}</td>
                    <td className="num">
                      <ProbabilityBar p={d.p} />
                    </td>
                    <td className="num">
                      <ProbabilityBar p={actionByDay[i]?.p ?? 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <AnalysisResult result={risk.data} title="Flood outlook" chartHeight={300} />
        </div>
      )}
    </>
  );
}

function ProbabilityBar({ p }: { p: number }) {
  const pct = Math.max(0, Math.min(1, p)) * 100;
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-100">
        <span
          className={`block h-full rounded-full ${pct > 50 ? 'bg-red-500' : pct > 20 ? 'bg-orange-500' : pct > 5 ? 'bg-amber-400' : 'bg-emerald-500'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-12 text-right tabular">{pct.toFixed(1)} %</span>
    </span>
  );
}
