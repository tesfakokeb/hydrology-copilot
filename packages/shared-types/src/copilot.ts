import type { ProvenanceRecord } from './provenance.js';
import type { ModelMetrics, Quantity, Unit } from './hydrology.js';

/** Intent categories the orchestrator routes on. */
export type CopilotIntent =
  | 'data_retrieval'
  | 'statistical_analysis'
  | 'machine_learning'
  | 'gis_analysis'
  | 'hydrologic_modeling'
  | 'forecasting'
  | 'visualization'
  | 'report_generation'
  | 'explanation'
  | 'unsupported';

export type ToolCategory =
  | 'streamflow'
  | 'drought'
  | 'water_quality'
  | 'flood'
  | 'forecasting'
  | 'gis'
  | 'modeling'
  | 'water_supply'
  | 'water_demand'
  | 'statistics'
  | 'ml'
  | 'output';

export interface ToolParameterSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly string[];
  items?: { type: string };
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  intent: CopilotIntent;
  description: string;
  /** Whether the tool requires an executable backend that may not be present. */
  requiresIntegration: boolean;
  integrationNote?: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required: string[];
  };
  keywords: string[];
}

export type ToolCallStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface ToolCallTraceStep {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string | null;
  at: string;
}

export interface ToolCall {
  id: string;
  name: string;
  category: ToolCategory;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  trace: ToolCallTraceStep[];
  result: ToolResult | null;
  error: string | null;
}

export interface ChartSpec {
  id: string;
  kind: 'line' | 'area' | 'bar' | 'scatter' | 'hydrograph' | 'fdc' | 'heatmap' | 'box' | 'forecast';
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  unit: Unit;
  series: {
    key: string;
    label: string;
    kind?: 'observed' | 'simulated' | 'forecast' | 'threshold' | 'band';
    color?: string;
  }[];
  data: Record<string, number | string | null>[];
  annotations?: { kind: 'hline' | 'vline' | 'band'; value: number | string; label: string; color?: string }[];
  /** Explicit statement of what the reader is looking at. */
  caption: string;
}

export interface MapSpec {
  id: string;
  title: string;
  caption: string;
  center: [number, number];
  zoom: number;
  layers: {
    id: string;
    label: string;
    kind: 'geojson' | 'points' | 'raster-grid';
    /** GeoJSON FeatureCollection or grid definition. */
    data: unknown;
    style?: Record<string, unknown>;
    legend?: { label: string; color: string }[];
  }[];
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  /** Structured payload, tool-specific. */
  data: Record<string, unknown>;
  charts: ChartSpec[];
  maps: MapSpec[];
  metrics: Partial<ModelMetrics> & Record<string, number | null>;
  quantities: Record<string, Quantity>;
  warnings: string[];
  provenance: ProvenanceRecord;
}

/** The structured scientific answer. Section 6 requires all of these fields. */
export interface ScientificAnswer {
  /** Prose answer. Numbers in here must be traceable to `toolsUsed` results. */
  answer: string;
  dataUsed: string[];
  timePeriod: string | null;
  spatialExtent: string | null;
  methods: string[];
  assumptions: string[];
  results: { label: string; value: string }[];
  uncertainty: string;
  recommendations: string[];
}

export interface CopilotMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  intent?: CopilotIntent;
  scientific?: ScientificAnswer;
  toolCalls?: ToolCall[];
  charts?: ChartSpec[];
  maps?: MapSpec[];
  warnings?: string[];
  /** Which engine produced the response. */
  engine?: 'anthropic' | 'deterministic-router';
}

export interface Conversation {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface CopilotChatRequest {
  projectId: string;
  message: string;
  conversationId?: string;
  datasetIds?: string[];
  context?: {
    watershedId?: string;
    stationId?: string;
    startDate?: string;
    endDate?: string;
  };
}

export interface CopilotChatResponse {
  conversationId: string;
  messageId: string;
  answer: string;
  scientific: ScientificAnswer;
  intent: CopilotIntent;
  toolsUsed: ToolCall[];
  dataSources: string[];
  charts: ChartSpec[];
  maps: MapSpec[];
  metrics: Record<string, number | null>;
  uncertainty: string;
  warnings: string[];
  engine: 'anthropic' | 'deterministic-router';
}
