import type { Dataset } from '@hydro/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { AnalysisResult, formatNumber } from '@/components/AnalysisResult';
import { MapRenderer } from '@/components/MapRenderer';
import { Card, EmptyState, ErrorState, LoadingPanel, PageHeader, Spinner, StatusPill, Tabs } from '@/components/ui';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';

// ---------------------------------------------------------------------------
// GIS & Maps
// ---------------------------------------------------------------------------

export function GisMaps() {
  const analysis = useQuery({ queryKey: ['watershed-analysis-map'], queryFn: () => api.watershedAnalysis({}) });
  const [operation, setOperation] = useState('subbasin_summary');
  const query = useQuery({ queryKey: ['gis-query', operation], queryFn: () => api.gisQuery({ operation }) });

  const subbasins = (analysis.data?.data.subbasins as { id: string; name: string; areaKm2: number; areaPct: number; curveNumber: number; meanElevationM: number; meanSlopePct: number; landCover: string; estimatedFlowSharePct: number }[]) ?? [];

  return (
    <>
      <PageHeader
        title="GIS & Maps"
        description="Watershed boundary, subbasins, stream network and monitoring stations, with layer control, identify and spatial queries."
      />

      {analysis.isLoading && <LoadingPanel label="Loading spatial layers…" />}
      {analysis.error && <ErrorState error={analysis.error} retry={() => void analysis.refetch()} />}

      {analysis.data?.maps[0] && (
        <Card className="mb-4">
          <MapRenderer spec={analysis.data.maps[0]} height={520} />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Spatial query" className="xl:col-span-1" bodyClassName="p-4">
          <label className="label" htmlFor="op">
            Operation
          </label>
          <select id="op" className="input" value={operation} onChange={(e) => setOperation(e.target.value)}>
            <option value="subbasin_summary">Subbasin summary</option>
            <option value="stations_in_watershed">Stations within the watershed</option>
            <option value="bounding_box">Bounding box and centroid</option>
          </select>
          {query.data && <p className="mt-3 text-xs leading-relaxed text-ink-700">{query.data.summary}</p>}
          <p className="mt-3 text-2xs leading-relaxed text-ink-500">
            Spatial queries run in PostGIS when a database is configured, and in-process against the same geometry
            otherwise. Coordinates are WGS 84; distances use a spherical approximation, adequate at basin scale but not for
            survey work.
          </p>
        </Card>

        <Card title="Subbasin characteristics" className="xl:col-span-2">
          <table className="table-scientific">
            <thead>
              <tr>
                <th>Subbasin</th>
                <th className="num">Area (km²)</th>
                <th className="num">Area %</th>
                <th className="num">Mean elev. (m)</th>
                <th className="num">Slope %</th>
                <th className="num">CN</th>
                <th>Land cover</th>
                <th className="num">Est. flow share</th>
              </tr>
            </thead>
            <tbody>
              {subbasins.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.name}</td>
                  <td className="num">{formatNumber(s.areaKm2)}</td>
                  <td className="num">{s.areaPct.toFixed(1)} %</td>
                  <td className="num">{s.meanElevationM}</td>
                  <td className="num">{s.meanSlopePct}</td>
                  <td className="num">{s.curveNumber}</td>
                  <td className="text-ink-600">{s.landCover}</td>
                  <td className="num">{s.estimatedFlowSharePct.toFixed(1)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-2xs leading-relaxed text-ink-500">
            Flow share is estimated from area weighted by curve number, because the demonstration network has no
            subbasin-outlet gauges. It is an estimate, not a measurement.
          </p>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Data explorer
// ---------------------------------------------------------------------------

export function DataExplorer() {
  const { projectId, pushToast } = useApp();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Dataset | null>(null);

  const datasets = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api.datasets(projectId ?? undefined),
    enabled: Boolean(projectId),
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadDataset(file, projectId!),
    onSuccess: (ds) => {
      pushToast({ kind: 'success', title: 'Dataset uploaded', body: `${ds.name} was stored and profiled.` });
      setSelected(ds);
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (e) => pushToast({ kind: 'error', title: 'Upload failed', body: e instanceof Error ? e.message : String(e) }),
  });

  const preview = useQuery({
    queryKey: ['dataset-preview', selected?.id],
    queryFn: () => api.datasetPreview(selected!.id, 30),
    enabled: Boolean(selected && !selected.isSynthetic),
    retry: false,
  });

  const profile = selected?.profile;

  return (
    <>
      <PageHeader
        title="Data Explorer"
        description="Upload, profile and inspect datasets. Delimited text is profiled immediately; NetCDF, GeoTIFF, Parquet and Excel are profiled by the Python scientific service."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept=".csv,.txt,.tsv,.rdb,.xlsx,.xls,.nc,.tif,.tiff,.geojson,.json,.parquet,.zip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
            <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
              {upload.isPending && <Spinner />}
              Upload dataset
            </button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <Card title="Datasets" bodyClassName="p-2">
          {datasets.isLoading && <LoadingPanel label="Loading datasets…" lines={3} />}
          {datasets.data && datasets.data.length === 0 && <EmptyState title="No datasets yet" body="Upload a CSV to profile it." />}
          <ul className="space-y-1">
            {(datasets.data ?? []).map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setSelected(d)}
                  className={`w-full rounded px-2 py-2 text-left transition-colors ${
                    selected?.id === d.id ? 'bg-hydro-50' : 'hover:bg-ink-50'
                  }`}
                >
                  <span className="block truncate text-xs font-medium text-ink-800">{d.name}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
                    <span className="chip border-ink-200 bg-white text-ink-600">{d.format}</span>
                    {d.isSynthetic && <span className="chip border-violet-200 bg-violet-50 text-violet-800">synthetic</span>}
                    <span className="text-[10px] text-ink-400">{(d.sizeBytes / 1024).toFixed(0)} kB</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="min-w-0 space-y-4">
          {!selected && <EmptyState title="Select a dataset" body="Choose a dataset to see its profile, variables, coverage and quality flags." />}

          {selected && (
            <>
              <Card title={selected.name} subtitle={selected.description ?? undefined}>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  {[
                    ['Format', selected.format],
                    ['Source', selected.source],
                    ['Version', selected.version],
                    ['Uploaded', new Date(selected.uploadedAt).toLocaleString()],
                    ['Size', `${(selected.sizeBytes / 1024).toFixed(0)} kB`],
                    ['Synthetic', selected.isSynthetic ? 'Yes' : 'No'],
                    ['Rows', profile ? profile.rows.toLocaleString() : '—'],
                    ['Columns', profile ? String(profile.columns) : '—'],
                  ].map(([k, v]) => (
                    <div key={k as string}>
                      <dt className="text-2xs uppercase tracking-wide text-ink-500">{k as string}</dt>
                      <dd className="text-xs text-ink-800">{v as string}</dd>
                    </div>
                  ))}
                </dl>
              </Card>

              {profile && (
                <>
                  {profile.warnings.length > 0 && (
                    <Card title="Profile notes">
                      <ul className="list-disc space-y-1 pl-4">
                        {profile.warnings.map((w, i) => (
                          <li key={i} className="text-xs leading-relaxed text-ink-700">
                            {w}
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}

                  {profile.variables.length > 0 && (
                    <Card
                      title="Variables"
                      subtitle={`${profile.missingDataPct.toFixed(2)} % of cells missing · ${
                        profile.temporalCoverage
                          ? `${profile.temporalCoverage.start} → ${profile.temporalCoverage.end} (${profile.temporalCoverage.step})`
                          : 'no time column identified'
                      }`}
                    >
                      <div className="max-h-96 overflow-auto">
                        <table className="table-scientific">
                          <thead className="sticky top-0">
                            <tr>
                              <th>Name</th>
                              <th>Role</th>
                              <th>Type</th>
                              <th>Unit</th>
                              <th className="num">Missing</th>
                              <th className="num">Min</th>
                              <th className="num">Max</th>
                              <th className="num">Mean</th>
                              <th className="num">Outliers</th>
                            </tr>
                          </thead>
                          <tbody>
                            {profile.variables.map((v) => (
                              <tr key={v.name}>
                                <td className="font-medium">{v.name}</td>
                                <td>
                                  <span className={`chip ${v.role === 'unknown' ? 'border-ink-200 bg-ink-50 text-ink-600' : 'border-hydro-200 bg-hydro-50 text-hydro-800'}`}>
                                    {v.role}
                                  </span>
                                </td>
                                <td className="text-ink-600">{v.dtype}</td>
                                <td className="text-ink-600">{v.unit ?? <span className="text-amber-700">not inferred</span>}</td>
                                <td className="num">{v.missingPct.toFixed(1)} %</td>
                                <td className="num">{formatNumber(v.min)}</td>
                                <td className="num">{formatNumber(v.max)}</td>
                                <td className="num">{formatNumber(v.mean)}</td>
                                <td className="num">{v.outlierCount || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  )}

                  {profile.qualityFlags.length > 0 && (
                    <Card title="Quality flags">
                      <ul className="flex flex-wrap gap-1.5">
                        {profile.qualityFlags.map((f, i) => (
                          <li key={i} className="chip border-amber-200 bg-amber-50 text-amber-800">
                            {f}
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                </>
              )}

              {preview.data && (
                <Card title="Preview" subtitle="First rows as stored">
                  <pre className="max-h-72 overflow-auto rounded bg-ink-900 p-3 font-mono text-[10px] leading-relaxed text-ink-200">
                    {preview.data.lines.join('\n')}
                  </pre>
                </Card>
              )}

              {selected.isSynthetic && (
                <Card title="Synthetic demonstration series">
                  <p className="text-xs leading-relaxed text-ink-700">
                    This dataset is generated in memory by the platform's conceptual rainfall-runoff model rather than stored
                    as a file, so there is nothing to preview. The values are available through the analysis pages and the
                    <code className="mx-1 rounded bg-ink-100 px-1 font-mono text-[10px]">/api/series</code> endpoint.
                  </p>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

export function Forecasts() {
  const [model, setModel] = useState('xgboost');
  const [horizon, setHorizon] = useState(7);

  const forecast = useQuery({
    queryKey: ['forecast', model, horizon],
    queryFn: () => api.forecast({ model, horizonDays: horizon }),
  });

  const f = forecast.data?.data.forecast as
    | {
        model: string;
        requestedModel: string;
        library: string;
        metrics: Record<string, number | null>;
        featureImportance: { feature: string; importance: number }[];
        trainingPeriod: { start: string; end: string };
        validationPeriod: { start: string; end: string } | null;
        thresholds: { name: string; value: number; unit: string; kind: string; exceedanceProbability: number | null; firstExceedance: string | null }[];
        limitations: string[];
        hyperparameters: Record<string, unknown>;
      }
    | undefined;

  return (
    <>
      <PageHeader
        title="Forecasts"
        description="Fit a forecasting model, validate it on a held-out period, and produce a probabilistic forecast with threshold-exceedance probabilities."
        actions={
          <>
            <select className="input !w-auto !py-1 text-xs" value={model} onChange={(e) => setModel(e.target.value)}>
              <optgroup label="Runs in the API">
                <option value="persistence">Persistence (benchmark)</option>
                <option value="climatology">Climatology (benchmark)</option>
                <option value="moving_average">Moving average</option>
                <option value="arima">Autoregressive</option>
              </optgroup>
              <optgroup label="Runs in the Python service">
                <option value="random_forest">Random Forest</option>
                <option value="xgboost">XGBoost</option>
                <option value="lstm">LSTM</option>
                <option value="gru">GRU</option>
                <option value="tft">Temporal Fusion Transformer</option>
              </optgroup>
            </select>
            <select className="input !w-auto !py-1 text-xs" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[1, 3, 7, 14, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d}-day horizon
                </option>
              ))}
            </select>
          </>
        }
      />

      {forecast.isLoading && <LoadingPanel label="Fitting and validating the model…" lines={5} />}
      {forecast.error && <ErrorState error={forecast.error} retry={() => void forecast.refetch()} />}

      {forecast.data && f && (
        <div className="space-y-4">
          <Card
            title="Explainability"
            subtitle="§39 — what ran, on what data, and how well it did on data it never saw"
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <table className="table-scientific">
                  <tbody>
                    <tr>
                      <td>Model requested</td>
                      <td className="text-right font-medium">{f.requestedModel}</td>
                    </tr>
                    <tr>
                      <td>Model that ran</td>
                      <td className="text-right font-medium">
                        {f.model}
                        {f.model !== f.requestedModel && (
                          <StatusPill status="warning" dot={false}>
                            substituted
                          </StatusPill>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td>Implementation</td>
                      <td className="text-right font-mono text-[10px]">{f.library}</td>
                    </tr>
                    <tr>
                      <td>Training period</td>
                      <td className="text-right">
                        {f.trainingPeriod.start} → {f.trainingPeriod.end}
                      </td>
                    </tr>
                    <tr>
                      <td>Validation period</td>
                      <td className="text-right">
                        {f.validationPeriod ? `${f.validationPeriod.start} → ${f.validationPeriod.end}` : '—'}
                      </td>
                    </tr>
                    {['nse', 'kge', 'rmse', 'mae', 'pbias', 'r2'].map((k) => (
                      <tr key={k}>
                        <td className="uppercase">{k}</td>
                        <td className="num text-right font-semibold">{formatNumber(f.metrics[k])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Primary predictors</p>
                <ul className="space-y-1">
                  {f.featureImportance.slice(0, 8).map((fi, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-4 text-right text-2xs text-ink-400">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-2xs text-ink-700" title={fi.feature}>
                        {fi.feature}
                      </span>
                      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-100">
                        <span className="block h-full rounded-full bg-hydro-500" style={{ width: `${Math.min(fi.importance * 100 * 2.5, 100)}%` }} />
                      </span>
                      <span className="w-10 text-right text-2xs tabular text-ink-600">{(fi.importance * 100).toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>

                <p className="mb-1 mt-4 text-2xs font-semibold uppercase tracking-wide text-ink-500">Hyperparameters</p>
                <p className="font-mono text-[10px] leading-relaxed text-ink-600">
                  {Object.entries(f.hyperparameters)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join('  ')}
                </p>
              </div>
            </div>

            <p className="mb-1 mt-4 text-2xs font-semibold uppercase tracking-wide text-ink-500">Known limitations</p>
            <ul className="list-disc space-y-1 pl-4">
              {f.limitations.map((l, i) => (
                <li key={i} className="text-2xs leading-relaxed text-ink-700">
                  {l}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Threshold exceedance" subtitle="Probability that the forecast crosses each threshold within the horizon">
            <table className="table-scientific">
              <thead>
                <tr>
                  <th>Threshold</th>
                  <th>Kind</th>
                  <th className="num">Value</th>
                  <th className="num">Probability</th>
                  <th>First likely exceedance</th>
                </tr>
              </thead>
              <tbody>
                {f.thresholds.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td className="capitalize text-ink-600">{t.kind.replace('_', ' ')}</td>
                    <td className="num">
                      {formatNumber(t.value)} <span className="text-ink-400">m³/s</span>
                    </td>
                    <td className="num">
                      {t.exceedanceProbability === null ? '—' : `${(t.exceedanceProbability * 100).toFixed(1)} %`}
                    </td>
                    <td>{t.firstExceedance ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <AnalysisResult result={forecast.data} title="Forecast" chartHeight={340} />
        </div>
      )}
    </>
  );
}
