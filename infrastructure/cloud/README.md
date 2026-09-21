# Cloud deployment notes

The stack is four independently scalable pieces plus managed state. Nothing below is required to run
the platform — `docker compose up` is a complete deployment for a workgroup — but this is how it maps
onto managed services.

## Shape

| Component | Scales with | Managed options |
| --- | --- | --- |
| Frontend (static) | Nothing; it is a CDN artefact | Vercel, Netlify, S3 + CloudFront, Azure Static Web Apps |
| API gateway | Concurrent users; I/O-bound | AWS App Runner / ECS Fargate, Azure Container Apps, Cloud Run, Render, Railway |
| Worker | Analysis and report volume | The same image, no HTTP ingress |
| Python service | Model training volume; CPU-bound | The same platforms, with more CPU and less concurrency |
| PostgreSQL + PostGIS | Data volume | RDS/Aurora, Azure Database for PostgreSQL, Cloud SQL |
| Redis | Queue depth | ElastiCache, Azure Cache for Redis, Memorystore |
| Object storage | Upload volume | S3, Azure Blob, GCS, MinIO |

The API and the worker run the same image; the worker simply has no ingress. Scale them separately —
a report generation or a model calibration should never compete with a dashboard request.

## Sizing starting points

| Service | CPU | Memory | Notes |
| --- | --- | --- | --- |
| API | 0.5 vCPU | 1 GB | Mostly I/O; the TypeScript science runs in-process and is fast |
| Worker | 1 vCPU | 2 GB | GR4J calibration is the heaviest in-process work |
| Python service | 2 vCPU | 4 GB | XGBoost training on a 30-year daily record takes seconds; PyTorch wants more |
| PostgreSQL | 2 vCPU | 8 GB | A 30-year daily record for a few dozen gauges is small; TimescaleDB helps at hundreds |

## Secrets

Provider API keys, database credentials and storage keys belong in a secret manager — AWS Secrets
Manager, Azure Key Vault, Google Secret Manager — injected as environment variables at start.

**No credential ever reaches the browser.** The frontend talks only to the API gateway, which is the
only component holding any.

## Health and readiness

Every service exposes a health endpoint used by the compose healthchecks and suitable for a load
balancer:

- API: `GET /api/health` (liveness), `GET /api/status` (readiness, with component detail)
- Python service: `GET /health`

Point liveness probes at `/api/health` and readiness at `/api/status`; the latter reports the
database and science service so a container that lost its database is taken out of rotation.

## What to watch after deploying

1. `/api/status.database` — `not_configured` in production means the deployment is silently
   non-durable.
2. `/api/status.scienceService` — `offline` means ML forecasts are running on the baseline. The API
   says so in every response, but the metric is worth alerting on.
3. `hydro.jobs` failure rate.
4. `hydro.ai_tool_calls` failures by tool name — a broken tool, not an odd question.
