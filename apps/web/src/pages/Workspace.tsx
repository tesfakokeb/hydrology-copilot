import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProvenancePanel } from '@/components/ProvenancePanel';
import { Card, EmptyState, ErrorState, LoadingPanel, PageHeader, Spinner, StatusPill, Tabs } from '@/components/ui';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';

// ---------------------------------------------------------------------------
// Model runs & jobs
// ---------------------------------------------------------------------------

export function ModelRuns() {
  const { projectId } = useApp();
  const [tab, setTab] = useState<'runs' | 'jobs' | 'provenance'>('runs');

  const runs = useQuery({ queryKey: ['model-runs', projectId], queryFn: () => api.modelRuns(projectId ?? undefined), enabled: Boolean(projectId) });
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => api.jobs(projectId ?? undefined),
    enabled: Boolean(projectId) && tab === 'jobs',
    refetchInterval: tab === 'jobs' ? 4000 : false,
  });
  const provenance = useQuery({
    queryKey: ['provenance', projectId],
    queryFn: () => api.provenance(projectId ?? undefined, 30),
    enabled: Boolean(projectId) && tab === 'provenance',
  });

  return (
    <>
      <PageHeader
        title="Model Runs"
        description="Every model execution, background job and provenance record produced in this project."
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'runs', label: 'Model runs', count: runs.data?.length },
          { id: 'jobs', label: 'Jobs', count: jobs.data?.jobs.length },
          { id: 'provenance', label: 'Provenance', count: provenance.data?.length },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === 'runs' && (
          <Card title="Model runs">
            {runs.isLoading && <LoadingPanel label="Loading runs…" lines={3} />}
            {runs.data?.length === 0 && (
              <EmptyState title="No model runs yet" body="Run a model from the Watershed Modeling page; every run is recorded here with its metrics and message." />
            )}
            {runs.data && runs.data.length > 0 && (
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Engine</th>
                    <th>Status</th>
                    <th className="num">NSE</th>
                    <th className="num">KGE</th>
                    <th className="num">PBIAS %</th>
                    <th>Started</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.map((r) => (
                    <tr key={r.id}>
                      <td className="font-medium">{r.engine}</td>
                      <td>
                        <StatusPill status={r.status === 'completed' ? 'normal' : r.status === 'failed' ? 'critical' : 'watch'} dot={false}>
                          {r.status}
                        </StatusPill>
                      </td>
                      <td className="num">{r.metrics?.nse?.toFixed(3) ?? '—'}</td>
                      <td className="num">{r.metrics?.kge?.toFixed(3) ?? '—'}</td>
                      <td className="num">{r.metrics?.pbias?.toFixed(1) ?? '—'}</td>
                      <td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
                      <td className="max-w-md truncate text-ink-600" title={r.message ?? ''}>
                        {r.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === 'jobs' && (
          <Card title="Background jobs" subtitle={jobs.data ? `Queue: ${JSON.stringify(jobs.data.stats)}` : undefined}>
            {jobs.data?.jobs.length === 0 && <EmptyState title="No jobs" body="Long-running work — report generation, calibration — is queued here." />}
            {jobs.data && jobs.data.jobs.length > 0 && (
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Status</th>
                    <th className="num">Progress</th>
                    <th>Message</th>
                    <th>Created</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="font-mono text-[10px]">{j.kind}</td>
                      <td>
                        <StatusPill
                          status={j.status === 'completed' ? 'normal' : j.status === 'failed' ? 'critical' : j.status === 'running' ? 'watch' : 'unknown'}
                          dot={false}
                        >
                          {j.status}
                        </StatusPill>
                      </td>
                      <td className="num">{j.progress} %</td>
                      <td className="text-ink-600">{j.message ?? j.error ?? '—'}</td>
                      <td>{new Date(j.createdAt).toLocaleTimeString()}</td>
                      <td>
                        {j.outputLocation ? (
                          <a className="text-hydro-700 underline" href={j.outputLocation} target="_blank" rel="noreferrer">
                            open
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === 'provenance' && (
          <div className="space-y-2">
            {provenance.isLoading && <LoadingPanel label="Loading provenance records…" lines={3} />}
            {provenance.data?.length === 0 && (
              <EmptyState title="No provenance records yet" body="Every analysis writes one. Run something from any analysis page or ask the Copilot a question." />
            )}
            {(provenance.data ?? []).map((p) => (
              <ProvenancePanel key={p.id} record={p} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function Reports() {
  const { projectId, pushToast } = useApp();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('hydrology_assessment');

  const reports = useQuery({ queryKey: ['reports', projectId], queryFn: () => api.reports(projectId ?? undefined), enabled: Boolean(projectId) });

  const generate = useMutation({
    mutationFn: () => api.generateReport({ kind, projectId: projectId ?? undefined }),
    onSuccess: ({ report }) => {
      pushToast({ kind: 'success', title: 'Report generated', body: report.title });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => pushToast({ kind: 'error', title: 'Report generation failed', body: e instanceof Error ? e.message : String(e) }),
  });

  const kinds = reports.data?.kinds ?? {};

  return (
    <>
      <PageHeader
        title="Reports"
        description="Automated scientific reports assembled by running the same analytical tools the dashboards use, with a complete provenance section."
        actions={
          <>
            <select className="input !w-auto !py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(kinds).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary" onClick={() => generate.mutate()} disabled={generate.isPending}>
              {generate.isPending && <Spinner />}
              Generate
            </button>
          </>
        }
      />

      {generate.isPending && <LoadingPanel label="Running the analyses and composing the document…" lines={5} />}

      <Card title="Generated reports">
        {reports.isLoading && <LoadingPanel label="Loading reports…" lines={3} />}
        {reports.data?.reports.length === 0 && (
          <EmptyState
            title="No reports yet"
            body="A report runs the relevant analyses, then composes their summaries, figures, methods, assumptions, limitations, uncertainty and provenance into one document."
          />
        )}
        {reports.data && reports.data.reports.length > 0 && (
          <table className="table-scientific">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Created</th>
                <th>Formats</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reports.data.reports.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.title}</td>
                  <td className="text-ink-600">{kinds[r.kind] ?? r.kind}</td>
                  <td>
                    <StatusPill status={r.status === 'ready' ? 'normal' : r.status === 'failed' ? 'critical' : 'watch'} dot={false}>
                      {r.status}
                    </StatusPill>
                  </td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="text-ink-600">{r.formats.join(', ')}</td>
                  <td>
                    <a className="btn btn-secondary" href={api.reportHtmlUrl(r.id)} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="What a report contains" className="mt-4">
        <ul className="grid grid-cols-1 gap-1.5 text-xs text-ink-700 sm:grid-cols-2">
          {[
            'Executive summary drawn from each analysis',
            'Data used: dataset, source, version, period, variables, record count',
            'Methods with implementation and literature citation',
            'Results and key quantities with units',
            'Figures and maps, each with its caption',
            'Assumptions stated by every tool that ran',
            'Limitations, including what could not be computed',
            'Uncertainty, with validation metrics where the method is predictive',
            'Processing steps in order',
            'Run ID and input hash for reproducibility',
          ].map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-hydro-500" aria-hidden>
                ▸
              </span>
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-2xs leading-relaxed text-ink-500">
          Reports open as a self-contained HTML document, printable to PDF from the browser. DOCX export is available
          through the platform's document pipeline when configured.
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function Projects() {
  const { projects, projectId, setProject, pushToast } = useApp();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [agency, setAgency] = useState('');
  const [unitSystem, setUnitSystem] = useState<'SI' | 'US'>('SI');

  const create = useMutation({
    mutationFn: () => api.createProject({ name, agency: agency || undefined, unitSystem }),
    onSuccess: async (p) => {
      pushToast({ kind: 'success', title: 'Project created', body: p.name });
      setName('');
      setAgency('');
      await queryClient.invalidateQueries();
      await setProject(p.id);
    },
    onError: (e) => pushToast({ kind: 'error', title: 'Could not create the project', body: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <>
      <PageHeader title="Projects" description="A project scopes datasets, analyses, model runs, conversations and reports." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Your projects">
          <table className="table-scientific">
            <thead>
              <tr>
                <th>Name</th>
                <th>Agency</th>
                <th>Units</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className={p.id === projectId ? 'bg-hydro-50/60' : ''}>
                  <td>
                    <span className="font-medium">{p.name}</span>
                    {p.description && <span className="block text-2xs text-ink-500">{p.description}</span>}
                  </td>
                  <td className="text-ink-600">{p.agency ?? '—'}</td>
                  <td className="text-ink-600">{p.unitSystem}</td>
                  <td className="text-ink-600">{new Date(p.updatedAt).toLocaleDateString()}</td>
                  <td>
                    {p.id === projectId ? (
                      <StatusPill status="normal" dot={false}>
                        active
                      </StatusPill>
                    ) : (
                      <button type="button" className="btn btn-secondary" onClick={() => void setProject(p.id)}>
                        Select
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="New project">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <div>
              <label className="label" htmlFor="p-name">
                Name
              </label>
              <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="p-agency">
                Agency or organisation
              </label>
              <input id="p-agency" className="input" value={agency} onChange={(e) => setAgency(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="p-units">
                Unit system
              </label>
              <select id="p-units" className="input" value={unitSystem} onChange={(e) => setUnitSystem(e.target.value as 'SI' | 'US')}>
                <option value="SI">SI — m³/s, mm, km², °C</option>
                <option value="US">US customary — ft³/s, in, mi², °F</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary w-full justify-center" disabled={create.isPending || !name.trim()}>
              {create.isPending && <Spinner />}
              Create project
            </button>
          </form>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function Settings() {
  const { unitSystem, setUnitSystem, user } = useApp();
  const status = useQuery({ queryKey: ['status'], queryFn: api.status });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  return (
    <>
      <PageHeader title="Settings" description="Display preferences and a plain statement of what this deployment can and cannot do." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Display">
          <label className="label" htmlFor="units">
            Preferred unit system
          </label>
          <select id="units" className="input !w-auto" value={unitSystem} onChange={(e) => setUnitSystem(e.target.value as 'SI' | 'US')}>
            <option value="SI">SI — m³/s, mm, km², °C</option>
            <option value="US">US customary — ft³/s, in, mi², °F</option>
          </select>
          <p className="mt-2 text-2xs leading-relaxed text-ink-500">
            Conversions are explicit and dimension-checked: a cross-dimension conversion raises an error rather than
            returning a plausible-looking number.
          </p>
        </Card>

        <Card title="Account">
          <dl className="space-y-1">
            {[
              ['Name', user?.fullName],
              ['Email', user?.email],
              ['Organisation', user?.organization],
              ['Role', user?.role],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-2 text-xs">
                <dt className="text-ink-500">{k as string}</dt>
                <dd className="font-medium text-ink-800">{(v as string) ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Deployment status" className="lg:col-span-2">
          {status.data && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {status.data.sources.map((s) => (
                <div key={s.id} className="rounded-md border border-ink-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-ink-800">{s.name}</p>
                    <StatusPill status={s.status === 'online' ? 'normal' : s.status === 'offline' ? 'critical' : 'unknown'} dot={false}>
                      {s.status.replace('_', ' ')}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-2xs leading-relaxed text-ink-600">{s.detail}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Capabilities" className="lg:col-span-2">
          {capabilities.error && <ErrorState error={capabilities.error} />}
          {capabilities.data && (
            <pre className="max-h-96 overflow-auto rounded bg-ink-900 p-3 font-mono text-[10px] leading-relaxed text-ink-200">
              {JSON.stringify(capabilities.data, null, 2)}
            </pre>
          )}
        </Card>
      </div>
    </>
  );
}
