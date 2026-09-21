# Operations guide

Running, monitoring and extending a Hydrology Copilot deployment.

---

## Running

### Development, nothing installed

```bash
npm install
npm run dev
```

- Frontend <http://localhost:5173>, API <http://localhost:4000>, docs <http://localhost:4000/docs>
- Sign in: `demo@hydrologycopilot.org` / `demo1234`
- In-memory synthetic store, deterministic keyword router, in-process jobs

### Development, with the Python service

```bash
cd services/science
pip install -r requirements.txt
uvicorn hydro_science.app:app --port 8000 --reload
```

```bash
SCIENCE_SERVICE_URL=http://localhost:8000 npm run dev
```

Confirm with `curl localhost:4000/api/status | jq .data.scienceService` → `"online"`.

### Full stack

```bash
cp .env.example .env      # set JWT_SECRET
docker compose up --build
```

<http://localhost:8080>. The `migrate` service runs migrations and the seed before the API starts.

### Helper script

```bash
scripts/dev-api.sh start|stop|restart      # background API for smoke testing
SCIENCE_SERVICE_URL=http://localhost:8000 scripts/dev-api.sh restart
```

---

## Verifying a deployment

```bash
curl -s localhost:4000/api/health
curl -s localhost:4000/api/status     | jq '.data | {database, scienceService, copilotEngine, queue}'
curl -s localhost:4000/api/capabilities | jq '.data.models'
```

`/api/status` is the honest picture. `not_configured` means the feature is off and the platform will
say so wherever it matters; `offline` means it was configured but could not be reached, with the
error in `detail`.

End-to-end smoke test:

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@hydrologycopilot.org","password":"demo1234"}' \
  | jq -r .data.tokens.accessToken)

curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/dashboard | jq '.data.kpis | length'
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/water-balance | jq -r .data.summary
curl -s -X POST localhost:4000/api/copilot/chat -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"$(curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/projects | jq -r '.data[0].id')\",\"message\":\"Assess drought conditions\"}" \
  | jq '{engine, tools: [.toolsUsed[].name], answer}'
```

Visual regression across every route:

```bash
node scripts/screenshot.mjs /tmp/shots      # exits non-zero on any console error
```

---

## Database

```bash
DATABASE_URL=postgres://hydro:hydro@localhost:5432/hydro npm run db:migrate
DATABASE_URL=postgres://hydro:hydro@localhost:5432/hydro npm run db:seed
```

Migrations run in filename order, each in its own transaction, tracked in
`hydro.schema_migrations`. A failure rolls back that file and stops, leaving the database at the last
successfully applied migration.

TimescaleDB is optional and detected at migration time. Without it, observation tables remain plain
tables with BRIN time indexes; the migration prints a notice saying which path it took.

The seed is idempotent — it upserts on natural keys and can be re-run.

### Useful queries

```sql
-- Provenance for everything run today
SELECT tool_name, created_at, jsonb_array_length(data_sources) AS sources, input_hash
FROM hydro.provenance
WHERE created_at > now() - interval '1 day'
ORDER BY created_at DESC;

-- Copilot tool usage and failure rate
SELECT tool_name, count(*) AS calls,
       count(*) FILTER (WHERE status = 'failed') AS failures,
       round(avg(duration_ms)) AS avg_ms
FROM hydro.ai_tool_calls
GROUP BY tool_name ORDER BY calls DESC;

-- Record completeness by gauge
SELECT s.code, count(*) AS days,
       count(*) FILTER (WHERE f.discharge IS NULL) AS missing,
       min(f.ts)::date AS start, max(f.ts)::date AS finish
FROM hydro.streamflow f JOIN hydro.stations s ON s.id = f.station_id
GROUP BY s.code;
```

---

## Observability

Structured JSON logs (pino) with a request id on every line. Authorization headers are redacted.

Signals worth alerting on:

| Signal | Where | Why |
| --- | --- | --- |
| `Copilot tool execution failed` | API log | A tool is broken, not just an odd question |
| `Anthropic engine failed; falling back` | API log | Provider outage; answers continue via the router |
| `PostgreSQL unreachable` at boot | API log + `/api/status` | The deployment is silently non-durable |
| Job `failed` rate | `hydro.jobs` | Report or model-run failures |
| `/api/status` queue durability line | Status endpoint | Jobs execute in-process and do not survive a restart |
| `/api/status.scienceService = offline` | Status endpoint | ML forecasts are quietly running on the baseline |

Every model execution and every tool call has a run id (`provenance.runId`) that ties the log line,
the database record and the UI panel together.

---

## Extending the platform

### Adding an analytical tool

1. **Implement the method** in `packages/hydrology-core/src/`, with tests asserting published
   reference values.
2. **Write the analysis function** in `apps/api/src/services/analysis/`, returning a `ToolResult`
   built with `ProvenanceBuilder` — sources, methods with citations, ordered steps, assumptions,
   limitations, uncertainty.
3. **Declare the tool** in `apps/api/src/copilot/tools.ts` with a parameter schema and keywords.
4. **Register the executor** in `apps/api/src/copilot/registry.ts`.
5. **Expose a REST route** if the tool deserves a page of its own.
6. **Add an API test** asserting the provenance shape and any disclaimer the method requires.

Steps 3 and 4 make the tool available to both Copilot engines and to the UI catalogue at once.

### Adding a model engine

Extend `ExternalEngineAdapter` in `apps/api/src/services/models/adapters.ts`: declare the executable
environment variable, `requirements()`, `capabilities()` and `requiredInputs()`. The base class
handles availability detection, validation and the "integration required" response. Register it in
`EXTERNAL_ADAPTERS`.

### Adding a forecasting model

Add it to `_make_estimator()` in `services/science/hydro_science/forecasting.py`. Any estimator with
`fit`/`predict` works — the feature construction, chronological split, validation and residual
ensemble are shared. If it needs an optional dependency, detect it in `capabilities.py` and return a
warning naming the substitution when it is missing.

---

## Enabling an external engine

```bash
# HEC-RAS on Linux
export HEC_RAS_PATH=/opt/hec-ras/RasUnsteady
docker compose up -d backend
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/models/adapters \
  | jq '.data[] | select(.engine=="HEC-RAS") | {available, requirements}'
```

The adapter reports `available: true` once the path resolves. Process invocation is the remaining
step — see `runModel()` in `adapters.ts`, which currently refuses rather than pretending.

---

## Backup and recovery

- **Database** — `pg_dump` on a schedule. The `hydro` schema is self-contained.
- **Object storage** — S3 versioning or equivalent; uploads are immutable once written.
- **Nothing else is stateful.** The API, worker and Python service are all replaceable.

Recovery is: restore the database, redeploy the containers, confirm `/api/status`. The synthetic
demonstration data regenerates deterministically and never needs restoring.

---

## Production checklist

- [ ] `JWT_SECRET` set to a strong random value (the API refuses to start without it)
- [ ] `ALLOW_DEMO_LOGIN=false`
- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGINS` restricted, or the SPA served from the API's origin
- [ ] TLS terminated in front of nginx
- [ ] `DATABASE_URL` set and migrations applied — confirm `/api/status.database = "online"`
- [ ] Database backups scheduled and a restore tested
- [ ] Log aggregation collecting the JSON output
- [ ] Rate limits reviewed for the expected user population
- [ ] Provider API keys in a secret manager, not in a `.env` file on disk
- [ ] Synthetic demonstration project removed or clearly labelled if real projects share the instance
