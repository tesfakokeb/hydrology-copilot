import type { ForecastModelKind, ForecastPoint, ModelMetrics } from '@hydro/shared-types';

/**
 * Client for the Python scientific service.
 *
 * The Node gateway never implements machine-learning models itself. When the
 * service is reachable it hosts Random Forest, XGBoost, LSTM/GRU and the
 * Temporal Fusion Transformer scaffolding; when it is not, the caller falls
 * back to the TypeScript baselines in @hydro/hydrology-core and the response
 * says so. Silent substitution of one model for another is a scientific
 * integrity failure, so every fallback is reported.
 */

export interface ScienceForecastRequest {
  dates: string[];
  values: (number | null)[];
  precipitation?: (number | null)[];
  temperature?: (number | null)[];
  model: ForecastModelKind;
  horizonDays: number;
  validationFraction?: number;
  seed?: number;
}

export interface ScienceForecastResponse {
  model: ForecastModelKind;
  points: ForecastPoint[];
  metrics: ModelMetrics;
  featureImportance: { feature: string; importance: number }[];
  trainingPeriod: { start: string; end: string };
  validationPeriod: { start: string; end: string } | null;
  limitations: string[];
  warnings: string[];
  hyperparameters: Record<string, unknown>;
  library: string;
}

export interface ScienceHealth {
  status: 'online' | 'offline' | 'not_configured';
  detail: string;
  version?: string;
  models?: string[];
}

export class ScienceClient {
  constructor(private readonly baseUrl: string | null, private readonly timeoutMs = 60_000) {}

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  async health(): Promise<ScienceHealth> {
    if (!this.baseUrl) {
      return { status: 'not_configured', detail: 'SCIENCE_SERVICE_URL is not set. Machine-learning forecasts fall back to the TypeScript baseline models.' };
    }
    try {
      const res = await this.fetchJson<{ version: string; models: string[] }>('/health', undefined, 5_000);
      return { status: 'online', detail: 'Python scientific service reachable.', version: res.version, models: res.models };
    } catch (err) {
      return { status: 'offline', detail: `Python scientific service unreachable: ${(err as Error).message}` };
    }
  }

  async forecast(req: ScienceForecastRequest): Promise<ScienceForecastResponse | null> {
    if (!this.baseUrl) return null;
    try {
      return await this.fetchJson<ScienceForecastResponse>('/forecast', req);
    } catch {
      return null;
    }
  }

  async featureImportance(req: { features: Record<string, number[]>; target: number[] }): Promise<{ feature: string; importance: number }[] | null> {
    if (!this.baseUrl) return null;
    try {
      const r = await this.fetchJson<{ importances: { feature: string; importance: number }[] }>('/feature-importance', req);
      return r.importances;
    } catch {
      return null;
    }
  }

  async profileDataset(req: { filename: string; contentBase64: string }): Promise<Record<string, unknown> | null> {
    if (!this.baseUrl) return null;
    try {
      return await this.fetchJson<Record<string, unknown>>('/profile', req, 120_000);
    } catch {
      return null;
    }
  }

  private async fetchJson<T>(path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
