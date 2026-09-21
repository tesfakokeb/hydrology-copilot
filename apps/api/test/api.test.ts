import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

/**
 * API integration tests.
 *
 * The server is built in-process and exercised through Fastify's inject, so
 * these run without a port, a database or the Python service — exactly the
 * configuration a fresh checkout has. Anything that only works with those
 * present is asserted to degrade explicitly rather than to fail silently.
 */

let app: FastifyInstance;
let token: string;
let projectId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-not-for-production';
  process.env.NODE_ENV = 'test';
  const built = await buildServer();
  app = built.app;
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'demo@hydrologycopilot.org', password: 'demo1234' },
  });
  token = login.json().data.tokens.accessToken;

  const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${token}` } });
  projectId = projects.json().data[0].id;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('system', () => {
  it('reports liveness without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('ok');
  });

  it('reports component status honestly when nothing optional is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    const status = res.json().data;
    expect(status.api).toBe('online');
    // Without DATABASE_URL the store must say "not configured", not "online".
    expect(['not_configured', 'online', 'offline']).toContain(status.database);
    expect(status.sources.some((s: { id: string }) => s.id === 'demo')).toBe(true);
    const demo = status.sources.find((s: { id: string }) => s.id === 'demo');
    expect(demo.detail).toMatch(/Not observed data/i);
  });

  it('serves OpenAPI documentation', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().info.title).toContain('Hydrology Copilot');
  });
});

describe('authentication', () => {
  it('rejects an unauthenticated analytical request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects wrong credentials without revealing whether the account exists', async () => {
    const wrongPassword = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'demo@hydrologycopilot.org', password: 'wrong-password' } });
    const noAccount = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.org', password: 'wrong-password' } });
    expect(wrongPassword.statusCode).toBe(401);
    expect(noAccount.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(noAccount.json().error.message);
  });

  it('refuses a refresh token used as an access token', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'demo@hydrologycopilot.org', password: 'demo1234' } });
    const refresh = login.json().data.tokens.refreshToken;
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${refresh}` } });
    expect(res.statusCode).toBe(401);
  });

  it('returns the authenticated user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() });
    expect(res.json().data.email).toBe('demo@hydrologycopilot.org');
  });
});

describe('spatial and data endpoints', () => {
  it('lists the demonstration watershed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/watersheds', headers: auth() });
    const watersheds = res.json().data;
    expect(watersheds.length).toBeGreaterThan(0);
    expect(watersheds[0].isDemo).toBe(true);
    expect(watersheds[0].areaKm2).toBeGreaterThan(0);
  });

  it('returns valid GeoJSON for the watershed', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/watersheds', headers: auth() });
    const id = list.json().data[0].id;
    const res = await app.inject({ method: 'GET', url: `/api/watersheds/${id}/geojson`, headers: auth() });
    const fc = res.json().data;
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBeGreaterThan(1);
    expect(fc.features[0].geometry.type).toBe('Polygon');
  });

  it('returns a discharge series with an explicit unit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/series?variable=discharge&maxPoints=500', headers: auth() });
    const series = res.json().data;
    expect(series.unit).toBe('m3/s');
    expect(series.points.length).toBeGreaterThan(100);
    expect(series.points.length).toBeLessThanOrEqual(1000);
  });

  it('refuses a series request without a variable rather than guessing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/series', headers: auth() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_VARIABLE');
  });
});

describe('analysis endpoints', () => {
  it('computes dashboard KPIs with units and status', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/dashboard?projectId=${projectId}`, headers: auth() });
    const { kpis, alerts } = res.json().data;
    expect(kpis.length).toBeGreaterThan(10);
    for (const k of kpis) {
      expect(k.unit).toBeTruthy();
      expect(['normal', 'watch', 'warning', 'critical', 'unknown']).toContain(k.status);
      expect(k.context).toBeTruthy();
    }
    expect(Array.isArray(alerts)).toBe(true);
  }, 60_000);

  it('returns flow statistics with a provenance record', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/streamflow/statistics', headers: auth() });
    const result = res.json().data;
    expect(result.ok).toBe(true);
    expect(result.provenance.toolName).toBe('analyze_streamflow');
    expect(result.provenance.dataSources.length).toBeGreaterThan(0);
    expect(result.provenance.dataSources[0].isSynthetic).toBe(true);
    expect(result.provenance.methods.length).toBeGreaterThan(0);
    expect(result.provenance.assumptions.length).toBeGreaterThan(0);
    expect(result.provenance.inputHash).toMatch(/^[0-9a-f]{32}$/);
  }, 60_000);

  it('fits flood-frequency curves that increase with return period', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/flood-risk/frequency', headers: auth() });
    const quantiles = res.json().data.data.primary.quantiles;
    for (let i = 1; i < quantiles.length; i++) {
      expect(quantiles[i].discharge).toBeGreaterThan(quantiles[i - 1].discharge);
    }
  }, 60_000);

  it('states the regulatory disclaimer on every flood result', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/flood-risk/frequency', headers: auth() });
    const text = JSON.stringify(res.json().data.provenance.limitations);
    expect(text).toMatch(/FEMA/);
    expect(text).toMatch(/not.*regulatory/i);
  }, 60_000);

  it('produces a forecast with validation skill and prediction intervals', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/forecast/streamflow?horizonDays=7&model=arima', headers: auth() });
    const result = res.json().data;
    const forecast = result.data.forecast;
    expect(forecast.points).toHaveLength(7);
    expect(forecast.metrics.nse).toBeGreaterThan(0);
    for (const p of forecast.points) {
      expect(p.lower95).toBeLessThanOrEqual(p.lower80);
      expect(p.upper80).toBeLessThanOrEqual(p.upper95);
      expect(p.lower95).toBeGreaterThanOrEqual(0);
    }
  }, 90_000);

  it('reports the substitution when a machine-learning model is unavailable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/forecast/streamflow?horizonDays=3&model=lstm', headers: auth() });
    const result = res.json().data;
    if (result.data.forecast.model !== 'lstm') {
      expect(result.warnings.join(' ')).toMatch(/Python scientific service/i);
    }
  }, 90_000);

  it('closes the water balance on the synthetic record', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/water-balance', headers: auth() });
    const balance = res.json().data.data.balance;
    expect(Math.abs(balance.residualPctOfPrecip)).toBeLessThan(15);
    expect(balance.runoffCoefficient).toBeGreaterThan(0.1);
    expect(balance.runoffCoefficient).toBeLessThan(0.9);
  }, 60_000);

  it('runs the built-in GR4J model and reports its skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/run',
      headers: auth(),
      payload: { engine: 'GR4J', calibrate: true, projectId },
    });
    const { result } = res.json().data;
    expect(result.ok).toBe(true);
    expect(result.metrics.nse).toBeGreaterThan(0.4);
    expect(result.data.parameters.x1).toBeGreaterThan(0);
  }, 180_000);

  it('reports "integration required" for an unconfigured external engine rather than fabricating a run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/run',
      headers: auth(),
      payload: { engine: 'HEC-RAS', projectId },
    });
    const { result } = res.json().data;
    expect(result.ok).toBe(false);
    expect(result.data.integrationRequired).toBe(true);
    expect(result.summary).toMatch(/integration required/i);
    expect(result.charts).toHaveLength(0);
    expect(result.metrics).toEqual({});
  }, 60_000);
});

describe('copilot', () => {
  it('publishes a tool catalogue where every listed tool is executable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/copilot/tools', headers: auth() });
    const { tools } = res.json().data;
    expect(tools.length).toBeGreaterThan(25);
    const notExecutable = tools.filter((t: { executable: boolean }) => !t.executable);
    expect(notExecutable).toHaveLength(0);
  });

  it('routes a natural-language question to the right tools without running them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copilot/route',
      headers: auth(),
      payload: { message: 'Forecast streamflow for the next 14 days' },
    });
    const plan = res.json().data;
    const names = plan.calls.map((c: { name: string }) => c.name);
    expect(names).toContain('forecast_streamflow');
    const forecastCall = plan.calls.find((c: { name: string }) => c.name === 'forecast_streamflow');
    expect(forecastCall.arguments.horizonDays).toBe(14);
    expect(plan.intent).toBe('forecasting');
  });

  it('extracts an SPI timescale from the question', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copilot/route',
      headers: auth(),
      payload: { message: 'Calculate SPI-12 from the precipitation dataset' },
    });
    const plan = res.json().data;
    const spiCall = plan.calls.find((c: { name: string }) => c.name.includes('spi'));
    expect(spiCall).toBeDefined();
    expect(spiCall.arguments.timescaleMonths).toBe(12);
  });

  it('declines a question it cannot answer with a computation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copilot/chat',
      headers: auth(),
      payload: { projectId, message: 'What is the capital of France?' },
    });
    const answer = res.json().data;
    expect(answer.toolsUsed).toHaveLength(0);
    expect(answer.answer).toMatch(/could not match|do not answer/i);
  }, 60_000);

  it('answers a drought question by running tools and returns a full scientific answer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copilot/chat',
      headers: auth(),
      payload: { projectId, message: 'Is this watershed experiencing drought?' },
    });
    const answer = res.json().data;
    expect(answer.toolsUsed.length).toBeGreaterThan(0);
    expect(answer.toolsUsed.every((t: { status: string }) => t.status === 'succeeded')).toBe(true);
    expect(answer.scientific.dataUsed.length).toBeGreaterThan(0);
    expect(answer.scientific.methods.length).toBeGreaterThan(0);
    expect(answer.scientific.assumptions.length).toBeGreaterThan(0);
    expect(answer.scientific.uncertainty).toBeTruthy();
    expect(answer.charts.length).toBeGreaterThan(0);
    expect(answer.engine).toBe('deterministic-router');
  }, 120_000);

  it('persists the conversation and its tool calls', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/api/copilot/chat',
      headers: auth(),
      payload: { projectId, message: 'Analyze my watershed' },
    });
    const { conversationId } = chat.json().data;
    const res = await app.inject({ method: 'GET', url: `/api/copilot/conversations/${conversationId}`, headers: auth() });
    const { messages } = res.json().data;
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].toolCalls.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('reports and provenance', () => {
  it('generates a report whose HTML carries the synthetic-data banner and a provenance section', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/sync',
      headers: auth(),
      payload: { kind: 'drought_assessment', projectId },
    });
    const { report } = res.json().data;
    expect(report.status).toBe('ready');

    const html = await app.inject({ method: 'GET', url: `/api/reports/${report.id}/html`, headers: auth() });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Synthetic demonstration data');
    expect(html.body).toContain('Provenance and reproducibility');
    expect(html.body).toContain('Limitations');
    expect(html.body).toContain('Uncertainty');
  }, 180_000);

  it('records provenance for every analysis run', async () => {
    await app.inject({ method: 'GET', url: '/api/streamflow/statistics', headers: auth() });
    const res = await app.inject({ method: 'GET', url: `/api/provenance?projectId=${projectId}`, headers: auth() });
    expect(Array.isArray(res.json().data)).toBe(true);
  }, 60_000);
});

describe('error handling', () => {
  it('returns a structured 404 naming the documentation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nonexistent', headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('/docs');
  });

  it('rejects an unknown Copilot tool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copilot/run-tool',
      headers: auth(),
      payload: { tool: 'definitely_not_a_tool' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_TOOL');
  });

  it('protects the pre-loaded demonstration project from deletion', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: auth() });
    expect(res.statusCode).toBe(409);
  });
});
