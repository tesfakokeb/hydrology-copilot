import type { ScientificAnswer, ToolCall, ToolResult } from '@hydro/shared-types';
import { formatQuantity } from '@hydro/units';

/**
 * Answer composer.
 *
 * The structured half of every Copilot answer — data used, period, extent,
 * methods, assumptions, results, uncertainty — is derived mechanically from
 * the provenance records of the tools that ran. The language model, when one
 * is configured, writes the prose; it never supplies these fields, so it
 * cannot invent a data source, a period, or a method that was not used.
 */
export function composeScientificAnswer(prose: string, calls: ToolCall[]): ScientificAnswer {
  const results = calls.map((c) => c.result).filter((r): r is ToolResult => Boolean(r));
  const provenances = results.map((r) => r.provenance);

  const dataUsed = [
    ...new Set(
      provenances.flatMap((p) =>
        p.dataSources.map(
          (d) =>
            `${d.name} — ${d.source}${d.version ? ` v${d.version}` : ''}${d.isSynthetic ? ' (synthetic demonstration data)' : ''}` +
            (d.recordCount ? `, ${d.recordCount.toLocaleString()} records` : ''),
        ),
      ),
    ),
  ];

  const periods = provenances.map((p) => p.temporalCoverage).filter((t): t is { start: string; end: string } => Boolean(t));
  const timePeriod =
    periods.length === 0
      ? null
      : `${periods.map((p) => p.start).sort()[0]} to ${periods.map((p) => p.end).sort().reverse()[0]}`;

  const spatialExtent = [...new Set(provenances.map((p) => p.spatialExtent).filter(Boolean))].join('; ') || null;

  const methods = [
    ...new Set(
      provenances.flatMap((p) => p.methods.map((m) => `${m.name}${m.reference ? ` — ${m.reference}` : ''}`)),
    ),
  ];

  const assumptions = [...new Set(provenances.flatMap((p) => p.assumptions))];

  const results_: { label: string; value: string }[] = [];
  for (const r of results) {
    for (const [k, qty] of Object.entries(r.quantities ?? {})) {
      results_.push({ label: humanise(k), value: formatQuantity(qty.value, qty.unit) });
    }
    for (const [k, v] of Object.entries(r.metrics ?? {})) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (results_.some((x) => x.label === humanise(k))) continue;
      results_.push({ label: humanise(k), value: formatNumber(v) });
    }
  }

  const uncertaintySources = [...new Set(provenances.flatMap((p) => p.uncertainty.sources))];
  const qualitative = provenances
    .map((p) => p.uncertainty.qualitative)
    .sort((a, b) => rank(b) - rank(a))[0] ?? 'not_quantified';

  const validation = provenances
    .map((p) => p.uncertainty.validationMetrics)
    .filter((m): m is Record<string, number | null> => Boolean(m))[0];

  const uncertainty = [
    `Overall qualitative uncertainty: ${qualitative.replace(/_/g, ' ')}.`,
    validation
      ? `Validation skill on held-out data: ${Object.entries(validation)
          .filter(([, v]) => v !== null && Number.isFinite(v))
          .map(([k, v]) => `${k.toUpperCase()} ${formatNumber(v as number)}`)
          .join(', ')}.`
      : '',
    ...uncertaintySources.map((s) => `• ${s}`),
  ]
    .filter(Boolean)
    .join(' ');

  const limitations = [...new Set(provenances.flatMap((p) => p.limitations))];
  const warnings = [...new Set(results.flatMap((r) => r.warnings))];

  return {
    answer: prose,
    dataUsed,
    timePeriod,
    spatialExtent,
    methods,
    assumptions,
    results: results_.slice(0, 24),
    uncertainty,
    recommendations: buildRecommendations(calls, limitations, warnings),
  };
}

function rank(q: string): number {
  return { low: 1, moderate: 2, high: 3, not_quantified: 0 }[q] ?? 0;
}

function humanise(k: string): string {
  return k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function formatNumber(v: number): string {
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Recommendations are drawn from what the analysis could not do, never
 * invented. Each one names a concrete next step available in the platform.
 */
function buildRecommendations(calls: ToolCall[], limitations: string[], warnings: string[]): string[] {
  const recs: string[] = [];
  const used = new Set(calls.map((c) => c.name));

  if (warnings.some((w) => /Python scientific service/i.test(w))) {
    recs.push('Start the Python scientific service (docker compose up ai-service) to run the requested machine-learning model instead of the autoregressive baseline.');
  }
  if (limitations.some((l) => /zero additional rainfall|no forecast precipitation/i.test(l))) {
    recs.push('Connect a quantitative precipitation forecast so the streamflow forecast is not limited to a recession assumption during storms.');
  }
  if (limitations.some((l) => /HEC-RAS/i.test(l))) {
    recs.push('Upload a HEC-RAS 2D project and set HEC_RAS_PATH to replace the illustrative inundation footprint with modelled depth, velocity and extent.');
  }
  if (limitations.some((l) => /at least 10|record length|fewer than 30 years|WMO guidance/i.test(l))) {
    recs.push('Extend the record, or add nearby stations, before relying on the long-return-period or long-timescale results — the current record is short for them.');
  }
  if (used.has('assess_drought') && !used.has('forecast_water_supply')) {
    recs.push('Run the water-supply scenario analysis under the dry and extreme-drought scenarios to see what the current drought signal means for delivery reliability.');
  }
  if (used.has('forecast_streamflow') && !used.has('analyze_flood_risk')) {
    recs.push('Run the flood-risk outlook to convert this forecast into threshold exceedance probabilities.');
  }
  if (used.has('run_hydrologic_model') || used.has('evaluate_hydrologic_model')) {
    recs.push('Compare the calibrated parameters against a second calibration period to test whether the parameter set transfers.');
  }
  if (recs.length === 0) {
    recs.push('Open the provenance record for this analysis to inspect the exact data, methods and parameters behind every number reported.');
  }
  return recs.slice(0, 4);
}

/**
 * Deterministic prose for the no-model path. It reports what ran and what it
 * found, and nothing beyond that.
 */
export function composeDeterministicProse(message: string, calls: ToolCall[], rationale: string): string {
  const succeeded = calls.filter((c) => c.status === 'succeeded' && c.result);
  const failed = calls.filter((c) => c.status !== 'succeeded' || !c.result?.ok);

  if (succeeded.length === 0) {
    return (
      'I could not complete an analysis for that request. ' +
      (failed[0]?.result?.summary ?? failed[0]?.error ?? 'No tool produced a usable result.') +
      ' I do not answer hydrologic questions from general knowledge — every number I report comes from a computation over your data.'
    );
  }

  const parts = succeeded.map((c) => c.result!.summary);
  const lead = succeeded.length === 1 ? '' : `I ran ${succeeded.length} analyses for this. `;
  const tail = failed.length > 0 ? ` One step did not complete: ${failed[0].result?.summary ?? failed[0].error}.` : '';

  return `${lead}${parts.join(' ')}${tail}`;
}
