import type { ProvenanceRecord, ReportKind, ToolResult } from '@hydro/shared-types';
import { ProvenanceBuilder } from '../provenance.js';
import { analyzeFloodRisk, calculateFloodFrequency } from './flood.js';
import { analyzeWatershed } from './gis.js';
import { assessDrought, calculateDroughtIndex } from './drought.js';
import { analyzeWaterQuality } from './quality.js';
import { analyzeStreamflow } from './streamflow.js';
import { forecastStreamflow } from './forecasting.js';
import { analyzeWaterSupply, calculateWaterBalance, forecastWaterDemand, supplyDemandBalance } from './water.js';
import { ok, type ToolContext } from './common.js';

const REPORT_TITLES: Record<ReportKind, string> = {
  hydrology_assessment: 'Hydrology Assessment Report',
  drought_assessment: 'Drought Assessment Report',
  flood_risk: 'Flood Risk Assessment Report',
  water_quality: 'Water Quality Report',
  water_supply_planning: 'Water Supply Planning Report',
  water_demand_forecast: 'Water Demand Forecast Report',
};

/**
 * Report generator (§30).
 *
 * A report is assembled by running the same analysis tools the Copilot uses
 * and composing their results, so a figure in a report and the same figure on
 * a dashboard come from one code path. Every report carries the full
 * provenance of every tool that contributed to it.
 */
export async function generateReport(
  ctx: ToolContext,
  args: { kind?: ReportKind; title?: string },
): Promise<ToolResult & { html: string; kind: ReportKind }> {
  const kind = args.kind ?? 'hydrology_assessment';
  const p = new ProvenanceBuilder('generate_report', { projectId: ctx.projectId, userId: ctx.userId });

  const sections: { heading: string; result: ToolResult }[] = [];
  const run = async (heading: string, fn: () => Promise<ToolResult>) => {
    ctx.emit?.(`Running ${heading.toLowerCase()}`, 'ok');
    sections.push({ heading, result: await fn() });
  };

  switch (kind) {
    case 'drought_assessment':
      await run('Watershed characterisation', () => analyzeWatershed(ctx));
      await run('Drought assessment', () => assessDrought(ctx));
      await run('SPI-12', () => calculateDroughtIndex(ctx, { index: 'SPI', timescaleMonths: 12 }));
      await run('Streamflow drought index', () => calculateDroughtIndex(ctx, { index: 'SSI', timescaleMonths: 3 }));
      await run('Water balance', () => calculateWaterBalance(ctx));
      break;
    case 'flood_risk':
      await run('Watershed characterisation', () => analyzeWatershed(ctx));
      await run('Flood-frequency analysis', () => calculateFloodFrequency(ctx, {}));
      await run('Flood risk outlook', () => analyzeFloodRisk(ctx, {}));
      await run('Streamflow forecast', () => forecastStreamflow(ctx, { horizonDays: 7 }));
      break;
    case 'water_quality':
      await run('Watershed characterisation', () => analyzeWatershed(ctx));
      await run('Water quality assessment', () => analyzeWaterQuality(ctx, {}));
      break;
    case 'water_supply_planning':
      await run('Watershed characterisation', () => analyzeWatershed(ctx));
      await run('Reservoir performance', () => analyzeWaterSupply(ctx, { scenario: 'baseline' }));
      await run('Scenario comparison', () => supplyDemandBalance(ctx, {}));
      await run('Demand outlook', () => forecastWaterDemand(ctx, { horizonMonths: 24 }));
      break;
    case 'water_demand_forecast':
      await run('Demand forecast', () => forecastWaterDemand(ctx, { horizonMonths: 24 }));
      await run('Supply and demand balance', () => supplyDemandBalance(ctx, {}));
      break;
    default:
      await run('Watershed characterisation', () => analyzeWatershed(ctx));
      await run('Streamflow analysis', () => analyzeStreamflow(ctx, {}));
      await run('Water balance', () => calculateWaterBalance(ctx));
      await run('Drought assessment', () => assessDrought(ctx));
      await run('Flood-frequency analysis', () => calculateFloodFrequency(ctx, {}));
      await run('Streamflow forecast', () => forecastStreamflow(ctx, { horizonDays: 7 }));
      await run('Water quality assessment', () => analyzeWaterQuality(ctx, {}));
  }

  const project = await ctx.db.getProject(ctx.projectId, ctx.userId ?? '');
  const watershed = (await ctx.db.listWatersheds())[0];
  const title = args.title ?? `${REPORT_TITLES[kind]} — ${watershed?.name ?? project?.name ?? 'Project'}`;

  for (const s of sections) {
    p.step('compose', `Included the "${s.heading}" analysis.`, { tool: s.result.provenance.toolName, runId: s.result.provenance.runId });
    for (const src of s.result.provenance.dataSources) p.source(src);
    for (const m of s.result.provenance.methods) p.method(m);
    p.assume(...s.result.provenance.assumptions);
    p.limit(...s.result.provenance.limitations);
  }
  p.extent(watershed?.name ?? null).uncertain({
    sources: sections.flatMap((s) => s.result.provenance.uncertainty.sources),
    qualitative: 'moderate',
  });

  const provenance = p.build({ kind, sections: sections.map((s) => s.heading) });
  const html = renderReportHtml(title, kind, sections, provenance, watershed?.name ?? '');

  const base = ok(`Generated the ${REPORT_TITLES[kind]} with ${sections.length} analytical sections and a complete provenance record.`, {
    data: {
      kind,
      title,
      sections: sections.map((s) => ({
        heading: s.heading,
        summary: s.result.summary,
        ok: s.result.ok,
        metrics: s.result.metrics,
        warnings: s.result.warnings,
        provenanceId: s.result.provenance.id,
      })),
      provenanceId: provenance.id,
    },
    charts: sections.flatMap((s) => s.result.charts),
    maps: sections.flatMap((s) => s.result.maps),
    warnings: [...new Set(sections.flatMap((s) => s.result.warnings))],
    provenance,
  });

  return { ...base, html, kind };
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Self-contained HTML report — printable to PDF from any browser. */
export function renderReportHtml(
  title: string,
  kind: ReportKind,
  sections: { heading: string; result: ToolResult }[],
  provenance: ProvenanceRecord,
  watershedName: string,
): string {
  const issued = new Date(provenance.createdAt).toUTCString();
  const allWarnings = [...new Set(sections.flatMap((s) => s.result.warnings))];
  const synthetic = provenance.dataSources.some((d) => d.isSynthetic);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
:root{--ink:#111827;--muted:#4b5563;--line:#d1d5db;--accent:#0f6fb8;--warn:#b45309;--bg:#fff}
*{box-sizing:border-box}
body{font:13.5px/1.65 "Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:44px 56px;max-width:1000px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:17px;margin:34px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
h3{font-size:14px;margin:20px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 22px}
.banner{background:#fff7ed;border:1px solid #fdba74;border-left:4px solid #ea580c;padding:12px 16px;border-radius:4px;margin:18px 0;font-size:12.5px}
.banner strong{color:#9a3412}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:12.5px}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}
ul{margin:8px 0 8px 18px;padding:0}
li{margin:3px 0}
.summary{background:#f8fafc;border-left:3px solid var(--accent);padding:10px 14px;margin:10px 0;border-radius:0 4px 4px 0}
.meta{font-size:11.5px;color:var(--muted)}
.warn{color:var(--warn)}
footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted)}
@media print{body{padding:0;max-width:none}h2{break-after:avoid}table{break-inside:avoid}}
</style></head><body>

<h1>${esc(title)}</h1>
<p class="sub">${esc(watershedName)} · Issued ${esc(issued)} · Run ID <code>${esc(provenance.runId)}</code> · Hydrology Copilot v${esc(provenance.softwareVersions['hydrology-copilot-api'] ?? '1.0.0')}</p>

${synthetic ? `<div class="banner"><strong>Synthetic demonstration data.</strong> Every value in this report derives from a synthetic dataset generated by a conceptual rainfall-runoff model. No value is an observation. This report demonstrates the analytical workflow and must not be used for any operational, design or regulatory purpose.</div>` : ''}

<h2>Executive summary</h2>
<ul>
${sections.map((s) => `<li><strong>${esc(s.heading)}.</strong> ${esc(s.result.summary)}</li>`).join('\n')}
</ul>

${allWarnings.length ? `<h3>Cautions</h3><ul class="warn">${allWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

<h2>Data used</h2>
<table><thead><tr><th>Dataset</th><th>Source</th><th>Version</th><th>Period</th><th>Variables</th><th class="num">Records</th><th>Synthetic</th></tr></thead><tbody>
${dedupeSources(provenance).map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.source)}</td><td>${esc(d.version)}</td><td>${esc(d.temporalCoverage ? `${d.temporalCoverage.start} to ${d.temporalCoverage.end}` : '—')}</td><td>${esc(d.variables.join(', '))}</td><td class="num">${d.recordCount ?? '—'}</td><td>${d.isSynthetic ? 'Yes' : 'No'}</td></tr>`).join('\n')}
</tbody></table>

<h2>Methods</h2>
<table><thead><tr><th>Method</th><th>Type</th><th>Implementation</th><th>Reference</th></tr></thead><tbody>
${dedupeMethods(provenance).map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.kind.replace(/_/g, ' '))}</td><td><code>${esc(m.implementation)}</code></td><td class="meta">${esc(m.reference ?? '—')}</td></tr>`).join('\n')}
</tbody></table>

${sections.map((s) => renderSection(s)).join('\n')}

<h2>Assumptions</h2>
<ul>${[...new Set(provenance.assumptions)].map((a) => `<li>${esc(a)}</li>`).join('')}</ul>

<h2>Limitations</h2>
<ul>${[...new Set(provenance.limitations)].map((l) => `<li>${esc(l)}</li>`).join('')}</ul>

<h2>Uncertainty</h2>
<p>Overall qualitative uncertainty for this assessment: <strong>${esc(provenance.uncertainty.qualitative.replace(/_/g, ' '))}</strong>.</p>
<ul>${[...new Set(provenance.uncertainty.sources)].map((u) => `<li>${esc(u)}</li>`).join('')}</ul>

<h2>Provenance and reproducibility</h2>
<table><tbody>
<tr><th>Run ID</th><td><code>${esc(provenance.runId)}</code></td></tr>
<tr><th>Provenance ID</th><td><code>${esc(provenance.id)}</code></td></tr>
<tr><th>Input hash</th><td><code>${esc(provenance.inputHash)}</code></td></tr>
<tr><th>Generated</th><td>${esc(provenance.createdAt)}</td></tr>
<tr><th>Spatial extent</th><td>${esc(provenance.spatialExtent ?? '—')}</td></tr>
<tr><th>Temporal coverage</th><td>${esc(provenance.temporalCoverage ? `${provenance.temporalCoverage.start} to ${provenance.temporalCoverage.end}` : '—')}</td></tr>
<tr><th>Software</th><td>${Object.entries(provenance.softwareVersions).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</td></tr>
</tbody></table>

<h3>Processing steps</h3>
<table><thead><tr><th class="num">#</th><th>Operation</th><th>Description</th></tr></thead><tbody>
${provenance.processingSteps.map((st) => `<tr><td class="num">${st.order}</td><td>${esc(st.operation)}</td><td>${esc(st.description)}</td></tr>`).join('\n')}
</tbody></table>

<h2>Conclusions</h2>
<ul>
${sections.filter((s) => s.result.ok).map((s) => `<li>${esc(s.result.summary)}</li>`).join('\n')}
</ul>

<footer>
Generated by Hydrology Copilot — AI-Powered Water Resources Intelligence. Report type: ${esc(kind.replace(/_/g, ' '))}.
This document is an analytical product. It is not a regulatory determination, an official forecast, or a certified engineering deliverable, and it carries no professional engineering seal.
</footer>
</body></html>`;
}

function renderSection(s: { heading: string; result: ToolResult }): string {
  const metrics = Object.entries(s.result.metrics).filter(([, v]) => v !== null && v !== undefined);
  const quantities = Object.entries(s.result.quantities ?? {});
  return `
<h2>${esc(s.heading)}</h2>
<div class="summary">${esc(s.result.summary)}</div>
${quantities.length ? `<h3>Key quantities</h3><table><thead><tr><th>Quantity</th><th class="num">Value</th><th>Unit</th></tr></thead><tbody>
${quantities.map(([k, q]) => `<tr><td>${esc(humanise(k))}</td><td class="num">${fmtNum(q.value)}</td><td>${esc(q.unit)}</td></tr>`).join('')}
</tbody></table>` : ''}
${metrics.length ? `<h3>Metrics</h3><table><thead><tr><th>Metric</th><th class="num">Value</th></tr></thead><tbody>
${metrics.map(([k, v]) => `<tr><td>${esc(humanise(k))}</td><td class="num">${fmtNum(v)}</td></tr>`).join('')}
</tbody></table>` : ''}
${s.result.charts.length ? `<h3>Figures</h3><ul>${s.result.charts.map((c) => `<li><strong>${esc(c.title)}</strong> (${esc(c.yLabel)}, ${esc(c.unit)}). ${esc(c.caption)}</li>`).join('')}</ul>
<p class="meta">Figures are rendered interactively in the application. This document lists each figure with its caption so the printed report remains self-describing.</p>` : ''}
${s.result.maps.length ? `<h3>Maps</h3><ul>${s.result.maps.map((m) => `<li><strong>${esc(m.title)}</strong>. ${esc(m.caption)}</li>`).join('')}</ul>` : ''}
${s.result.warnings.length ? `<h3>Warnings</h3><ul class="warn">${s.result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
`;
}

function humanise(k: string): string {
  return k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function dedupeSources(p: ProvenanceRecord) {
  const seen = new Set<string>();
  return p.dataSources.filter((d) => {
    const k = `${d.name}|${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupeMethods(p: ProvenanceRecord) {
  const seen = new Set<string>();
  return p.methods.filter((m) => {
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });
}

export { REPORT_TITLES };
