import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { Card, ErrorState, LoadingPanel, PageHeader, Metric, StatusPill, Tabs } from '@/components/ui';
import { api } from '@/services/api';

// ---------------------------------------------------------------------------
// Water supply
// ---------------------------------------------------------------------------

type SupplyTab = 'performance' | 'scenarios' | 'balance';

export function WaterSupply() {
  const [tab, setTab] = useState<SupplyTab>('performance');
  const [scenario, setScenario] = useState('baseline');

  const scenarios = useQuery({ queryKey: ['scenario-definitions'], queryFn: api.scenarioDefinitions });
  const supply = useQuery({ queryKey: ['water-supply', scenario], queryFn: () => api.waterSupply({ scenario }) });
  const balance = useQuery({
    queryKey: ['supply-demand-balance'],
    queryFn: () => api.supplyDemandBalance({}),
    enabled: tab === 'balance',
  });
  const waterBalance = useQuery({ queryKey: ['water-balance'], queryFn: api.waterBalance, enabled: tab === 'performance' });

  const reliability = supply.data?.data.reliability as
    | { timeReliability: number; volumetricReliability: number; resilience: number; vulnerabilityMcm: number; deficitProbability: number; safeYieldMcmPerYear: number }
    | undefined;
  const comparison = (balance.data?.data.scenarios as { scenario: string; label: string; reliability: number; deficitProbability: number; totalShortfallMcm: number; monthsInDeficit: number; safeYieldMcmPerYear: number }[]) ?? [];

  return (
    <>
      <PageHeader
        title="Water Supply"
        description="Reservoir mass-balance simulation with reliability, resilience and vulnerability, safe yield, storage exceedance, and scenario comparison."
        actions={
          <select className="input !w-auto !py-1 text-xs" value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {(scenarios.data ?? []).map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'performance', label: 'Reservoir performance' },
          { id: 'scenarios', label: 'Scenario definitions' },
          { id: 'balance', label: 'Supply–demand balance' },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === 'performance' && (
          <>
            {supply.isLoading && <LoadingPanel label="Simulating reservoir operation…" lines={5} />}
            {supply.error && <ErrorState error={supply.error} retry={() => void supply.refetch()} />}

            {reliability && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <Metric label="Time reliability" value={`${(reliability.timeReliability * 100).toFixed(1)}`} unit="%" hint="Months meeting full demand" />
                <Metric label="Volumetric reliability" value={`${(reliability.volumetricReliability * 100).toFixed(1)}`} unit="%" hint="Delivered ÷ requested volume" />
                <Metric label="Resilience" value={reliability.resilience.toFixed(2)} hint="Speed of recovery from failure" />
                <Metric label="Vulnerability" value={formatNumber(reliability.vulnerabilityMcm)} unit="MCM" hint="Worst single-month shortfall" />
                <Metric
                  label="Deficit probability"
                  value={`${(reliability.deficitProbability * 100).toFixed(1)}`}
                  unit="%"
                  status={reliability.deficitProbability > 0.1 ? 'critical' : undefined}
                  hint="Months with unmet demand"
                />
                <Metric label="Safe yield" value={formatNumber(reliability.safeYieldMcmPerYear)} unit="MCM/yr" hint="Largest constant draw met every month" />
              </div>
            )}

            {supply.data && <AnalysisResult result={supply.data} title="Reservoir simulation" chartHeight={300} />}

            {waterBalance.data && <AnalysisResult result={waterBalance.data} title="Catchment water balance" chartHeight={260} />}
          </>
        )}

        {tab === 'scenarios' && (
          <Card
            title="Planning scenarios"
            subtitle="Scenario factors are illustrative planning assumptions applied as multipliers to inflow and demand. They are not projections from a climate or econometric model, and the platform says so in every result that uses them."
          >
            <table className="table-scientific">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th className="num">Inflow factor</th>
                  <th className="num">Demand factor</th>
                  <th>Definition</th>
                </tr>
              </thead>
              <tbody>
                {(scenarios.data ?? []).map((s) => (
                  <tr key={s.name}>
                    <td className="font-medium">{s.label}</td>
                    <td className="num">×{s.inflowFactor.toFixed(2)}</td>
                    <td className="num">×{s.demandFactor.toFixed(2)}</td>
                    <td className="text-ink-600">{s.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === 'balance' && (
          <>
            {balance.isLoading && <LoadingPanel label="Simulating each scenario…" lines={5} />}
            {balance.error && <ErrorState error={balance.error} />}
            {balance.data && (
              <>
                <Card title="Scenario comparison" subtitle="The same inflow record, different assumptions">
                  <table className="table-scientific">
                    <thead>
                      <tr>
                        <th>Scenario</th>
                        <th className="num">Time reliability</th>
                        <th className="num">Deficit probability</th>
                        <th className="num">Months in deficit</th>
                        <th className="num">Cumulative shortfall (MCM)</th>
                        <th className="num">Safe yield (MCM/yr)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.map((s) => (
                        <tr key={s.scenario}>
                          <td className="font-medium">{s.label}</td>
                          <td className="num">
                            <StatusPill status={s.reliability > 0.95 ? 'normal' : s.reliability > 0.85 ? 'watch' : 'critical'} dot={false}>
                              {(s.reliability * 100).toFixed(1)} %
                            </StatusPill>
                          </td>
                          <td className="num">{(s.deficitProbability * 100).toFixed(1)} %</td>
                          <td className="num">{s.monthsInDeficit}</td>
                          <td className="num">{formatNumber(s.totalShortfallMcm)}</td>
                          <td className="num">{formatNumber(s.safeYieldMcmPerYear)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
                <AnalysisResult result={balance.data} title="Supply and demand across scenarios" chartHeight={260} />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Water demand
// ---------------------------------------------------------------------------

export function WaterDemand() {
  const [sector, setSector] = useState('total');
  const [horizon, setHorizon] = useState(12);

  const demand = useQuery({
    queryKey: ['water-demand', sector, horizon],
    queryFn: () => api.waterDemand({ sector, horizonMonths: horizon }),
  });

  const data = demand.data?.data as
    | {
        trendMcmPerYear: number;
        r2: number;
        peakDemand: { value: number; date: string };
        population: number | null;
        sectorShares: { municipal: number; agricultural: number; industrial: number };
        seasonalIndex: { month: number; indexValue: number }[];
        anomalies: { t: string; observed: number; expected: number; zScore: number }[];
      }
    | undefined;

  const monthName = (m: number) => new Date(Date.UTC(2020, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

  return (
    <>
      <PageHeader
        title="Water Demand"
        description="Sectoral demand analysis and forecasting with prediction intervals, seasonal decomposition, peak demand and anomaly detection."
        actions={
          <>
            <select className="input !w-auto !py-1 text-xs" value={sector} onChange={(e) => setSector(e.target.value)}>
              <option value="total">All sectors</option>
              <option value="municipal">Municipal</option>
              <option value="agricultural">Agricultural</option>
              <option value="industrial">Industrial</option>
            </select>
            <select className="input !w-auto !py-1 text-xs" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[6, 12, 24, 36, 60].map((m) => (
                <option key={m} value={m}>
                  {m}-month horizon
                </option>
              ))}
            </select>
          </>
        }
      />

      {demand.isLoading && <LoadingPanel label="Fitting the demand model…" lines={5} />}
      {demand.error && <ErrorState error={demand.error} retry={() => void demand.refetch()} />}

      {demand.data && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Metric label="Trend" value={`${data.trendMcmPerYear >= 0 ? '+' : ''}${data.trendMcmPerYear.toFixed(3)}`} unit="MCM/yr" hint="Fitted linear trend" />
            <Metric label="Model fit" value={data.r2.toFixed(3)} unit="R²" hint="Trend + seasonal decomposition" />
            <Metric label="Peak forecast demand" value={formatNumber(data.peakDemand.value)} unit="MCM" hint={data.peakDemand.date.slice(0, 7)} />
            <Metric label="Service population" value={data.population ? data.population.toLocaleString() : '—'} hint="Most recent month" />
            <Metric label="Anomalies flagged" value={data.anomalies.length} hint="|modified z| > 3.5 on residuals" />
          </div>

          <AnalysisResult result={demand.data} title={`${sector === 'total' ? 'Total' : sector} demand forecast`} chartHeight={320} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Current sectoral split" subtitle="Most recent month in the record">
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Sector</th>
                    <th className="num">Demand (MCM)</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.sectorShares).map(([k, v]) => {
                    const total = Object.values(data.sectorShares).reduce((a, b) => a + b, 0);
                    return (
                      <tr key={k}>
                        <td className="capitalize">{k}</td>
                        <td className="num">{formatNumber(v)}</td>
                        <td className="num">{total ? ((v / total) * 100).toFixed(1) : '0'} %</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>

            <Card title="Seasonal shape" subtitle="Average departure from the long-term trend by calendar month">
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Seasonal index (MCM)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.seasonalIndex.map((s) => (
                    <tr key={s.month}>
                      <td>{monthName(s.month)}</td>
                      <td className="num">
                        <span className={s.indexValue > 0 ? 'text-orange-700' : 'text-hydro-700'}>
                          {s.indexValue >= 0 ? '+' : ''}
                          {s.indexValue.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          {data.anomalies.length > 0 && (
            <Card
              title="Demand anomalies"
              subtitle="Months departing sharply from the fitted model — often a metering or reporting problem rather than a genuine change in use"
            >
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Observed (MCM)</th>
                    <th className="num">Expected (MCM)</th>
                    <th className="num">Modified z</th>
                  </tr>
                </thead>
                <tbody>
                  {data.anomalies.map((a) => (
                    <tr key={a.t}>
                      <td>{a.t.slice(0, 7)}</td>
                      <td className="num">{formatNumber(a.observed)}</td>
                      <td className="num">{formatNumber(a.expected)}</td>
                      <td className="num">{a.zScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
