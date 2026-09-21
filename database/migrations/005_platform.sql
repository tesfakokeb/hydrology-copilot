-- 005_platform.sql
-- Datasets, jobs, reports, Copilot conversations and the audit log.

SET search_path TO hydro, public;

CREATE TABLE IF NOT EXISTS datasets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  description   TEXT,
  format        TEXT        NOT NULL
                CHECK (format IN ('csv','xlsx','netcdf','geotiff','geojson','shapefile','parquet','json')),
  source        TEXT        NOT NULL,
  source_url    TEXT,
  version       TEXT        NOT NULL DEFAULT '1',
  storage_uri   TEXT        NOT NULL,
  checksum      TEXT,
  size_bytes    BIGINT      NOT NULL DEFAULT 0,
  is_synthetic  BOOLEAN     NOT NULL DEFAULT FALSE,
  profile       JSONB,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS datasets_project_idx ON datasets (project_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS dataset_variables (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (role IN ('time','latitude','longitude','station_id','value','flag','unknown')),
  dtype          TEXT NOT NULL,
  unit           TEXT,
  missing_count  BIGINT NOT NULL DEFAULT 0,
  missing_pct    DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_value      DOUBLE PRECISION,
  max_value      DOUBLE PRECISION,
  mean_value     DOUBLE PRECISION,
  stddev_value   DOUBLE PRECISION,
  outlier_count  BIGINT NOT NULL DEFAULT 0,
  distinct_count BIGINT,
  UNIQUE (dataset_id, name)
);

CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT        NOT NULL,
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','completed','failed','cancelled')),
  progress        INTEGER     NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message         TEXT,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result          JSONB,
  output_location TEXT,
  error           TEXT,
  logs            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  queue_job_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL
                CHECK (kind IN ('hydrology_assessment','drought_assessment','flood_risk',
                                'water_quality','water_supply_planning','water_demand_forecast')),
  title         TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'generating'
                CHECK (status IN ('generating','ready','failed')),
  formats       TEXT[]      NOT NULL DEFAULT '{}',
  storage_uri   TEXT,
  content_html  TEXT,
  parameters    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  provenance_id UUID REFERENCES provenance(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_project_idx ON reports (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Copilot
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL DEFAULT 'New conversation',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_conversations_user_idx ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT        NOT NULL,
  intent          TEXT,
  engine          TEXT,
  scientific      JSONB,
  charts          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  maps            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  warnings        TEXT[]      NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_tool_calls (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID        NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  tool_name      TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  arguments      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT        NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  trace          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  result_summary TEXT,
  result         JSONB,
  error          TEXT,
  duration_ms    INTEGER,
  provenance_id  UUID REFERENCES provenance(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_tool_calls_message_idx ON ai_tool_calls (message_id);
CREATE INDEX IF NOT EXISTS ai_tool_calls_tool_idx ON ai_tool_calls (tool_name, started_at DESC);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  entity      TEXT        NOT NULL,
  entity_id   TEXT,
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

DROP TRIGGER IF EXISTS ai_conversations_touch ON ai_conversations;
CREATE TRIGGER ai_conversations_touch BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
