/** Transport-level API envelope types. */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiEnvelope<T> {
  data: T;
  error?: ApiError;
  meta?: {
    requestId: string;
    durationMs: number;
    [k: string]: unknown;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest extends LoginRequest {
  fullName: string;
  organization?: string;
}

/** WebSocket event contract for job/model/copilot progress. */
export type WsEvent =
  | { type: 'job.progress'; jobId: string; progress: number; message: string }
  | { type: 'job.completed'; jobId: string; outputLocation: string | null }
  | { type: 'job.failed'; jobId: string; error: string }
  | { type: 'model.log'; runId: string; line: string }
  | { type: 'copilot.tool'; conversationId: string; toolName: string; status: string; detail: string | null }
  | { type: 'alert'; severity: string; title: string; body: string }
  | { type: 'pong'; t: string };

export interface DataSourceStatus {
  id: string;
  name: string;
  kind: 'internal' | 'usgs' | 'noaa' | 'nwis' | 'prism' | 'object_storage' | 'science_service';
  status: 'online' | 'degraded' | 'offline' | 'not_configured';
  detail: string;
  lastCheckedAt: string;
}

export interface SystemStatus {
  api: 'online' | 'degraded';
  database: 'online' | 'offline' | 'not_configured';
  scienceService: 'online' | 'offline' | 'not_configured';
  queue: 'online' | 'offline' | 'not_configured';
  copilotEngine: 'anthropic' | 'deterministic-router';
  objectStorage: 'online' | 'offline' | 'not_configured';
  version: string;
  demoMode: boolean;
  sources: DataSourceStatus[];
}
