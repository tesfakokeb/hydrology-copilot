# Hydrology Copilot

**AI-Powered Water Resources Intelligence**
*Analyze. Forecast. Model. Predict. Manage Water.*

A cloud-native decision-support platform for hydrologists, water resources engineers, planners and
emergency managers. It combines a conversational analytical interface with real hydrologic science:
drought indices, flood frequency, rainfall-runoff modelling, probabilistic forecasting, water-quality
analytics and reservoir simulation — each one implemented against a published method, unit-tested
against reference values, and reported with the data, assumptions, limitations and uncertainty behind it.

---

## The one commitment everything else follows from

**No number appears in this application unless a computation produced it, and every computation
carries a provenance record.**

That single rule shapes the architecture:

- The Copilot is a *tool selector*, not a text generator. It cannot state a discharge, an index value
  or a model metric that did not come from a tool result. When no tool fits the question, it says so.
- Every analytical endpoint returns the same `ToolResult` shape: a summary, quantities **with units**,
  metrics, charts, maps, warnings — and a `ProvenanceRecord` naming the datasets, versions, temporal
  and spatial coverage, methods with citations, ordered processing steps, assumptions, limitations,
  quantified uncertainty and a hash of the inputs.
- Unavailable capabilities are reported, never faked. An unconfigured HEC-RAS returns
  "integration required" with its exact requirements. A requested XGBoost forecast served by a
  fallback model says which model actually ran and whose skill the metrics describe.
- Insufficient data produces a refusal with a reason, not a plausible-looking number.

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Scientific methods](#scientific-methods)
- [The AI Copilot](#the-ai-copilot)
- [Forecasting](#forecasting)
- [Model integrations](#model-integrations)
- [The demonstration dataset](#the-demonstration-dataset)
- [Configuration](#configuration)
- [Database](#database)
- [API](#api)
- [GIS](#gis)
- [Testing](#testing)
- [Security](#security)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)

---

## Quick start

### Without any external service

```bash
npm install
npm run dev
```

Open <http://localhost:5173> and sign in with **demo@hydrologycopilot.org / demo1234**.

Everything works: 30 years of synthetic daily data, all seventeen sections, the Copilot, model
calibration, report generation. `/api/status` reports the database as `not_configured` and the
Copilot engine as `deterministic-router`, so nothing about the session is mistaken for persistence
or for a language model.

### Full stack

```bash
cp .env.example .env      # set JWT_SECRET
docker compose up
```

Open <http://localhost:8080>. This brings up PostgreSQL/PostGIS + TimescaleDB, Redis, MinIO, the
Python scientific service, the API, a worker, the frontend and nginx. The database is migrated and
seeded automatically before the API starts.

### Adding capabilities incrementally

| Add                                         | Unlocks                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL` + `npm run db:migrate && npm run db:seed` | Persistence, PostGIS spatial queries, TimescaleDB hypertables |
| `SCIENCE_SERVICE_URL`                       | Random Forest, XGBoost, LightGBM; NetCDF/GeoTIFF/Parquet profiling    |
| `ANTHROPIC_API_KEY`                         | Language-model tool selection and prose (results are unchanged)       |
| `REDIS_URL`                                 | Declared for the queue integration point; jobs still execute in-process today (`/api/status` says so) |
| `HEC_RAS_PATH`, `HEC_HMS_PATH`, `SWAT_PATH` … | The corresponding model adapters                                    |
| `services/science/requirements-deep.txt`    | LSTM and GRU forecasting                                              |
| `services/science/requirements-geo.txt`     | Geospatial and multidimensional readers                               |

---

## Architecture

```mermaid
flowchart TB
    subgraph client["Browser"]
        WEB["React + TypeScript SPA<br/>Vite · Tailwind · TanStack Query<br/>Recharts · MapLibre GL"]
    end

    subgraph edge["Edge"]
        NGINX["nginx<br/>single origin · CSP · WebSocket upgrade"]
    end

    subgraph gateway["Node API gateway"]
        API["Fastify · TypeScript<br/>JWT + RBAC · OpenAPI · WebSocket"]
        ORCH["Copilot orchestrator<br/>intent → tools → results → answer"]
        TOOLS["Tool registry<br/>30+ analytical tools"]
        PROV["Provenance builder"]
        QUEUE["Job queue<br/>BullMQ / in-process"]
    end

    subgraph science["Scientific computation"]
        CORE["@hydro/hydrology-core<br/>TypeScript reference implementations<br/>SPI · SPEI · LP3 · GEV · GR4J · CCME · KGE"]
        PY["Python service · FastAPI<br/>scikit-learn · XGBoost · PyTorch<br/>xarray · rasterio · geopandas"]
    end

    subgraph storage["State"]
        PG[("PostgreSQL<br/>PostGIS · TimescaleDB")]
        REDIS[("Redis")]
        S3[("S3 / MinIO / Azure Blob / GCS")]
    end

    subgraph external["External engines (adapters)"]
        HMS["HEC-HMS"]
        RAS["HEC-RAS 2D"]
        SWAT["SWAT / SWAT+"]
        MF["MODFLOW 6"]
    end

    WEB --> NGINX --> API
    API --> ORCH --> TOOLS
    TOOLS --> CORE
    TOOLS --> PY
    TOOLS --> PROV
    API --> QUEUE --> PY
    API --> PG
    QUEUE --> REDIS
    API --> S3
    TOOLS -.-> HMS & RAS & SWAT & MF
    API -. "job & tool progress" .-> WEB
```

### Why the science lives in two places

`@hydro/hydrology-core` holds TypeScript implementations of every method the platform *reports*:
drought indices, flood frequency, flow statistics, baseflow separation, model metrics, GR4J,
reservoir simulation. It is dependency-free, deterministic and unit-tested against published values.
That is what makes the platform scientifically useful on a laptop with nothing installed.

The Python service holds what genuinely belongs in the scientific Python stack: gradient boosting,
recurrent networks, permutation importance, and the readers for NetCDF, GeoTIFF, Parquet and
shapefiles. The two agree on metrics by construction — `services/science/tests/test_metrics.py` and
`packages/hydrology-core/test/metrics.test.ts` assert the same reference values, so a divergence
between the stacks is a test failure rather than a silent inconsistency.

### Copilot request flow

```mermaid
sequenceDiagram
    participant U as Analyst
    participant W as Web client
    participant O as Orchestrator
    participant R as Tool registry
    participant C as hydrology-core / Python service
    participant P as Provenance store

    U->>W: "Is this watershed in drought, and forecast 7 days?"
    W->>O: POST /api/copilot/chat
    O->>O: Intent detection (model, or deterministic router)
    O->>R: assess_drought{}, forecast_streamflow{horizonDays:7}
    R->>C: Compute SPI/SPEI/SSI, fit and validate a forecast
    C-->>R: Results + metrics + warnings
    R->>P: Persist a provenance record per tool
    R-->>O: ToolResult[]
    O->>O: Compose the structured scientific answer
    O-->>W: answer · toolsUsed · charts · maps · uncertainty · warnings
    W-->>U: Prose, tool trace, figures, and an inspectable provenance panel
```

### Asynchronous work

```mermaid
flowchart LR
    REQ["Request"] --> JOB["Create job<br/>queued"]
    JOB --> Q{{"Queue<br/>BullMQ or in-process"}}
    Q --> WK["Worker"]
    WK --> RUN["Analysis / model run"]
    RUN --> STORE["Persist results<br/>+ provenance"]
    STORE --> WS(["WebSocket notification"])
    WS --> UI["Frontend updates"]
```

---

## Technology stack

| Layer         | Choice                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| Frontend      | React 18, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, Zustand  |
| Charts / maps | Recharts, MapLibre GL                                                            |
| API           | Node 22, TypeScript, Fastify 5, JWT, OpenAPI/Swagger, WebSocket, Zod validation  |
| Science (TS)  | `@hydro/hydrology-core` — dependency-free, unit-tested                           |
| Science (Py)  | FastAPI, NumPy, pandas, SciPy, scikit-learn, XGBoost; optional PyTorch, GeoPandas, rasterio, xarray |
| Database      | PostgreSQL 16, PostGIS, TimescaleDB (optional, detected at migration time)       |
| Queue         | In-process executor with a documented BullMQ + Redis integration point           |
| Storage       | S3-compatible (AWS S3, Azure Blob, GCS, MinIO), local filesystem fallback        |
| Container     | Docker, docker compose, nginx                                                    |

---

## Scientific methods

Every method below is implemented, cited and unit-tested. Citations appear in the UI's provenance
panel and in generated reports.

### Streamflow

| Method | Implementation | Reference |
| --- | --- | --- |
| Flow-duration curve | Weibull plotting position `i/(n+1)` | Searcy (1959), USGS WSP 1542-A |
| 7Q10 low flow | Log-normal fit to annual 7-day minima | Standard regulatory low-flow statistic |
| Baseflow separation | Lyne–Hollick recursive digital filter, three passes, α = 0.925 | Nathan & McMahon (1990) |
| Annual peaks | USGS water year (1 Oct – 30 Sep) | — |
| Bankfull proxy | 1.5-year recurrence-interval peak | Labelled an approximation, never a survey |
| Event extraction | Peak-over-threshold with declustering | — |

### Drought

| Method | Implementation | Reference |
| --- | --- | --- |
| SPI | Gamma (Thom MLE), zero-inflated, fitted per calendar month | McKee et al. (1993); WMO-No. 1090 |
| SPEI | Three-parameter log-logistic by L-moments on P − PET | Vicente-Serrano et al. (2010) |
| SSI | SPI transform on accumulated streamflow | Vicente-Serrano et al. (2012) |
| Reference ET | Hargreaves–Samani with FAO-56 extraterrestrial radiation | Hargreaves & Samani (1985) |
| Classification | US Drought Monitor breakpoints (D0–D4, W0–W4) | Svoboda et al. (2002) |

PDSI is deliberately **not** implemented: it requires calibrated soil available-water capacity by
climate division. The tool exists, explains what is missing, and offers SPEI as the closest
computable alternative.

### Flood

| Method | Implementation | Reference |
| --- | --- | --- |
| Log-Pearson III | Wilson–Hilferty frequency factors, optional Bulletin 17B skew weighting, first-order confidence limits | Bulletin 17B (1982); Bulletin 17C (2018) |
| GEV | L-moments | Hosking (1990) |
| Return period | Weibull plotting position, refusing extrapolation beyond the record | — |
| Encounter probability | `1 − (1 − 1/T)ⁿ` | — |
| Hazard class | Depth and depth–velocity product | AR&R (2019) Book 6; FEMA conventions |

Bulletin 17C's Expected Moments Algorithm, low-outlier screening (MGBT) and regional skew mapping
are **not** implemented; results are labelled as simplified at-site analyses and never as regulatory
determinations.

### Water quality

| Method | Implementation | Reference |
| --- | --- | --- |
| Water Quality Index | CCME WQI 1.0 with F1/F2/F3 reported separately | CCME (2001) |
| Trend | Seasonal Mann–Kendall with tie correction; Theil–Sen slope | Hirsch et al. (1982); Sen (1968) |
| Anomalies | Modified z-score (median + MAD) | Iglewicz & Hoaglin (1993) |
| Correlation | Spearman rank on paired samples | — |

### Modelling and evaluation

| Method | Implementation | Reference |
| --- | --- | --- |
| GR4J | Four-parameter daily lumped rainfall-runoff, UH1/UH2 routing, groundwater exchange | Perrin et al. (2003) |
| Calibration | Bounded coordinate descent on KGE or NSE, split-sample with warm-up, full search trace | — |
| NSE | — | Nash & Sutcliffe (1970) |
| KGE | 2009 formulation with r, α, β reported separately | Gupta et al. (2009) |
| PBIAS, performance ratings | — | Moriasi et al. (2007, 2015) |
| Reliability, resilience, vulnerability | Reservoir simulation | Hashimoto et al. (1982) |
| Water balance | `P = Q + ET + ΔS`, residual reported rather than forced | — |

---

## The AI Copilot

```
User question
   ↓
Intent detection ──── language model (if ANTHROPIC_API_KEY is set)
   │                  or deterministic keyword router over the same catalogue
   ↓
Tool selection ────── one source of truth: apps/api/src/copilot/tools.ts
   ↓
Tool execution ────── the only code path that touches data
   ↓
Provenance ────────── one record per tool call, persisted
   ↓
Composition ───────── structured fields derived from provenance,
                      prose written by the model or composed from summaries
```

**The model never supplies the structured fields.** Data used, period, spatial extent, methods,
assumptions, results and uncertainty are all assembled mechanically from provenance records, so the
reasoning layer cannot invent a data source or a method that was not used.

Both engines run the same tools and produce the same numbers. The response says which engine
composed the prose, and the interface shows it.

### Tool catalogue

Thirty-plus tools across streamflow, drought, water quality, flood, forecasting, GIS, modelling,
water supply, water demand and reporting. `GET /api/copilot/tools` returns the catalogue; every
listed tool is executable (asserted by the test suite).

### Guardrails

The system prompt and the composer enforce §25 of the specification. In practice:

- The Copilot declines questions outside the catalogue rather than answering from general knowledge.
- Observations, model output and forecasts are labelled distinctly.
- Units accompany every value; conversions are explicit and dimension-checked.
- Fallbacks are announced with the skill of the model that actually ran.
- Regulatory language is refused: flood results are not FEMA determinations, drought results are not
  US Drought Monitor determinations, screening values are not applicable standards.

---

## Forecasting

Horizons of 1, 3, 7, 14, 30 days and seasonal. Models:

| Model | Where it runs | Notes |
| --- | --- | --- |
| Persistence, climatology, moving average | API | Benchmarks any skilful model must beat |
| Autoregressive (ARIMA-family) | API | Ridge-fitted lag model on log-flow anomalies with precipitation lags |
| Random Forest, XGBoost, LightGBM | Python service | Falls back to `HistGradientBoosting` with a warning if XGBoost is absent |
| LSTM, GRU | Python service | Requires `requirements-deep.txt`; substitution is reported |
| Temporal Fusion Transformer | Scaffolded only | `models/tft.py` documents exactly what a real implementation needs; requests are served by XGBoost **and say so** |

Every forecast reports NSE, KGE, RMSE, MAE, MAPE, R², bias and PBIAS on a **chronologically held-out**
validation period. No shuffled cross-validation is used anywhere: shuffling a hydrologic series leaks
future information and produces skill that cannot be reproduced operationally.

Uncertainty comes from resampling validation residuals through the recursion, producing an ensemble
rather than a single trajectory. The dominant limitation is stated in every response: **no
quantitative precipitation forecast is ingested**, so beyond the last observation the models assume
no further rainfall and exceedance probabilities are lower bounds during an approaching storm.

---

## Model integrations

| Engine | Status | To enable |
| --- | --- | --- |
| **GR4J** | Built in, always available | Nothing |
| HEC-HMS | Adapter implemented, validates inputs | `HEC_HMS_PATH` |
| HEC-RAS 2D | Adapter implemented, validates inputs | `HEC_RAS_PATH` + a project with terrain, mesh, roughness, boundaries |
| SWAT / SWAT+ | Adapter implemented, validates inputs | `SWAT_PATH` / `SWATPLUS_PATH` + a TxtInOut directory |
| MODFLOW 6 | Adapter implemented, validates inputs | `MODFLOW_PATH` |

Every adapter implements the same contract:

```typescript
interface HydrologicModelAdapter {
  available(): Promise<boolean>;
  requirements(): AdapterRequirement[];
  capabilities(): string[];
  validateInput(req: ModelRunRequest): Promise<ValidationResult>;
  runModel(req: ModelRunRequest): Promise<ModelRunResult>;
  retrieveOutput(runId: string): Promise<ModelOutput | null>;
  calculateMetrics(runId: string): Promise<ModelMetrics | null>;
}
```

An unconfigured engine validates the request, reports exactly what is missing, and returns
`status: 'integration_required'` with no output and no metrics. The UI shows the requirement table
and the engine's capability list. Nothing is fabricated.

---

## The demonstration dataset

**Potomac Demonstration Watershed** — 30 years of daily synthetic data, generated by a deterministic
conceptual rainfall-runoff model (stochastic precipitation generator → soil-moisture store → two
linear reservoirs) with a seasonal cycle and multi-year wet/dry oscillations.

| Property | Value |
| --- | --- |
| Area | 24,996 km², 6 subbasins |
| Record | 30 years of daily values, 3 stream gauges, precipitation, temperature, reference and actual ET, soil moisture |
| Water quality | 13 parameters, 3 stations, monthly, with flow-dependent behaviour |
| Reservoir | 380 MCM capacity, monthly storage, inflow, release, spill, evaporation |
| Demand | Municipal, agricultural and industrial, with population growth and weather sensitivity |
| Mean annual precipitation | ≈ 1,140 mm |
| Mean annual runoff | ≈ 480 mm (runoff coefficient ≈ 0.43) |
| Water balance closure | Within 0.5 % of precipitation |

The generator is physically consistent by construction — `P = Q + ET + ΔS` closes without a fudge
term — which is why GR4J calibrates against it to NSE ≈ 0.86 and KGE ≈ 0.93.

**It is not real data.** Every record is flagged `is_synthetic`, every provenance record says so,
every report carries a banner, and the interface shows a badge on every page.

---

## Configuration

See [`.env.example`](.env.example). The design principle: **nothing is required**. Each optional
service that is absent is reported in `/api/status` and `/api/capabilities`, and the features that
depend on it degrade explicitly.

`JWT_SECRET` is the one exception — the API refuses to start in production without it.

---

## Database

PostgreSQL 16 with PostGIS. TimescaleDB is detected at migration time: when present, the observation
tables become hypertables; when absent, they stay plain tables with BRIN time indexes and the
migration says so.

```bash
DATABASE_URL=postgres://hydro:hydro@localhost:5432/hydro npm run db:migrate
DATABASE_URL=postgres://hydro:hydro@localhost:5432/hydro npm run db:seed
```

Schema (in `database/migrations/`, applied in filename order and tracked in
`hydro.schema_migrations`):

```
users · refresh_tokens · projects · project_members
watersheds · subbasins · reaches · stations              (PostGIS geometry, GIST indexes)
streamflow · precipitation · climate · water_quality · groundwater
reservoirs · reservoir_observations · water_supply · water_demand
provenance · drought_indices · forecast_runs · forecasts
model_runs · model_outputs · flood_events · flood_risk · scenarios
datasets · dataset_variables · jobs · reports
ai_conversations · ai_messages · ai_tool_calls
audit_log
```

Every observation table carries an explicit `unit` column and a `quality_flag`. Every derived
product references the `provenance` record that produced it.

---

## API

OpenAPI documentation at **`/docs`**, generated from the route schemas.

```
/api/health                     /api/status                  /api/capabilities
/api/auth/{login,register,refresh,me,demo-credentials}
/api/projects                   /api/projects/:id/scenarios  /api/scenarios
/api/datasets                   /api/datasets/upload         /api/datasets/:id/preview
/api/watersheds                 /api/watersheds/:id/geojson  /api/watersheds/:id/reaches
/api/stations                   /api/series                  /api/gis/{watershed-analysis,query}
/api/streamflow                 /api/streamflow/statistics   /api/streamflow/events
/api/precipitation              /api/water-balance
/api/drought                    /api/drought/index
/api/water-quality              /api/water-quality/raw
/api/flood-risk                 /api/flood-risk/frequency    /api/flood-risk/return-period
/api/forecast/streamflow
/api/water-supply               /api/water-supply/balance    /api/water-demand
/api/reservoirs                 /api/reservoirs/:id/series
/api/models/{adapters,validate,run,runs}
/api/copilot/{chat,analyze,run-tool,route,tools,conversations}
/api/jobs                       /api/reports                 /api/provenance
/ws                             (job, model and Copilot tool progress)
```

Every analytical endpoint returns the same envelope:

```jsonc
{
  "data": {
    "ok": true,
    "summary": "…",                 // prose, traceable to the numbers below
    "data": { },                    // tool-specific structured payload
    "quantities": { "mean": { "value": 383.7, "unit": "m3/s" } },
    "metrics": { "nse": 0.86 },
    "charts": [ /* ChartSpec, including its own caption */ ],
    "maps": [ /* MapSpec */ ],
    "warnings": [ ],
    "provenance": {
      "runId": "…", "inputHash": "…",
      "dataSources": [ ], "methods": [ ], "processingSteps": [ ],
      "temporalCoverage": { }, "spatialExtent": "…",
      "assumptions": [ ], "limitations": [ ], "uncertainty": { }
    }
  }
}
```

---

## GIS

- PostGIS geometry for watersheds, subbasins, reaches, stations and inundation polygons, with GIST
  indexes; GeoJSON is produced in the database by `ST_AsGeoJSON` when configured, and in-process
  otherwise.
- MapLibre GL in the client with layer control, legend, identify, and a scale bar.
- **No basemap by default.** A water-resources map is read for its own layers, and a commercial
  basemap adds an external dependency, an attribution requirement and a network call for no
  analytical gain. Set `VITE_BASEMAP_STYLE` to add one.
- Spatial queries: subbasin summaries, stations within a watershed, bounding box, nearest station.

---

## Testing

```bash
npm test                            # TypeScript: 200+ tests across units, core, API, web
cd services/science && pytest       # Python: metrics and the forecasting pipeline
node scripts/screenshot.mjs         # Playwright: every route, asserting zero console errors
```

| Suite | Coverage |
| --- | --- |
| `packages/units` | Exact conversions (international foot, acre-foot), affine temperature, round-trip stability, cross-dimension refusal |
| `packages/hydrology-core` | Distribution functions against analytic values; NSE/KGE identities; SPI standardisation (mean ≈ 0, sd ≈ 1, expected drought fraction); Wilson–Hilferty against Bulletin 17B tables; GR4J mass balance and parameter monotonicity; reservoir mass conservation; water-balance closure |
| `apps/api` | Full HTTP integration: auth (including refresh-token misuse and timing parity), provenance presence and shape, flood disclaimers, forecast interval nesting, GR4J skill, "integration required" behaviour, Copilot routing and refusal, report content |
| `apps/web` | Chart and provenance component behaviour |
| `services/science` | Metrics matching the TypeScript implementation; no target leakage in features; chronological split; reproducibility; substitution reporting |

The scientific tests assert *behaviour that matters*: that SPI is genuinely standard-normal, that
prediction intervals nest and never go negative, that a fallback is reported, that a short record is
refused. Reference values come from the literature, not from a previous run of this code.

---

## Security

- Argon-grade password hashing (bcrypt, cost 10) and constant-work login regardless of whether the
  account exists.
- JWT access and refresh tokens with distinct types; a refresh token presented as an access token is
  rejected.
- Role-based access control (`viewer` < `analyst` < `modeler` < `admin`) with project-level membership.
- Zod validation on every request body; typed, parameterised SQL throughout — no string-built queries.
- Rate limiting, CORS allowlist, upload size and type validation, path-traversal protection on
  storage writes.
- Strict CSP, `X-Frame-Options: DENY`, `nosniff` and a referrer policy at the edge.
- **No provider credential ever reaches the browser.** The frontend talks only to the API gateway.
- Authorization headers are redacted from logs.
- The demonstration account is disabled automatically in production.

---

## Deployment

**Frontend** — static build, deployable to Vercel, Netlify, S3 + CloudFront or any static host.

**API** — a single bundled `dist/server.cjs` in a non-root container. Runs on AWS ECS/Fargate or App
Runner, Azure Container Apps, Google Cloud Run, Render or Railway.

**Python service** — an independent container, scaled separately from the API. It is stateless and
holds no credentials.

**Database** — Amazon RDS/Aurora PostgreSQL, Azure Database for PostgreSQL or Cloud SQL, each with
PostGIS. TimescaleDB where available.

**Storage** — S3, Azure Blob, GCS or MinIO through the same interface.

Each service scales independently: the API is I/O-bound, the Python service is CPU-bound and the
worker is the one that should scale with analysis volume.

---

## Project structure

```
hydrology-copilot/
├── apps/
│   ├── web/                  React frontend
│   │   └── src/{components,pages,layouts,hooks,services,stores}
│   └── api/                  Node API gateway
│       └── src/
│           ├── routes/       HTTP surface
│           ├── services/     analysis/ · models/ · provenance · profiler · storage
│           ├── copilot/      tools · registry · router · anthropic · orchestrator · composer
│           ├── store/        memory · postgres
│           ├── jobs/         queue
│           ├── demo/         synthetic Potomac generator
│           └── scripts/      migrate · seed
├── services/science/         Python FastAPI service + pytest suite
├── packages/
│   ├── shared-types/         domain types shared by every layer
│   ├── hydrology-core/       scientific reference implementations + tests
│   ├── units/                dimension-checked unit conversion + tests
│   └── config/               environment configuration
├── database/migrations/      SQL, applied in order, tracked
├── infrastructure/docker/    Dockerfiles + nginx
├── docs/                     architecture, science, API, operations
└── scripts/                  dev-api.sh · screenshot.mjs
```

---

## Roadmap

The phases below are what this build does **not** yet do, stated plainly.

| Phase | Work |
| --- | --- |
| Forcing | Ingest USGS NWIS and NOAA/NWS quantitative precipitation forecasts. This is the single change that most improves forecast skill — every forecast currently carries the zero-future-rainfall caveat. |
| Hydraulics | Execute HEC-RAS 2D and replace the illustrative inundation footprint with modelled depth, velocity, arrival time and extent. |
| Engines | Process invocation and output parsing for HEC-HMS, SWAT/SWAT+ and MODFLOW; the adapters and validation already exist. |
| Deep learning | Ship PyTorch in the science image; implement the Temporal Fusion Transformer with known-future covariates and a quantile loss. |
| Spatial | Distributed (gridded) modelling, DEM-based delineation, spatial interpolation of precipitation and water quality. |
| Drought | PDSI with climate-division soil water capacity; seasonal drought outlooks from a climate forecast. |
| Reporting | Native DOCX and PDF export (HTML export and browser printing work today). |
| Platform | SSO/OIDC, per-project audit export, multi-reservoir system optimisation, scheduled analyses. |

---

## Licence and status

Apache-2.0. This is an analytical decision-support platform. Its outputs are model results, not
regulatory determinations, official forecasts, or sealed engineering deliverables.
