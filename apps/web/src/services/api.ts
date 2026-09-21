import type {
  Alert,
  AuthTokens,
  Conversation,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotMessage,
  Dataset,
  Job,
  KpiCard,
  ModelRun,
  Project,
  ProvenanceRecord,
  Report,
  Reservoir,
  Scenario,
  Station,
  SystemStatus,
  TimeSeries,
  ToolDefinition,
  ToolResult,
  User,
  Watershed,
} from '@hydro/shared-types';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = localStorage.getItem('hydro.accessToken');
let refreshToken: string | null = localStorage.getItem('hydro.refreshToken');
let onUnauthenticated: (() => void) | null = null;

export function setTokens(tokens: AuthTokens | null): void {
  accessToken = tokens?.accessToken ?? null;
  refreshToken = tokens?.refreshToken ?? null;
  if (tokens) {
    localStorage.setItem('hydro.accessToken', tokens.accessToken);
    localStorage.setItem('hydro.refreshToken', tokens.refreshToken);
  } else {
    localStorage.removeItem('hydro.accessToken');
    localStorage.removeItem('hydro.refreshToken');
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

interface Envelope<T> {
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401 && retry && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init, false);
    onUnauthenticated?.();
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: Envelope<T> | undefined;
  try {
    body = text ? (JSON.parse(text) as Envelope<T>) : undefined;
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', `The API returned a non-JSON response (${res.status}).`);
  }

  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status}).`, err?.details);
  }
  return (body as Envelope<T>).data;
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as Envelope<{ tokens: AuthTokens }>;
    setTokens(body.data.tokens);
    return true;
  } catch {
    return false;
  }
}

const qs = (params: Record<string, string | number | undefined | null>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // System
  status: () => request<SystemStatus>('/api/status'),
  capabilities: () => request<Record<string, unknown>>('/api/capabilities'),
  demoCredentials: () => request<{ enabled: boolean; email?: string; password?: string; note: string }>('/api/auth/demo-credentials'),

  // Auth
  login: (email: string, password: string) =>
    request<{ tokens: AuthTokens; user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (body: { email: string; password: string; fullName: string; organization?: string }) =>
    request<{ tokens: AuthTokens; user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  me: () => request<User | null>('/api/auth/me'),

  // Projects
  projects: () => request<Project[]>('/api/projects'),
  project: (id: string) => request<{ project: Project; watersheds: Watershed[] }>(`/api/projects/${id}`),
  createProject: (body: { name: string; description?: string; agency?: string; unitSystem?: 'SI' | 'US' }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: string, body: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  scenarios: (projectId: string) => request<Scenario[]>(`/api/projects/${projectId}/scenarios`),
  scenarioDefinitions: () => request<{ name: string; label: string; description: string; inflowFactor: number; demandFactor: number }[]>('/api/scenarios'),

  // Spatial
  watersheds: (projectId?: string) => request<Watershed[]>(`/api/watersheds${qs({ projectId })}`),
  watershed: (id: string) => request<{ watershed: Watershed; subbasins: unknown[]; stations: Station[]; reservoirs: Reservoir[] }>(`/api/watersheds/${id}`),
  watershedGeoJson: (id: string) => request<unknown>(`/api/watersheds/${id}/geojson`),
  reaches: (id: string) => request<unknown>(`/api/watersheds/${id}/reaches`),
  stations: (params: { watershedId?: string; type?: string } = {}) => request<Station[]>(`/api/stations${qs(params)}`),

  // Data
  series: (params: { variable: string; stationId?: string; start?: string; end?: string; maxPoints?: number }) =>
    request<TimeSeries>(`/api/series${qs(params)}`),
  streamflow: (params: { stationId?: string; start?: string; end?: string } = {}) => request<ToolResult>(`/api/streamflow${qs(params)}`),
  streamflowStatistics: (params: { stationId?: string; start?: string; end?: string } = {}) =>
    request<ToolResult>(`/api/streamflow/statistics${qs(params)}`),
  streamflowEvents: (params: { stationId?: string; thresholdPercentile?: number } = {}) =>
    request<ToolResult>(`/api/streamflow/events${qs(params)}`),
  precipitation: (params: { start?: string; end?: string } = {}) => request<ToolResult>(`/api/precipitation${qs(params)}`),
  waterQuality: (params: { stationId?: string; parameters?: string; start?: string; end?: string } = {}) =>
    request<ToolResult>(`/api/water-quality${qs(params)}`),
  waterQualityRaw: (params: { stationId?: string; parameters?: string } = {}) =>
    request<{ t: string; stationCode: string; parameter: string; value: number; unit: string }[]>(`/api/water-quality/raw${qs(params)}`),

  // Analysis
  dashboard: (projectId?: string) => request<{ kpis: KpiCard[]; alerts: Alert[]; asOf: string }>(`/api/dashboard${qs({ projectId })}`),
  forecast: (params: { horizonDays?: number; model?: string; stationId?: string } = {}) =>
    request<ToolResult>(`/api/forecast/streamflow${qs(params)}`),
  drought: () => request<ToolResult>('/api/drought'),
  droughtIndex: (params: { index?: string; timescaleMonths?: number } = {}) => request<ToolResult>(`/api/drought/index${qs(params)}`),
  floodRisk: (params: { horizonDays?: number } = {}) => request<ToolResult>(`/api/flood-risk${qs(params)}`),
  floodFrequency: (params: { method?: string } = {}) => request<ToolResult>(`/api/flood-risk/frequency${qs(params)}`),
  returnPeriod: (discharge: number) => request<ToolResult>(`/api/flood-risk/return-period${qs({ discharge })}`),
  waterBalance: () => request<ToolResult>('/api/water-balance'),
  waterSupply: (params: { scenario?: string } = {}) => request<ToolResult>(`/api/water-supply${qs(params)}`),
  supplyDemandBalance: (params: { scenarios?: string } = {}) => request<ToolResult>(`/api/water-supply/balance${qs(params)}`),
  waterDemand: (params: { horizonMonths?: number; sector?: string } = {}) => request<ToolResult>(`/api/water-demand${qs(params)}`),
  watershedAnalysis: (params: { watershedId?: string } = {}) => request<ToolResult>(`/api/gis/watershed-analysis${qs(params)}`),
  gisQuery: (params: { operation?: string; lon?: number; lat?: number } = {}) => request<ToolResult>(`/api/gis/query${qs(params)}`),
  reservoirs: (watershedId?: string) => request<Reservoir[]>(`/api/reservoirs${qs({ watershedId })}`),
  reservoirSeries: (id: string) => request<Record<string, number | string>[]>(`/api/reservoirs/${id}/series`),
  demandHistory: (projectId?: string) => request<{ t: string; sector: string; demandMcm: number; population: number }[]>(`/api/water-demand/history${qs({ projectId })}`),

  // Models
  modelAdapters: () => request<{ engine: string; displayName: string; description: string; available: boolean; requirements: { kind: string; name: string; description: string; envVar?: string }[]; capabilities: string[] }[]>('/api/models/adapters'),
  runModel: (body: { engine?: string; calibrate?: boolean; projectId?: string }) =>
    request<{ run: ModelRun; result: ToolResult }>('/api/models/run', { method: 'POST', body: JSON.stringify(body) }),
  modelRuns: (projectId?: string) => request<ModelRun[]>(`/api/models/runs${qs({ projectId })}`),

  // Datasets
  datasets: (projectId?: string) => request<Dataset[]>(`/api/datasets${qs({ projectId })}`),
  dataset: (id: string) => request<Dataset>(`/api/datasets/${id}`),
  datasetPreview: (id: string, rows = 40) => request<{ lines: string[] }>(`/api/datasets/${id}/preview${qs({ rows })}`),
  uploadDataset: (file: File, projectId: string, description?: string) => {
    const form = new FormData();
    form.append('projectId', projectId);
    if (description) form.append('description', description);
    form.append('file', file);
    return request<Dataset>('/api/datasets/upload', { method: 'POST', body: form });
  },
  deleteDataset: (id: string) => request<void>(`/api/datasets/${id}`, { method: 'DELETE' }),

  // Copilot
  copilotTools: () => request<{ tools: (ToolDefinition & { executable: boolean })[]; suggestedPrompts: string[]; engine: string }>('/api/copilot/tools'),
  copilotChat: (body: CopilotChatRequest) => request<CopilotChatResponse>('/api/copilot/chat', { method: 'POST', body: JSON.stringify(body) }),
  copilotRunTool: (body: { tool: string; projectId?: string; arguments?: Record<string, unknown> }) =>
    request<ToolResult>('/api/copilot/run-tool', { method: 'POST', body: JSON.stringify(body) }),
  conversations: (projectId?: string) => request<Conversation[]>(`/api/copilot/conversations${qs({ projectId })}`),
  conversation: (id: string) => request<{ conversation: Conversation; messages: CopilotMessage[] }>(`/api/copilot/conversations/${id}`),

  // Jobs, reports, provenance
  jobs: (projectId?: string) => request<{ jobs: Job[]; stats: Record<string, unknown>; kinds: string[] }>(`/api/jobs${qs({ projectId })}`),
  reports: (projectId?: string) => request<{ reports: Report[]; kinds: Record<string, string> }>(`/api/reports${qs({ projectId })}`),
  generateReport: (body: { kind: string; projectId?: string; title?: string }) =>
    request<{ report: Report; result: ToolResult }>('/api/reports/sync', { method: 'POST', body: JSON.stringify(body) }),
  reportHtmlUrl: (id: string) => `${BASE}/api/reports/${id}/html`,
  provenance: (projectId?: string, limit = 50) => request<ProvenanceRecord[]>(`/api/provenance${qs({ projectId, limit })}`),
  provenanceRecord: (id: string) => request<ProvenanceRecord>(`/api/provenance/${id}`),
};
