import type { ProvenanceRecord } from '@hydro/shared-types';
import { useState } from 'react';

/**
 * Provenance inspector (§40).
 *
 * Any number in the application can be traced to the record that produced it:
 * the datasets read, their versions and coverage, the methods applied with
 * their citations, the processing steps in order, the stated assumptions and
 * limitations, the uncertainty, and a hash of the inputs for reproducibility.
 */
export function ProvenancePanel({ record, defaultOpen = false }: { record: ProvenanceRecord; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const synthetic = record.dataSources.some((d) => d.isSynthetic);

  return (
    <div className="rounded-md border border-ink-200 bg-ink-50/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-ink-600">Provenance</span>
          <code className="rounded bg-white px-1 py-0.5 font-mono text-[10px] text-ink-500">{record.toolName}</code>
          <span className="text-2xs text-ink-500">
            {record.dataSources.length} source{record.dataSources.length === 1 ? '' : 's'} · {record.methods.length} method
            {record.methods.length === 1 ? '' : 's'} · {record.processingSteps.length} steps
          </span>
          {synthetic && <span className="chip border-violet-200 bg-violet-50 text-violet-800">Synthetic input</span>}
        </span>
        <span className="text-xs text-ink-400" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-ink-200 px-3 py-3">
          <Section title="Data used">
            {record.dataSources.length === 0 ? (
              <p className="text-2xs text-ink-500">No dataset was read for this result.</p>
            ) : (
              <table className="table-scientific">
                <thead>
                  <tr>
                    <th>Dataset</th>
                    <th>Source</th>
                    <th>Version</th>
                    <th>Period</th>
                    <th className="num">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {record.dataSources.map((d, i) => (
                    <tr key={i}>
                      <td>
                        {d.name}
                        {d.isSynthetic && <span className="ml-1 text-violet-700">(synthetic)</span>}
                      </td>
                      <td className="text-ink-600">{d.source}</td>
                      <td className="text-ink-600">{d.version}</td>
                      <td className="text-ink-600">
                        {d.temporalCoverage ? `${d.temporalCoverage.start} → ${d.temporalCoverage.end}` : '—'}
                      </td>
                      <td className="num">{d.recordCount?.toLocaleString() ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Methods">
            <ul className="space-y-1.5">
              {record.methods.map((m, i) => (
                <li key={i} className="text-2xs leading-relaxed">
                  <span className="font-medium text-ink-800">{m.name}</span>
                  <span className="ml-1 rounded bg-ink-100 px-1 text-[10px] uppercase text-ink-600">{m.kind.replace(/_/g, ' ')}</span>
                  <div className="mt-0.5 text-ink-500">
                    <code className="font-mono text-[10px]">{m.implementation}</code>
                    {m.reference && <div className="mt-0.5 italic">{m.reference}</div>}
                    {Object.keys(m.parameters).length > 0 && (
                      <div className="mt-0.5 font-mono text-[10px] text-ink-500">
                        {Object.entries(m.parameters)
                          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                          .join('  ')}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Processing steps">
            <ol className="space-y-1">
              {record.processingSteps.map((s) => (
                <li key={s.order} className="flex gap-2 text-2xs">
                  <span className="w-4 shrink-0 text-right font-mono text-ink-400">{s.order}</span>
                  <span>
                    <span className="font-medium text-ink-700">{s.operation}</span>
                    <span className="ml-1 text-ink-600">{s.description}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          {record.assumptions.length > 0 && (
            <Section title="Assumptions">
              <ul className="list-disc space-y-1 pl-4">
                {record.assumptions.map((a, i) => (
                  <li key={i} className="text-2xs leading-relaxed text-ink-700">
                    {a}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {record.limitations.length > 0 && (
            <Section title="Limitations">
              <ul className="list-disc space-y-1 pl-4">
                {record.limitations.map((l, i) => (
                  <li key={i} className="text-2xs leading-relaxed text-ink-700">
                    {l}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Uncertainty">
            <p className="text-2xs text-ink-700">
              Qualitative level: <span className="font-medium">{record.uncertainty.qualitative.replace(/_/g, ' ')}</span>
            </p>
            {record.uncertainty.validationMetrics && (
              <p className="mt-1 text-2xs text-ink-700">
                Validation:{' '}
                {Object.entries(record.uncertainty.validationMetrics)
                  .filter(([, v]) => v !== null)
                  .map(([k, v]) => `${k.toUpperCase()} ${(v as number).toFixed(3)}`)
                  .join(' · ')}
              </p>
            )}
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {record.uncertainty.sources.map((s, i) => (
                <li key={i} className="text-2xs leading-relaxed text-ink-700">
                  {s}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Reproducibility">
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              <Field label="Run ID" value={record.runId} mono />
              <Field label="Input hash" value={record.inputHash} mono />
              <Field label="Generated" value={new Date(record.createdAt).toLocaleString()} />
              <Field label="Spatial extent" value={record.spatialExtent ?? '—'} />
              <Field
                label="Temporal coverage"
                value={record.temporalCoverage ? `${record.temporalCoverage.start} → ${record.temporalCoverage.end}` : '—'}
              />
              <Field
                label="Software"
                value={Object.entries(record.softwareVersions)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
              />
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-2xs text-ink-500">{label}</dt>
      <dd className={`ml-auto truncate text-right text-2xs text-ink-800 ${mono ? 'font-mono text-[10px]' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
