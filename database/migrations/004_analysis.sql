-- 004_analysis.sql
-- Derived analytical products: drought indices, forecasts, model runs,
-- flood analyses and scenarios. Every derived product references the
-- provenance record that explains how it was produced.

SET search_path TO hydro, public;

CREATE TABLE IF NOT EXISTS provenance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID        NOT NULL,
  project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  tool_name         TEXT        NOT NULL,
  tool_version      TEXT        NOT NULL,
  data_sources      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  processing_steps  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  methods           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  temporal_start    TIMESTAMPTZ,
  temporal_end      TIMESTAMPTZ,
  spatial_extent    TEXT,
  assumptions       TEXT[]      NOT NULL DEFAULT '{}',
  limitations       TEXT[]      NOT NULL DEFAULT '{}',
  uncertainty       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  input_hash        TEXT        NOT NULL,
  software_versions JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provenance_run_idx ON provenance (run_id);
CREATE INDEX IF NOT EXISTS provenance_project_created_idx ON provenance (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS drought_indices (
  id             BIGSERIAL PRIMARY KEY,
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  watershed_id   UUID REFERENCES watersheds(id) ON DELETE CASCADE,
  station_id     UUID REFERENCES stations(id) ON DELETE CASCADE,
  index_name     TEXT        NOT NULL CHECK (index_name IN ('SPI','SPEI','PDSI','SSI','PNI')),
  timescale_months INTEGER   NOT NULL CHECK (timescale_months > 0),
  month          DATE        NOT NULL,
  value          DOUBLE PRECISION,
  category       TEXT,
  distribution   TEXT        NOT NULL,
  calibration_start DATE     NOT NULL,
  calibration_end   DATE     NOT NULL,
  provenance_id  UUID REFERENCES provenance(id) ON DELETE SET NULL,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (watershed_id, station_id, index_name, timescale_months, month)
);
CREATE INDEX IF NOT EXISTS drought_indices_lookup_idx
  ON drought_indices (watershed_id, index_name, timescale_months, month DESC);

CREATE TABLE IF NOT EXISTS forecast_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  station_id       UUID REFERENCES stations(id) ON DELETE SET NULL,
  watershed_id     UUID REFERENCES watersheds(id) ON DELETE SET NULL,
  variable         TEXT        NOT NULL,
  unit             TEXT        NOT NULL,
  model            TEXT        NOT NULL,
  horizon_days     INTEGER     NOT NULL CHECK (horizon_days > 0),
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  training_start   DATE,
  training_end     DATE,
  validation_start DATE,
  validation_end   DATE,
  metrics          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  feature_importance JSONB     NOT NULL DEFAULT '[]'::jsonb,
  limitations      TEXT[]      NOT NULL DEFAULT '{}',
  provenance_id    UUID REFERENCES provenance(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS forecast_runs_project_issued_idx ON forecast_runs (project_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS forecasts (
  forecast_run_id UUID        NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL,
  lead_days       INTEGER     NOT NULL,
  mean            DOUBLE PRECISION NOT NULL,
  lower_80        DOUBLE PRECISION,
  upper_80        DOUBLE PRECISION,
  lower_95        DOUBLE PRECISION,
  upper_95        DOUBLE PRECISION,
  ensemble        DOUBLE PRECISION[],
  PRIMARY KEY (forecast_run_id, ts)
);

CREATE TABLE IF NOT EXISTS model_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  watershed_id   UUID REFERENCES watersheds(id) ON DELETE SET NULL,
  engine         TEXT        NOT NULL
                 CHECK (engine IN ('HEC-HMS','HEC-RAS','SWAT','SWAT+','MODFLOW','PYTHON-CUSTOM','GR4J')),
  name           TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','validating','running','completed','failed','cancelled')),
  adapter_available BOOLEAN  NOT NULL DEFAULT FALSE,
  parameters     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  metrics        JSONB,
  input_uri      TEXT,
  output_uri     TEXT,
  message        TEXT,
  logs           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  provenance_id  UUID REFERENCES provenance(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS model_runs_project_created_idx ON model_runs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_outputs (
  id           BIGSERIAL PRIMARY KEY,
  model_run_id UUID        NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
  series_name  TEXT        NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  value        DOUBLE PRECISION,
  unit         TEXT        NOT NULL,
  UNIQUE (model_run_id, series_name, ts)
);

CREATE TABLE IF NOT EXISTS flood_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watershed_id  UUID REFERENCES watersheds(id) ON DELETE CASCADE,
  station_id    UUID REFERENCES stations(id) ON DELETE SET NULL,
  start_ts      TIMESTAMPTZ NOT NULL,
  end_ts        TIMESTAMPTZ NOT NULL,
  peak_discharge DOUBLE PRECISION,
  peak_ts       TIMESTAMPTZ,
  unit          TEXT        NOT NULL DEFAULT 'm3/s',
  return_period_years DOUBLE PRECISION,
  volume_m3     DOUBLE PRECISION,
  source        TEXT        NOT NULL DEFAULT 'detected',
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS flood_events_watershed_idx ON flood_events (watershed_id, start_ts DESC);

CREATE TABLE IF NOT EXISTS flood_risk (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  watershed_id   UUID REFERENCES watersheds(id) ON DELETE CASCADE,
  as_of          TIMESTAMPTZ NOT NULL DEFAULT now(),
  scenario       TEXT NOT NULL DEFAULT 'baseline',
  return_period_years DOUBLE PRECISION,
  hazard_class   TEXT CHECK (hazard_class IN ('low','moderate','high','extreme')),
  inundation_area_km2 DOUBLE PRECISION,
  population_at_risk INTEGER,
  max_depth_m    DOUBLE PRECISION,
  max_velocity_ms DOUBLE PRECISION,
  inundation_geom GEOMETRY(MultiPolygon, 4326),
  provenance_id  UUID REFERENCES provenance(id) ON DELETE SET NULL,
  disclaimers    TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS flood_risk_geom_gix ON flood_risk USING GIST (inundation_geom);

CREATE TABLE IF NOT EXISTS scenarios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT,
  parameters  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
