/**
 * Provenance records. Section 40 of the platform specification requires that
 * every analysis carries a complete, inspectable lineage. Nothing that
 * produces a number in this platform is allowed to bypass this structure.
 */

export interface DataSourceRef {
  datasetId: string | null;
  name: string;
  source: string;
  version: string;
  isSynthetic: boolean;
  temporalCoverage: { start: string; end: string } | null;
  spatialExtent: string | null;
  variables: string[];
  units: Record<string, string>;
  recordCount: number | null;
  missingPct: number | null;
  accessedAt: string;
}

export interface ProcessingStep {
  order: number;
  operation: string;
  description: string;
  parameters: Record<string, unknown>;
  durationMs: number | null;
}

export interface MethodRef {
  name: string;
  kind: 'statistic' | 'index' | 'ml_model' | 'hydrologic_model' | 'hydraulic_model' | 'gis' | 'heuristic';
  implementation: string;
  reference: string | null;
  parameters: Record<string, unknown>;
}

export interface UncertaintyRecord {
  /** Free-form description of the dominant sources of uncertainty. */
  sources: string[];
  /** Quantified interval when the method supports it. */
  interval: { level: number; lower: number | null; upper: number | null; unit: string } | null;
  /** Skill metrics from validation, when the method is predictive. */
  validationMetrics: Record<string, number | null> | null;
  qualitative: 'low' | 'moderate' | 'high' | 'not_quantified';
}

export interface ProvenanceRecord {
  id: string;
  runId: string;
  createdAt: string;
  userId: string | null;
  projectId: string | null;
  toolName: string;
  toolVersion: string;
  dataSources: DataSourceRef[];
  processingSteps: ProcessingStep[];
  methods: MethodRef[];
  temporalCoverage: { start: string; end: string } | null;
  spatialExtent: string | null;
  assumptions: string[];
  limitations: string[];
  uncertainty: UncertaintyRecord;
  /** Deterministic hash of inputs + parameters, for reproducibility checks. */
  inputHash: string;
  softwareVersions: Record<string, string>;
}
