/**
 * @hydro/config — shared, environment-driven configuration.
 *
 * Every secret is read from the process environment. Nothing in this file is
 * ever imported by the browser bundle: the web client talks only to the Node
 * API gateway, which holds the provider credentials.
 */

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  corsOrigins: string[];
  databaseUrl: string | null;
  redisUrl: string | null;
  scienceServiceUrl: string | null;
  objectStorage: {
    endpoint: string | null;
    bucket: string;
    region: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    forcePathStyle: boolean;
  };
  auth: {
    jwtSecret: string;
    accessTokenTtl: string;
    refreshTokenTtl: string;
    /** When true the API accepts the built-in demo account. */
    allowDemoLogin: boolean;
  };
  copilot: {
    anthropicApiKey: string | null;
    model: string;
    maxToolIterations: number;
    /** Hard cap so a runaway conversation cannot exhaust the budget. */
    maxTokens: number;
  };
  rateLimit: { max: number; windowMs: number };
  demoMode: boolean;
  version: string;
}

function env(key: string, fallback?: string): string | null {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback ?? null;
  return v;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  const nodeEnv = (env('NODE_ENV', 'development') ?? 'development') as AppConfig['env'];
  const jwtSecret = env('JWT_SECRET');

  if (nodeEnv === 'production' && !jwtSecret) {
    throw new Error('JWT_SECRET must be set in production. Refusing to start with a development secret.');
  }

  return {
    env: nodeEnv,
    port: envInt('PORT', 4000),
    logLevel: (env('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug') ?? 'info') as AppConfig['logLevel'],
    corsOrigins: (env('CORS_ORIGINS', 'http://localhost:5173') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    databaseUrl: env('DATABASE_URL'),
    redisUrl: env('REDIS_URL'),
    scienceServiceUrl: env('SCIENCE_SERVICE_URL'),
    objectStorage: {
      endpoint: env('S3_ENDPOINT'),
      bucket: env('S3_BUCKET', 'hydrology-copilot') ?? 'hydrology-copilot',
      region: env('S3_REGION', 'us-east-1') ?? 'us-east-1',
      accessKeyId: env('S3_ACCESS_KEY_ID'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: envBool('S3_FORCE_PATH_STYLE', true),
    },
    auth: {
      jwtSecret: jwtSecret ?? 'development-only-secret-do-not-use-in-production',
      accessTokenTtl: env('ACCESS_TOKEN_TTL', '30m') ?? '30m',
      refreshTokenTtl: env('REFRESH_TOKEN_TTL', '30d') ?? '30d',
      allowDemoLogin: envBool('ALLOW_DEMO_LOGIN', nodeEnv !== 'production'),
    },
    copilot: {
      anthropicApiKey: env('ANTHROPIC_API_KEY'),
      model: env('ANTHROPIC_MODEL', 'claude-sonnet-4-5') ?? 'claude-sonnet-4-5',
      maxToolIterations: envInt('COPILOT_MAX_TOOL_ITERATIONS', 6),
      maxTokens: envInt('COPILOT_MAX_TOKENS', 4096),
    },
    rateLimit: { max: envInt('RATE_LIMIT_MAX', 300), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) },
    demoMode: envBool('DEMO_MODE', true),
    version: env('APP_VERSION', '1.0.0') ?? '1.0.0',
  };
}

export const DEMO_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'demo@hydrologycopilot.org',
  password: 'demo1234',
  fullName: 'Demonstration Analyst',
  organization: 'Hydrology Copilot Demo',
  role: 'admin' as const,
};
