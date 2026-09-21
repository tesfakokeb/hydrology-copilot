import { createHash, randomUUID } from 'node:crypto';
import { HYDROLOGY_CORE_VERSION } from '@hydro/hydrology-core';
import type {
  DataSourceRef,
  MethodRef,
  ProcessingStep,
  ProvenanceRecord,
  UncertaintyRecord,
} from '@hydro/shared-types';

/**
 * Provenance builder.
 *
 * Section 40 of the specification requires that every analysis carry dataset,
 * source, version, time period, spatial extent, processing steps, model,
 * parameters, run id, timestamp and user. The tool executors build one of
 * these for every result they return — there is no code path in the Copilot
 * that produces a number without one.
 */
export class ProvenanceBuilder {
  private readonly startedAt = Date.now();
  private steps: ProcessingStep[] = [];
  private sources: DataSourceRef[] = [];
  private methods: MethodRef[] = [];
  private assumptions: string[] = [];
  private limitations: string[] = [];
  private temporal: { start: string; end: string } | null = null;
  private spatial: string | null = null;
  private uncertainty: UncertaintyRecord = {
    sources: [],
    interval: null,
    validationMetrics: null,
    qualitative: 'not_quantified',
  };

  readonly runId = randomUUID();

  constructor(
    private readonly toolName: string,
    private readonly context: { projectId: string | null; userId: string | null; toolVersion?: string },
  ) {}

  source(s: DataSourceRef): this {
    this.sources.push(s);
    return this;
  }

  step(operation: string, description: string, parameters: Record<string, unknown> = {}): this {
    this.steps.push({
      order: this.steps.length + 1,
      operation,
      description,
      parameters,
      durationMs: Date.now() - this.startedAt,
    });
    return this;
  }

  method(m: MethodRef): this {
    this.methods.push(m);
    return this;
  }

  assume(...a: string[]): this {
    this.assumptions.push(...a);
    return this;
  }

  limit(...l: string[]): this {
    this.limitations.push(...l);
    return this;
  }

  coverage(start: string | null, end: string | null): this {
    if (start && end) this.temporal = { start, end };
    return this;
  }

  extent(text: string | null): this {
    this.spatial = text;
    return this;
  }

  uncertain(u: Partial<UncertaintyRecord>): this {
    this.uncertainty = { ...this.uncertainty, ...u };
    return this;
  }

  build(inputs: unknown): ProvenanceRecord {
    return {
      id: randomUUID(),
      runId: this.runId,
      createdAt: new Date().toISOString(),
      userId: this.context.userId,
      projectId: this.context.projectId,
      toolName: this.toolName,
      toolVersion: this.context.toolVersion ?? HYDROLOGY_CORE_VERSION,
      dataSources: this.sources,
      processingSteps: this.steps,
      methods: this.methods,
      temporalCoverage: this.temporal,
      spatialExtent: this.spatial,
      assumptions: this.assumptions,
      limitations: this.limitations,
      uncertainty: this.uncertainty,
      inputHash: hashInputs(inputs),
      softwareVersions: {
        'hydrology-copilot-api': process.env.APP_VERSION ?? '1.0.0',
        '@hydro/hydrology-core': HYDROLOGY_CORE_VERSION,
        node: process.version,
      },
    };
  }
}

/**
 * Stable hash of the inputs and parameters of an analysis, so that two runs
 * can be compared for reproducibility. Object keys are sorted so the hash does
 * not depend on serialisation order.
 */
export function hashInputs(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Convenience: describe a synthetic demo series as a data source. */
export function demoSource(
  name: string,
  variables: string[],
  units: Record<string, string>,
  coverage: { start: string; end: string } | null,
  recordCount: number,
  spatialExtent: string,
): DataSourceRef {
  return {
    datasetId: null,
    name,
    source: 'Hydrology Copilot synthetic demonstration generator',
    version: '1.0.0',
    isSynthetic: true,
    temporalCoverage: coverage,
    spatialExtent,
    variables,
    units,
    recordCount,
    missingPct: 0,
    accessedAt: new Date().toISOString(),
  };
}
