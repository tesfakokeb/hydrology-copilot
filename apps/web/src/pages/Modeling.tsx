import type { ToolResult } from '@hydro/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { Card, ComingSoon, ErrorState, LoadingPanel, Metric, PageHeader, Spinner, StatusPill, Tabs } from '@/components/ui';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';

type Tab = 'run' | 'adapters' | 'evaluation';

export function WatershedModeling() {
  const { projectId, pushToast } = useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('run');
  const [engine, setEngine] = useState('GR4J');
  const [calibrate, setCalibrate] = useState(true);
  const [result, setResult] = useState<ToolResult | null>(null);

  const adapters = useQuery({ queryKey: ['model-adapters'], queryFn: api.modelAdapters });
  const watershed = useQuery({ queryKey: ['watershed-analysis'], queryFn: () => api.watershedAnalysis({}), enabled: tab === 'run' });

  const run = useMutation({
    mutationFn: () => api.runModel({ engine, calibrate, projectId: projectId ?? undefined }),
    onSuccess: ({ result: r }) => {
      setResult(r);
      void queryClient.invalidateQueries({ queryKey: ['model-runs'] });
      pushToast({
        kind: r.ok ? 'success' : 'warning',
        title: r.ok ? 'Model run complete' : 'Model run could not execute',
        body: r.summary.slice(0, 180),
      });
    },
    onError: (e) => pushToast({ kind: 'error', title: 'Model run failed', body: e instanceof Error ? e.message : String(e) }),
  });

  const selected = adapters.data?.find((a) => a.engine === engine);
  const calibration = result?.data.calibration as
    | { iterations: number; objective: string; objectiveValue: number; calibrationPeriod: { start: string; end: string; metrics: Record<string, number | null> }; validationPeriod: { start: string; end: string; metrics: Record<string, number | null> } | null }
    | null
    | undefined;
  const parameters = result?.data.parameters as Record<string, number> | undefined;
  const parameterDescriptions = result?.data.parameterDescriptions as Record<string, string> | undefined;

  return (
    <>
      <PageHeader
        title="Watershed Modeling"
        description="Run a hydrologic model over the catchment, calibrate it against observed discharge, and evaluate its skill. GR4J runs in-process; HEC-HMS, HEC-RAS, SWAT, SWAT+ and MODFLOW are reached through adapters."
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'run', label: 'Run a model' },
          { id: 'adapters', label: 'Engines & adapters', count: adapters.data?.length },
          { id: 'evaluation', label: 'Evaluation' },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === 'run' && (
          <>
            <Card title="Model configuration" bodyClassName="p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="label" htmlFor="engine">
                    Engine
                  </label>
                  <select id="engine" className="input !w-auto" value={engine} onChange={(e) => setEngine(e.target.value)}>
                    {(adapters.data ?? []).map((a) => (
                      <option key={a.engine} value={a.engine}>
                        {a.displayName} {a.available ? '' : '— integration required'}
                      </option>
                    ))}
                  </select>
                </div>
                {engine === 'GR4J' && (
                  <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-700">
                    <input type="checkbox" className="h-3.5 w-3.5 accent-hydro-600" checked={calibrate} onChange={(e) => setCalibrate(e.target.checked)} />
                    Calibrate against observed discharge
                  </label>
                )}
                <button type="button" className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending}>
                  {run.isPending && <Spinner />}
                  Run model
                </button>
              </div>

              {selected && (
                <div className="mt-4 rounded-md border border-ink-200 bg-ink-50/60 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink-900">{selected.displayName}</p>
                    <StatusPill status={selected.available ? 'normal' : 'unknown'}>
                      {selected.available ? 'available' : 'integration required'}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-600">{selected.description}</p>
                  <p className="mt-2 text-2xs font-semibold uppercase tracking-wide text-ink-500">Capabilities</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {selected.capabilities.map((c) => (
                      <li key={c} className="text-2xs leading-relaxed text-ink-700">
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            {run.isPending && <LoadingPanel label={calibrate ? 'Calibrating and simulating…' : 'Simulating…'} lines={5} />}

            {result && !result.ok && (result.data as { integrationRequired?: boolean }).integrationRequired && (
              <Card title={`${(result.data as { displayName: string }).displayName} integration`}>
                <ComingSoon feature={(result.data as { displayName: string }).displayName} requirement={result.summary} />
                <p className="mt-3 text-2xs font-semibold uppercase tracking-wide text-ink-500">Requirements</p>
                <table className="table-scientific mt-1">
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Component</th>
                      <th>Description</th>
                      <th>Environment variable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((result.data as { requirements: { kind: string; name: string; description: string; envVar?: string }[] }).requirements ?? []).map((r, i) => (
                      <tr key={i}>
                        <td className="capitalize">{r.kind}</td>
                        <td className="font-medium">{r.name}</td>
                        <td className="text-ink-600">{r.description}</td>
                        <td>{r.envVar ? <code className="font-mono text-[10px]">{r.envVar}</code> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {result?.ok && (
              <>
                {parameters && (
                  <Card title="Calibrated parameters" subtitle={calibration ? `${calibration.iterations} iterations maximising ${calibration.objective}` : 'Supplied or default parameter set'}>
                    <table className="table-scientific">
                      <thead>
                        <tr>
                          <th>Parameter</th>
                          <th className="num">Value</th>
                          <th>Meaning</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(parameters).map(([k, v]) => (
                          <tr key={k}>
                            <td className="font-mono">{k}</td>
                            <td className="num font-semibold">{formatNumber(v)}</td>
                            <td className="text-ink-600">{parameterDescriptions?.[k] ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}

                {calibration && (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <Card title="Calibration period" subtitle={`${calibration.calibrationPeriod.start} → ${calibration.calibrationPeriod.end}`}>
                      <MetricGrid metrics={calibration.calibrationPeriod.metrics} />
                    </Card>
                    {calibration.validationPeriod && (
                      <Card title="Validation period" subtitle={`${calibration.validationPeriod.start} → ${calibration.validationPeriod.end} — never seen during fitting`}>
                        <MetricGrid metrics={calibration.validationPeriod.metrics} />
                      </Card>
                    )}
                  </div>
                )}

                <AnalysisResult result={result} title="Simulation" chartHeight={320} />
              </>
            )}

            {watershed.data && <AnalysisResult result={watershed.data} title="Catchment characterisation" chartHeight={260} showMaps={false} />}
          </>
        )}

        {tab === 'adapters' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {(adapters.data ?? []).map((a) => (
              <Card
                key={a.engine}
                title={a.displayName}
                subtitle={a.description}
                actions={<StatusPill status={a.available ? 'normal' : 'unknown'}>{a.available ? 'available' : 'integration required'}</StatusPill>}
              >
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Capabilities</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {a.capabilities.map((c) => (
                    <li key={c} className="text-2xs leading-relaxed text-ink-700">
                      {c}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-2xs font-semibold uppercase tracking-wide text-ink-500">Requirements</p>
                <ul className="mt-1 space-y-1">
                  {a.requirements.map((r, i) => (
                    <li key={i} className="text-2xs leading-relaxed text-ink-700">
                      <span className="font-medium">{r.name}</span>
                      {r.envVar && <code className="ml-1 rounded bg-ink-100 px-1 font-mono text-[10px]">{r.envVar}</code>}
                      <span className="block text-ink-500">{r.description}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}

        {tab === 'evaluation' && <ModelEvaluation />}
      </div>
    </>
  );
}

function MetricGrid({ metrics }: { metrics: Record<string, number | null> }) {
  const keys = ['nse', 'kge', 'rmse', 'mae', 'pbias', 'r2', 'peakErrorPct', 'volumeErrorPct'] as const;
  const labels: Record<string, string> = {
    nse: 'NSE', kge: 'KGE', rmse: 'RMSE', mae: 'MAE', pbias: 'PBIAS %', r2: 'R²',
    peakErrorPct: 'Peak error %', volumeErrorPct: 'Volume error %',
  };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {keys.map((k) => (
        <Metric key={k} label={labels[k]} value={formatNumber(metrics[k])} />
      ))}
    </div>
  );
}

function ModelEvaluation() {
  const evaluation = useQuery({
    queryKey: ['model-evaluation'],
    queryFn: () => api.copilotRunTool({ tool: 'evaluate_hydrologic_model', arguments: { engine: 'GR4J' } }),
  });

  const rating = evaluation.data?.data.rating as
    | { overall: string; detail: { criterion: string; value: number | null; rating: string }[] }
    | undefined;

  return (
    <>
      {evaluation.isLoading && <LoadingPanel label="Calibrating and evaluating GR4J…" lines={5} />}
      {evaluation.error && <ErrorState error={evaluation.error} retry={() => void evaluation.refetch()} />}
      {evaluation.data && (
        <>
          {rating && (
            <Card
              title="Performance rating"
              subtitle="Ratings follow Moriasi et al. (2015) conventions for daily streamflow. A rating is a convention, not a certification."
              actions={
                <StatusPill
                  status={rating.overall === 'very good' || rating.overall === 'good' ? 'normal' : rating.overall === 'satisfactory' ? 'watch' : 'critical'}
                >
                  {rating.overall}
                </StatusPill>
              }
            >
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Criterion</th>
                    <th className="num">Value</th>
                    <th>Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {rating.detail.map((d, i) => (
                    <tr key={i}>
                      <td>{d.criterion}</td>
                      <td className="num">{formatNumber(d.value)}</td>
                      <td className="capitalize">{d.rating}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <div className="mt-4">
            <AnalysisResult result={evaluation.data} title="Observed against simulated" chartHeight={320} />
          </div>
        </>
      )}
    </>
  );
}
