-- 002_core.sql
-- Users, projects, access control, and the spatial framework.

SET search_path TO hydro, public;

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT        NOT NULL,
  full_name      TEXT        NOT NULL,
  organization   TEXT,
  password_hash  TEXT        NOT NULL,
  role           TEXT        NOT NULL DEFAULT 'analyst'
                 CHECK (role IN ('admin', 'modeler', 'analyst', 'viewer')),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without depending on the CITEXT extension.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  description           TEXT,
  agency                TEXT,
  unit_system           TEXT        NOT NULL DEFAULT 'SI' CHECK (unit_system IN ('SI', 'US')),
  default_watershed_id  UUID,
  created_by            UUID        NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project-level permissions (§31 of the specification).
CREATE TABLE IF NOT EXISTS project_members (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'analyst'
              CHECK (role IN ('admin', 'modeler', 'analyst', 'viewer')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Spatial framework
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watersheds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT           NOT NULL,
  huc           TEXT,
  area_km2      DOUBLE PRECISION NOT NULL CHECK (area_km2 > 0),
  description   TEXT,
  is_demo       BOOLEAN        NOT NULL DEFAULT FALSE,
  geom          GEOMETRY(MultiPolygon, 4326),
  outlet_point  GEOMETRY(Point, 4326),
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watersheds_geom_gix   ON watersheds USING GIST (geom);
CREATE INDEX IF NOT EXISTS watersheds_outlet_gix ON watersheds USING GIST (outlet_point);
CREATE INDEX IF NOT EXISTS watersheds_project_idx ON watersheds (project_id);

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_default_watershed_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_default_watershed_fkey
  FOREIGN KEY (default_watershed_id) REFERENCES watersheds(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS subbasins (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watershed_id          UUID           NOT NULL REFERENCES watersheds(id) ON DELETE CASCADE,
  name                  TEXT           NOT NULL,
  area_km2              DOUBLE PRECISION NOT NULL CHECK (area_km2 > 0),
  mean_elevation_m      DOUBLE PRECISION,
  mean_slope_pct        DOUBLE PRECISION,
  curve_number          DOUBLE PRECISION CHECK (curve_number IS NULL OR (curve_number BETWEEN 30 AND 100)),
  dominant_land_cover   TEXT,
  downstream_subbasin_id UUID REFERENCES subbasins(id),
  geom                  GEOMETRY(MultiPolygon, 4326),
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subbasins_geom_gix ON subbasins USING GIST (geom);
CREATE INDEX IF NOT EXISTS subbasins_watershed_idx ON subbasins (watershed_id);

CREATE TABLE IF NOT EXISTS reaches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watershed_id  UUID NOT NULL REFERENCES watersheds(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  stream_order  INTEGER,
  length_km     DOUBLE PRECISION,
  slope         DOUBLE PRECISION,
  manning_n     DOUBLE PRECISION,
  geom          GEOMETRY(MultiLineString, 4326)
);
CREATE INDEX IF NOT EXISTS reaches_geom_gix ON reaches USING GIST (geom);

CREATE TABLE IF NOT EXISTS stations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watershed_id        UUID REFERENCES watersheds(id) ON DELETE SET NULL,
  subbasin_id         UUID REFERENCES subbasins(id) ON DELETE SET NULL,
  code                TEXT           NOT NULL,
  name                TEXT           NOT NULL,
  type                TEXT           NOT NULL
                      CHECK (type IN ('streamgage','precipitation','weather','water_quality','groundwater','reservoir','snotel')),
  operator            TEXT,
  elevation_m         DOUBLE PRECISION,
  drainage_area_km2   DOUBLE PRECISION,
  active              BOOLEAN        NOT NULL DEFAULT TRUE,
  is_synthetic        BOOLEAN        NOT NULL DEFAULT FALSE,
  metadata            JSONB          NOT NULL DEFAULT '{}'::jsonb,
  geom                GEOMETRY(Point, 4326) NOT NULL,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),
  UNIQUE (code)
);
CREATE INDEX IF NOT EXISTS stations_geom_gix ON stations USING GIST (geom);
CREATE INDEX IF NOT EXISTS stations_watershed_idx ON stations (watershed_id, type);

-- Audit timestamps kept current automatically.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_touch ON users;
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS projects_touch ON projects;
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
