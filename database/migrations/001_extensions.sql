-- 001_extensions.sql
-- Spatial and time-series extensions.
--
-- PostGIS is required. TimescaleDB is optional: the observation tables are
-- created as ordinary tables with (station_id, ts) primary keys and are
-- converted to hypertables only when the extension is present, so the schema
-- works on any managed PostgreSQL that offers PostGIS.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    RAISE NOTICE 'TimescaleDB enabled: observation tables will be hypertables.';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TimescaleDB not available (%). Observation tables will be plain tables with B-tree/BRIN indexes.', SQLERRM;
  END;
END
$$;

CREATE SCHEMA IF NOT EXISTS hydro;
SET search_path TO hydro, public;
