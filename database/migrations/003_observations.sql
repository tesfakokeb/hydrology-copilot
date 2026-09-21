-- 003_observations.sql
-- Observation time series. One table per physical domain, each keyed by
-- (station_id, ts) and each carrying an explicit unit and quality flag so
-- that no value can be read without knowing what it means.

SET search_path TO hydro, public;

CREATE TABLE IF NOT EXISTS streamflow (
  station_id   UUID             NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ      NOT NULL,
  discharge    DOUBLE PRECISION,
  stage        DOUBLE PRECISION,
  unit         TEXT             NOT NULL DEFAULT 'm3/s',
  stage_unit   TEXT             NOT NULL DEFAULT 'm',
  quality_flag TEXT             NOT NULL DEFAULT 'approved'
               CHECK (quality_flag IN ('approved','provisional','estimated','ice_affected','missing','suspect')),
  dataset_id   UUID,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS streamflow_ts_idx ON streamflow USING BRIN (ts);

CREATE TABLE IF NOT EXISTS precipitation (
  station_id   UUID             NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ      NOT NULL,
  depth        DOUBLE PRECISION,
  unit         TEXT             NOT NULL DEFAULT 'mm',
  accumulation_hours INTEGER    NOT NULL DEFAULT 24,
  quality_flag TEXT             NOT NULL DEFAULT 'approved',
  dataset_id   UUID,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS precipitation_ts_idx ON precipitation USING BRIN (ts);

CREATE TABLE IF NOT EXISTS climate (
  station_id       UUID        NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts               TIMESTAMPTZ NOT NULL,
  temperature_mean DOUBLE PRECISION,
  temperature_min  DOUBLE PRECISION,
  temperature_max  DOUBLE PRECISION,
  et_reference     DOUBLE PRECISION,
  et_actual        DOUBLE PRECISION,
  soil_moisture    DOUBLE PRECISION,
  snow_water_equivalent DOUBLE PRECISION,
  temperature_unit TEXT        NOT NULL DEFAULT 'degC',
  et_unit          TEXT        NOT NULL DEFAULT 'mm',
  quality_flag     TEXT        NOT NULL DEFAULT 'approved',
  dataset_id       UUID,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS climate_ts_idx ON climate USING BRIN (ts);

CREATE TABLE IF NOT EXISTS water_quality (
  id           BIGSERIAL PRIMARY KEY,
  station_id   UUID             NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ      NOT NULL,
  parameter    TEXT             NOT NULL
               CHECK (parameter IN ('temperature','ph','dissolved_oxygen','turbidity','conductivity','tds',
                                     'nitrate','phosphate','ammonia','chlorophyll_a','e_coli','tss','toc')),
  value        DOUBLE PRECISION NOT NULL,
  unit         TEXT             NOT NULL,
  detection_limit DOUBLE PRECISION,
  censored     BOOLEAN          NOT NULL DEFAULT FALSE,
  method       TEXT,
  quality_flag TEXT             NOT NULL DEFAULT 'approved',
  dataset_id   UUID,
  UNIQUE (station_id, ts, parameter)
);
CREATE INDEX IF NOT EXISTS water_quality_station_param_ts_idx ON water_quality (station_id, parameter, ts DESC);

CREATE TABLE IF NOT EXISTS groundwater (
  station_id   UUID             NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ      NOT NULL,
  water_level_m DOUBLE PRECISION,
  depth_to_water_m DOUBLE PRECISION,
  quality_flag TEXT             NOT NULL DEFAULT 'approved',
  PRIMARY KEY (station_id, ts)
);

CREATE TABLE IF NOT EXISTS reservoirs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watershed_id          UUID NOT NULL REFERENCES watersheds(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  capacity_mcm          DOUBLE PRECISION NOT NULL CHECK (capacity_mcm > 0),
  dead_storage_mcm      DOUBLE PRECISION NOT NULL DEFAULT 0,
  conservation_pool_mcm DOUBLE PRECISION,
  flood_pool_mcm        DOUBLE PRECISION,
  purpose               TEXT[] NOT NULL DEFAULT '{}',
  is_synthetic          BOOLEAN NOT NULL DEFAULT FALSE,
  geom                  GEOMETRY(Point, 4326) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservoirs_geom_gix ON reservoirs USING GIST (geom);

CREATE TABLE IF NOT EXISTS reservoir_observations (
  reservoir_id UUID             NOT NULL REFERENCES reservoirs(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ      NOT NULL,
  storage_mcm  DOUBLE PRECISION,
  elevation_m  DOUBLE PRECISION,
  inflow_m3s   DOUBLE PRECISION,
  release_m3s  DOUBLE PRECISION,
  spill_m3s    DOUBLE PRECISION,
  evaporation_mcm DOUBLE PRECISION,
  quality_flag TEXT             NOT NULL DEFAULT 'approved',
  PRIMARY KEY (reservoir_id, ts)
);
CREATE INDEX IF NOT EXISTS reservoir_obs_ts_idx ON reservoir_observations USING BRIN (ts);

CREATE TABLE IF NOT EXISTS water_demand (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  watershed_id  UUID REFERENCES watersheds(id) ON DELETE SET NULL,
  ts            TIMESTAMPTZ NOT NULL,
  sector        TEXT        NOT NULL CHECK (sector IN ('municipal','agricultural','industrial','total')),
  demand        DOUBLE PRECISION NOT NULL,
  unit          TEXT        NOT NULL DEFAULT 'MCM',
  population    INTEGER,
  is_synthetic  BOOLEAN     NOT NULL DEFAULT FALSE,
  UNIQUE (project_id, ts, sector)
);
CREATE INDEX IF NOT EXISTS water_demand_ts_idx ON water_demand (project_id, sector, ts DESC);

CREATE TABLE IF NOT EXISTS water_supply (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reservoir_id  UUID REFERENCES reservoirs(id) ON DELETE SET NULL,
  ts            TIMESTAMPTZ NOT NULL,
  source        TEXT        NOT NULL CHECK (source IN ('surface','groundwater','transfer','reuse')),
  available     DOUBLE PRECISION NOT NULL,
  unit          TEXT        NOT NULL DEFAULT 'MCM',
  scenario      TEXT        NOT NULL DEFAULT 'baseline',
  is_synthetic  BOOLEAN     NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS water_supply_ts_idx ON water_supply (project_id, scenario, ts DESC);

-- Convert to TimescaleDB hypertables when the extension is present.
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    FOREACH t IN ARRAY ARRAY['streamflow','precipitation','climate','reservoir_observations'] LOOP
      BEGIN
        EXECUTE format(
          'SELECT create_hypertable(''hydro.%I'', ''ts'', chunk_time_interval => INTERVAL ''1 year'', if_not_exists => TRUE, migrate_data => TRUE)', t);
        RAISE NOTICE 'Converted hydro.% to a hypertable.', t;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not convert hydro.% to a hypertable: %', t, SQLERRM;
      END;
    END LOOP;
  END IF;
END
$$;
