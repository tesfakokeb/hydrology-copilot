import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  Conversation,
  CopilotMessage,
  Dataset,
  Job,
  ModelRun,
  Project,
  ProvenanceRecord,
  Report,
  Reservoir,
  Scenario,
  Station,
  Subbasin,
  TimeSeries,
  Watershed,
} from '@hydro/shared-types';
import { decimate } from './memory.js';
import type {
  DataAccess,
  DemandRow,
  ReservoirRow,
  SeriesQuery,
  StoredUser,
  WaterQualityQuery,
  WaterQualityRow,
} from './types.js';

const { Pool } = pg;

/** Columns of `climate` that back each climate variable name. */
const CLIMATE_COLUMNS: Record<string, { column: string; unit: string }> = {
  temperature_mean: { column: 'temperature_mean', unit: 'degC' },
  temperature_min: { column: 'temperature_min', unit: 'degC' },
  temperature_max: { column: 'temperature_max', unit: 'degC' },
  et_reference: { column: 'et_reference', unit: 'mm' },
  et_actual: { column: 'et_actual', unit: 'mm' },
  soil_moisture: { column: 'soil_moisture', unit: 'mm' },
  snow_water_equivalent: { column: 'snow_water_equivalent', unit: 'mm' },
};

const iso = (v: Date | string | null): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const day = (v: Date | string | null): string => iso(v).slice(0, 10);

/**
 * PostgreSQL/PostGIS-backed store. Used whenever DATABASE_URL is configured
 * and the connection succeeds; the API falls back to the in-memory store and
 * says so in `/api/status` if it does not.
 */
export class PostgresDataAccess implements DataAccess {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'hydrology-copilot-api',
    });
  }

  private async q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(text, params as never[]);
    return res.rows as T[];
  }

  async init(): Promise<void> {
    await this.q('SET search_path TO hydro, public');
    await this.q('SELECT 1 FROM hydro.users LIMIT 1');
  }

  async healthy(): Promise<boolean> {
    try {
      await this.q('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  private mapUser(r: Record<string, unknown>): StoredUser {
    return {
      id: r.id as string,
      email: r.email as string,
      fullName: r.full_name as string,
      organization: (r.organization as string) ?? null,
      role: r.role as StoredUser['role'],
      createdAt: iso(r.created_at as Date),
      passwordHash: r.password_hash as string,
      isActive: r.is_active as boolean,
    };
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const rows = await this.q('SELECT * FROM hydro.users WHERE lower(email) = lower($1) LIMIT 1', [email]);
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    const rows = await this.q('SELECT * FROM hydro.users WHERE id = $1', [id]);
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async createUser(u: Omit<StoredUser, 'createdAt'>): Promise<StoredUser> {
    const rows = await this.q(
      `INSERT INTO hydro.users (id, email, full_name, organization, password_hash, role, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [u.id, u.email, u.fullName, u.organization, u.passwordHash, u.role, u.isActive],
    );
    return this.mapUser(rows[0]);
  }

  async recordLogin(id: string): Promise<void> {
    await this.q('UPDATE hydro.users SET last_login_at = now() WHERE id = $1', [id]);
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  private mapProject(r: Record<string, unknown>): Project {
    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string) ?? null,
      agency: (r.agency as string) ?? null,
      defaultWatershedId: (r.default_watershed_id as string) ?? null,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at as Date),
      updatedAt: iso(r.updated_at as Date),
      unitSystem: r.unit_system as 'SI' | 'US',
      role: (r.member_role as Project['role']) ?? undefined,
    };
  }

  async listProjects(userId: string): Promise<Project[]> {
    const rows = await this.q(
      `SELECT p.*, COALESCE(m.role, CASE WHEN p.created_by = $1 THEN 'admin' END) AS member_role
         FROM hydro.projects p
         LEFT JOIN hydro.project_members m ON m.project_id = p.id AND m.user_id = $1
        WHERE p.created_by = $1 OR m.user_id IS NOT NULL
        ORDER BY p.updated_at DESC`,
      [userId],
    );
    return rows.map((r) => this.mapProject(r));
  }

  async getProject(id: string, userId: string): Promise<Project | null> {
    const rows = await this.q(
      `SELECT p.*, COALESCE(m.role, CASE WHEN p.created_by = $2 THEN 'admin' END) AS member_role
         FROM hydro.projects p
         LEFT JOIN hydro.project_members m ON m.project_id = p.id AND m.user_id = $2
        WHERE p.id = $1 AND (p.created_by = $2 OR m.user_id IS NOT NULL)`,
      [id, userId],
    );
    return rows[0] ? this.mapProject(rows[0]) : null;
  }

  async createProject(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project> {
    const rows = await this.q(
      `INSERT INTO hydro.projects (name, description, agency, unit_system, default_watershed_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [p.name, p.description, p.agency, p.unitSystem, p.defaultWatershedId, p.createdBy],
    );
    await this.q(
      `INSERT INTO hydro.project_members (project_id, user_id, role) VALUES ($1,$2,'admin')
       ON CONFLICT DO NOTHING`,
      [rows[0].id, p.createdBy],
    );
    return this.mapProject(rows[0]);
  }

  async updateProject(id: string, userId: string, patch: Partial<Project>): Promise<Project | null> {
    const rows = await this.q(
      `UPDATE hydro.projects SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         agency = COALESCE($5, agency),
         unit_system = COALESCE($6, unit_system),
         default_watershed_id = COALESCE($7, default_watershed_id)
       WHERE id = $1 AND created_by = $2 RETURNING *`,
      [id, userId, patch.name ?? null, patch.description ?? null, patch.agency ?? null, patch.unitSystem ?? null, patch.defaultWatershedId ?? null],
    );
    return rows[0] ? this.mapProject(rows[0]) : null;
  }

  async deleteProject(id: string, userId: string): Promise<boolean> {
    const rows = await this.q('DELETE FROM hydro.projects WHERE id = $1 AND created_by = $2 RETURNING id', [id, userId]);
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Spatial
  // -------------------------------------------------------------------------

  async listWatersheds(projectId?: string): Promise<Watershed[]> {
    const rows = await this.q(
      `SELECT id, project_id, name, huc, area_km2, description, is_demo,
              ST_X(outlet_point) AS out_lon, ST_Y(outlet_point) AS out_lat,
              ST_XMin(geom) AS min_lon, ST_YMin(geom) AS min_lat,
              ST_XMax(geom) AS max_lon, ST_YMax(geom) AS max_lat,
              ST_X(ST_Centroid(geom)) AS c_lon, ST_Y(ST_Centroid(geom)) AS c_lat
         FROM hydro.watersheds
        WHERE $1::uuid IS NULL OR project_id = $1::uuid
        ORDER BY name`,
      [projectId ?? null],
    );
    return rows.map((r) => ({
      id: r.id as string,
      projectId: (r.project_id as string) ?? null,
      name: r.name as string,
      huc: (r.huc as string) ?? null,
      areaKm2: Number(r.area_km2),
      outletPoint: r.out_lon === null ? null : { lon: Number(r.out_lon), lat: Number(r.out_lat) },
      bbox: r.min_lon === null ? null : { minLon: Number(r.min_lon), minLat: Number(r.min_lat), maxLon: Number(r.max_lon), maxLat: Number(r.max_lat) },
      centroid: r.c_lon === null ? null : { lon: Number(r.c_lon), lat: Number(r.c_lat) },
      description: (r.description as string) ?? null,
      isDemo: Boolean(r.is_demo),
    }));
  }

  async getWatershed(id: string): Promise<Watershed | null> {
    const all = await this.listWatersheds();
    return all.find((w) => w.id === id) ?? null;
  }

  async listSubbasins(watershedId: string): Promise<Subbasin[]> {
    const rows = await this.q(
      `SELECT id, watershed_id, name, area_km2, mean_elevation_m, mean_slope_pct, curve_number, dominant_land_cover,
              ST_X(ST_Centroid(geom)) AS c_lon, ST_Y(ST_Centroid(geom)) AS c_lat
         FROM hydro.subbasins WHERE watershed_id = $1 ORDER BY name`,
      [watershedId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      watershedId: r.watershed_id as string,
      name: r.name as string,
      areaKm2: Number(r.area_km2),
      meanElevationM: r.mean_elevation_m === null ? null : Number(r.mean_elevation_m),
      meanSlopePct: r.mean_slope_pct === null ? null : Number(r.mean_slope_pct),
      curveNumber: r.curve_number === null ? null : Number(r.curve_number),
      dominantLandCover: (r.dominant_land_cover as string) ?? null,
      centroid: r.c_lon === null ? null : { lon: Number(r.c_lon), lat: Number(r.c_lat) },
    }));
  }

  async listStations(filter?: { watershedId?: string; type?: string }): Promise<Station[]> {
    const rows = await this.q(
      `SELECT id, watershed_id, code, name, type, operator, elevation_m, drainage_area_km2, active, is_synthetic,
              ST_X(geom) AS lon, ST_Y(geom) AS lat
         FROM hydro.stations
        WHERE ($1::uuid IS NULL OR watershed_id = $1::uuid)
          AND ($2::text IS NULL OR type = $2::text)
        ORDER BY type, code`,
      [filter?.watershedId ?? null, filter?.type ?? null],
    );
    return rows.map((r) => ({
      id: r.id as string,
      watershedId: (r.watershed_id as string) ?? null,
      code: r.code as string,
      name: r.name as string,
      type: r.type as Station['type'],
      location: { lon: Number(r.lon), lat: Number(r.lat) },
      elevationM: r.elevation_m === null ? null : Number(r.elevation_m),
      drainageAreaKm2: r.drainage_area_km2 === null ? null : Number(r.drainage_area_km2),
      operator: (r.operator as string) ?? null,
      active: Boolean(r.active),
      isSynthetic: Boolean(r.is_synthetic),
    }));
  }

  async getStation(idOrCode: string): Promise<Station | null> {
    const all = await this.listStations();
    return all.find((s) => s.id === idOrCode || s.code === idOrCode) ?? null;
  }

  async getWatershedGeoJson(watershedId: string): Promise<unknown> {
    const rows = await this.q(
      `SELECT jsonb_build_object(
                'type','FeatureCollection',
                'features', COALESCE(jsonb_agg(f), '[]'::jsonb)
              ) AS fc
         FROM (
           SELECT jsonb_build_object(
                    'type','Feature',
                    'properties', jsonb_build_object('kind','watershed','name',name,'areaKm2',area_km2,'synthetic',is_demo),
                    'geometry', ST_AsGeoJSON(geom)::jsonb) AS f
             FROM hydro.watersheds WHERE id = $1 AND geom IS NOT NULL
           UNION ALL
           SELECT jsonb_build_object(
                    'type','Feature',
                    'properties', jsonb_build_object('kind','subbasin','id',id,'name',name,'areaKm2',area_km2,
                                                    'curveNumber',curve_number,'meanElevationM',mean_elevation_m,
                                                    'meanSlopePct',mean_slope_pct,'landCover',dominant_land_cover),
                    'geometry', ST_AsGeoJSON(geom)::jsonb) AS f
             FROM hydro.subbasins WHERE watershed_id = $1 AND geom IS NOT NULL
         ) t`,
      [watershedId],
    );
    return rows[0]?.fc ?? { type: 'FeatureCollection', features: [] };
  }

  async getReaches(watershedId: string): Promise<unknown> {
    const rows = await this.q(
      `SELECT jsonb_build_object('type','FeatureCollection','features', COALESCE(jsonb_agg(
                jsonb_build_object('type','Feature',
                  'properties', jsonb_build_object('kind','reach','name',name,'streamOrder',stream_order,'lengthKm',length_km),
                  'geometry', ST_AsGeoJSON(geom)::jsonb)), '[]'::jsonb)) AS fc
         FROM hydro.reaches WHERE watershed_id = $1 AND geom IS NOT NULL`,
      [watershedId],
    );
    return rows[0]?.fc ?? { type: 'FeatureCollection', features: [] };
  }

  // -------------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------------

  async getSeries(q: SeriesQuery): Promise<TimeSeries> {
    const station = q.stationId || q.stationCode ? await this.getStation((q.stationId ?? q.stationCode)!) : null;

    let sql: string;
    let unit = 'm3/s';
    const params: unknown[] = [station?.id ?? null, q.start ?? null, q.end ?? null];

    if (q.variable === 'discharge' || q.variable === 'stage') {
      const col = q.variable === 'discharge' ? 'discharge' : 'stage';
      unit = q.variable === 'discharge' ? 'm3/s' : 'm';
      sql = `SELECT ts, ${col} AS v, quality_flag FROM hydro.streamflow
              WHERE ($1::uuid IS NULL OR station_id = $1::uuid)
                AND ($2::date IS NULL OR ts >= $2::date) AND ($3::date IS NULL OR ts <= $3::date)
              ORDER BY ts`;
    } else if (q.variable === 'precipitation') {
      unit = 'mm';
      sql = `SELECT ts, depth AS v, quality_flag FROM hydro.precipitation
              WHERE ($1::uuid IS NULL OR station_id = $1::uuid)
                AND ($2::date IS NULL OR ts >= $2::date) AND ($3::date IS NULL OR ts <= $3::date)
              ORDER BY ts`;
    } else if (CLIMATE_COLUMNS[q.variable]) {
      const c = CLIMATE_COLUMNS[q.variable];
      unit = c.unit;
      sql = `SELECT ts, ${c.column} AS v, quality_flag FROM hydro.climate
              WHERE ($1::uuid IS NULL OR station_id = $1::uuid)
                AND ($2::date IS NULL OR ts >= $2::date) AND ($3::date IS NULL OR ts <= $3::date)
              ORDER BY ts`;
    } else {
      return { variable: q.variable, unit: 'dimensionless', points: [] };
    }

    const rows = await this.q(sql, params);
    const points = rows.map((r) => ({
      t: day(r.ts as Date),
      v: r.v === null ? null : Number(r.v),
      flag: (r.quality_flag as 'approved') ?? 'approved',
    }));

    return {
      variable: q.variable,
      unit: unit as TimeSeries['unit'],
      stationId: station?.id,
      stationName: station?.name,
      points: decimate(points, q.maxPoints),
    };
  }

  async getWaterQuality(q: WaterQualityQuery): Promise<WaterQualityRow[]> {
    const rows = await this.q(
      `SELECT wq.ts, wq.station_id, s.code, wq.parameter, wq.value, wq.unit
         FROM hydro.water_quality wq
         JOIN hydro.stations s ON s.id = wq.station_id
        WHERE ($1::uuid IS NULL OR wq.station_id = $1::uuid)
          AND ($2::uuid IS NULL OR s.watershed_id = $2::uuid)
          AND ($3::date IS NULL OR wq.ts >= $3::date)
          AND ($4::date IS NULL OR wq.ts <= $4::date)
          AND (COALESCE(array_length($5::text[],1),0) = 0 OR wq.parameter = ANY($5::text[]))
        ORDER BY wq.ts`,
      [q.stationId ?? null, q.watershedId ?? null, q.start ?? null, q.end ?? null, q.parameters ?? []],
    );
    return rows.map((r) => ({
      t: day(r.ts as Date),
      stationId: r.station_id as string,
      stationCode: r.code as string,
      parameter: r.parameter as string,
      value: Number(r.value),
      unit: r.unit as string,
    }));
  }

  async listReservoirs(watershedId?: string): Promise<Reservoir[]> {
    const rows = await this.q(
      `SELECT id, watershed_id, name, capacity_mcm, dead_storage_mcm, conservation_pool_mcm, flood_pool_mcm,
              purpose, is_synthetic, ST_X(geom) AS lon, ST_Y(geom) AS lat
         FROM hydro.reservoirs WHERE $1::uuid IS NULL OR watershed_id = $1::uuid ORDER BY name`,
      [watershedId ?? null],
    );
    return rows.map((r) => ({
      id: r.id as string,
      watershedId: r.watershed_id as string,
      name: r.name as string,
      location: { lon: Number(r.lon), lat: Number(r.lat) },
      capacityMcm: Number(r.capacity_mcm),
      deadStorageMcm: Number(r.dead_storage_mcm),
      conservationPoolMcm: r.conservation_pool_mcm === null ? null : Number(r.conservation_pool_mcm),
      floodPoolMcm: r.flood_pool_mcm === null ? null : Number(r.flood_pool_mcm),
      purpose: (r.purpose as string[]) ?? [],
      isSynthetic: Boolean(r.is_synthetic),
    }));
  }

  async getReservoirSeries(reservoirId: string, start?: string, end?: string): Promise<ReservoirRow[]> {
    const rows = await this.q(
      `SELECT ts, storage_mcm, elevation_m, inflow_m3s, release_m3s, spill_m3s, evaporation_mcm
         FROM hydro.reservoir_observations
        WHERE reservoir_id = $1
          AND ($2::date IS NULL OR ts >= $2::date) AND ($3::date IS NULL OR ts <= $3::date)
        ORDER BY ts`,
      [reservoirId, start ?? null, end ?? null],
    );
    return rows.map((r) => ({
      t: day(r.ts as Date),
      storageMcm: Number(r.storage_mcm),
      elevationM: Number(r.elevation_m),
      inflowM3s: Number(r.inflow_m3s),
      releaseM3s: Number(r.release_m3s),
      spillM3s: Number(r.spill_m3s),
      evaporationMcm: Number(r.evaporation_mcm),
    }));
  }

  async getDemand(projectId: string, start?: string, end?: string): Promise<DemandRow[]> {
    const rows = await this.q(
      `SELECT ts, sector, demand, population FROM hydro.water_demand
        WHERE project_id = $1 AND sector <> 'total'
          AND ($2::date IS NULL OR ts >= $2::date) AND ($3::date IS NULL OR ts <= $3::date)
        ORDER BY ts`,
      [projectId, start ?? null, end ?? null],
    );
    return rows.map((r) => ({
      t: day(r.ts as Date),
      sector: r.sector as DemandRow['sector'],
      demandMcm: Number(r.demand),
      population: Number(r.population ?? 0),
    }));
  }

  // -------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------

  private mapDataset(r: Record<string, unknown>): Dataset {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      name: r.name as string,
      description: (r.description as string) ?? null,
      format: r.format as Dataset['format'],
      source: r.source as string,
      sourceUrl: (r.source_url as string) ?? null,
      version: r.version as string,
      storageUri: r.storage_uri as string,
      sizeBytes: Number(r.size_bytes),
      isSynthetic: Boolean(r.is_synthetic),
      uploadedBy: (r.uploaded_by as string) ?? '',
      uploadedAt: iso(r.uploaded_at as Date),
      profile: (r.profile as Dataset['profile']) ?? null,
    };
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    const rows = await this.q('SELECT * FROM hydro.datasets WHERE project_id = $1 ORDER BY uploaded_at DESC', [projectId]);
    return rows.map((r) => this.mapDataset(r));
  }

  async getDataset(id: string): Promise<Dataset | null> {
    const rows = await this.q('SELECT * FROM hydro.datasets WHERE id = $1', [id]);
    return rows[0] ? this.mapDataset(rows[0]) : null;
  }

  async createDataset(d: Omit<Dataset, 'id' | 'uploadedAt'>): Promise<Dataset> {
    const rows = await this.q(
      `INSERT INTO hydro.datasets (project_id, name, description, format, source, source_url, version, storage_uri,
                                   size_bytes, is_synthetic, profile, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [d.projectId, d.name, d.description, d.format, d.source, d.sourceUrl, d.version, d.storageUri, d.sizeBytes, d.isSynthetic, d.profile ? JSON.stringify(d.profile) : null, d.uploadedBy || null],
    );
    return this.mapDataset(rows[0]);
  }

  async deleteDataset(id: string): Promise<boolean> {
    const rows = await this.q('DELETE FROM hydro.datasets WHERE id = $1 AND is_synthetic = FALSE RETURNING id', [id]);
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Copilot
  // -------------------------------------------------------------------------

  async listConversations(userId: string, projectId?: string): Promise<Conversation[]> {
    const rows = await this.q(
      `SELECT c.*, (SELECT count(*) FROM hydro.ai_messages m WHERE m.conversation_id = c.id) AS n
         FROM hydro.ai_conversations c
        WHERE c.user_id = $1 AND ($2::uuid IS NULL OR c.project_id = $2::uuid)
        ORDER BY c.updated_at DESC LIMIT 100`,
      [userId, projectId ?? null],
    );
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      userId: r.user_id as string,
      title: r.title as string,
      createdAt: iso(r.created_at as Date),
      updatedAt: iso(r.updated_at as Date),
      messageCount: Number(r.n),
    }));
  }

  async createConversation(c: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt' | 'messageCount'>): Promise<Conversation> {
    const rows = await this.q(
      'INSERT INTO hydro.ai_conversations (project_id, user_id, title) VALUES ($1,$2,$3) RETURNING *',
      [c.projectId, c.userId, c.title],
    );
    const r = rows[0];
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      userId: r.user_id as string,
      title: r.title as string,
      createdAt: iso(r.created_at as Date),
      updatedAt: iso(r.updated_at as Date),
      messageCount: 0,
    };
  }

  async getConversation(id: string, userId: string): Promise<Conversation | null> {
    const all = await this.listConversations(userId);
    return all.find((c) => c.id === id) ?? null;
  }

  async listMessages(conversationId: string): Promise<CopilotMessage[]> {
    const rows = await this.q(
      'SELECT * FROM hydro.ai_messages WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId],
    );
    const messages: CopilotMessage[] = [];
    for (const r of rows) {
      const tools = await this.q('SELECT * FROM hydro.ai_tool_calls WHERE message_id = $1 ORDER BY started_at', [r.id]);
      messages.push({
        id: r.id as string,
        conversationId: r.conversation_id as string,
        role: r.role as CopilotMessage['role'],
        content: r.content as string,
        createdAt: iso(r.created_at as Date),
        intent: (r.intent as CopilotMessage['intent']) ?? undefined,
        engine: (r.engine as CopilotMessage['engine']) ?? undefined,
        scientific: (r.scientific as CopilotMessage['scientific']) ?? undefined,
        charts: (r.charts as CopilotMessage['charts']) ?? [],
        maps: (r.maps as CopilotMessage['maps']) ?? [],
        warnings: (r.warnings as string[]) ?? [],
        toolCalls: tools.map((t) => ({
          id: t.id as string,
          name: t.tool_name as string,
          category: t.category as never,
          arguments: (t.arguments as Record<string, unknown>) ?? {},
          status: t.status as never,
          startedAt: iso(t.started_at as Date),
          finishedAt: t.finished_at ? iso(t.finished_at as Date) : null,
          durationMs: t.duration_ms === null ? null : Number(t.duration_ms),
          trace: (t.trace as never) ?? [],
          result: (t.result as never) ?? null,
          error: (t.error as string) ?? null,
        })),
      });
    }
    return messages;
  }

  async appendMessage(m: Omit<CopilotMessage, 'id' | 'createdAt'>): Promise<CopilotMessage> {
    const rows = await this.q(
      `INSERT INTO hydro.ai_messages (conversation_id, role, content, intent, engine, scientific, charts, maps, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [
        m.conversationId, m.role, m.content, m.intent ?? null, m.engine ?? null,
        m.scientific ? JSON.stringify(m.scientific) : null,
        JSON.stringify(m.charts ?? []), JSON.stringify(m.maps ?? []), m.warnings ?? [],
      ],
    );
    const id = rows[0].id as string;
    for (const t of m.toolCalls ?? []) {
      await this.q(
        `INSERT INTO hydro.ai_tool_calls (id, message_id, tool_name, category, arguments, status, trace,
                                           result_summary, result, error, duration_ms, started_at, finished_at, provenance_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          t.id, id, t.name, t.category, JSON.stringify(t.arguments), t.status, JSON.stringify(t.trace),
          t.result?.summary ?? null, t.result ? JSON.stringify(t.result) : null, t.error, t.durationMs,
          t.startedAt, t.finishedAt, t.result?.provenance?.id ?? null,
        ],
      );
    }
    await this.q('UPDATE hydro.ai_conversations SET updated_at = now() WHERE id = $1', [m.conversationId]);
    if (m.role === 'user') {
      await this.q(
        `UPDATE hydro.ai_conversations SET title = $2
          WHERE id = $1 AND title = 'New conversation'`,
        [m.conversationId, m.content.slice(0, 72)],
      );
    }
    return { ...m, id, createdAt: iso(rows[0].created_at as Date) } as CopilotMessage;
  }

  // -------------------------------------------------------------------------
  // Analysis artefacts
  // -------------------------------------------------------------------------

  async saveProvenance(p: ProvenanceRecord): Promise<void> {
    await this.q(
      `INSERT INTO hydro.provenance (id, run_id, project_id, user_id, tool_name, tool_version, data_sources,
                                     processing_steps, methods, temporal_start, temporal_end, spatial_extent,
                                     assumptions, limitations, uncertainty, input_hash, software_versions, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.id, p.runId, p.projectId, p.userId, p.toolName, p.toolVersion,
        JSON.stringify(p.dataSources), JSON.stringify(p.processingSteps), JSON.stringify(p.methods),
        p.temporalCoverage?.start ?? null, p.temporalCoverage?.end ?? null, p.spatialExtent,
        p.assumptions, p.limitations, JSON.stringify(p.uncertainty), p.inputHash,
        JSON.stringify(p.softwareVersions), p.createdAt,
      ],
    );
  }

  private mapProvenance(r: Record<string, unknown>): ProvenanceRecord {
    return {
      id: r.id as string,
      runId: r.run_id as string,
      createdAt: iso(r.created_at as Date),
      userId: (r.user_id as string) ?? null,
      projectId: (r.project_id as string) ?? null,
      toolName: r.tool_name as string,
      toolVersion: r.tool_version as string,
      dataSources: (r.data_sources as never) ?? [],
      processingSteps: (r.processing_steps as never) ?? [],
      methods: (r.methods as never) ?? [],
      temporalCoverage: r.temporal_start ? { start: iso(r.temporal_start as Date), end: iso(r.temporal_end as Date) } : null,
      spatialExtent: (r.spatial_extent as string) ?? null,
      assumptions: (r.assumptions as string[]) ?? [],
      limitations: (r.limitations as string[]) ?? [],
      uncertainty: (r.uncertainty as never) ?? { sources: [], interval: null, validationMetrics: null, qualitative: 'not_quantified' },
      inputHash: r.input_hash as string,
      softwareVersions: (r.software_versions as never) ?? {},
    };
  }

  async getProvenance(id: string): Promise<ProvenanceRecord | null> {
    const rows = await this.q('SELECT * FROM hydro.provenance WHERE id = $1', [id]);
    return rows[0] ? this.mapProvenance(rows[0]) : null;
  }

  async listProvenance(projectId: string, limit: number): Promise<ProvenanceRecord[]> {
    const rows = await this.q(
      'SELECT * FROM hydro.provenance WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2',
      [projectId, limit],
    );
    return rows.map((r) => this.mapProvenance(r));
  }

  private mapJob(r: Record<string, unknown>): Job {
    return {
      id: r.id as string,
      kind: r.kind as string,
      projectId: (r.project_id as string) ?? null,
      userId: (r.user_id as string) ?? '',
      status: r.status as Job['status'],
      progress: Number(r.progress),
      message: (r.message as string) ?? null,
      createdAt: iso(r.created_at as Date),
      startedAt: r.started_at ? iso(r.started_at as Date) : null,
      finishedAt: r.finished_at ? iso(r.finished_at as Date) : null,
      outputLocation: (r.output_location as string) ?? null,
      error: (r.error as string) ?? null,
      logs: (r.logs as Job['logs']) ?? [],
    };
  }

  async listJobs(projectId?: string, limit = 50): Promise<Job[]> {
    const rows = await this.q(
      'SELECT * FROM hydro.jobs WHERE $1::uuid IS NULL OR project_id = $1::uuid ORDER BY created_at DESC LIMIT $2',
      [projectId ?? null, limit],
    );
    return rows.map((r) => this.mapJob(r));
  }

  async getJob(id: string): Promise<Job | null> {
    const rows = await this.q('SELECT * FROM hydro.jobs WHERE id = $1', [id]);
    return rows[0] ? this.mapJob(rows[0]) : null;
  }

  async createJob(j: Omit<Job, 'id' | 'createdAt'>): Promise<Job> {
    const rows = await this.q(
      `INSERT INTO hydro.jobs (kind, project_id, user_id, status, progress, message, logs)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [j.kind, j.projectId, j.userId || null, j.status, j.progress, j.message, JSON.stringify(j.logs ?? [])],
    );
    return this.mapJob(rows[0]);
  }

  async updateJob(id: string, patch: Partial<Job>): Promise<Job | null> {
    const rows = await this.q(
      `UPDATE hydro.jobs SET
         status = COALESCE($2, status),
         progress = COALESCE($3, progress),
         message = COALESCE($4, message),
         output_location = COALESCE($5, output_location),
         error = COALESCE($6, error),
         logs = COALESCE($7::jsonb, logs),
         started_at = COALESCE($8, started_at),
         finished_at = COALESCE($9, finished_at)
       WHERE id = $1 RETURNING *`,
      [
        id, patch.status ?? null, patch.progress ?? null, patch.message ?? null,
        patch.outputLocation ?? null, patch.error ?? null,
        patch.logs ? JSON.stringify(patch.logs) : null, patch.startedAt ?? null, patch.finishedAt ?? null,
      ],
    );
    return rows[0] ? this.mapJob(rows[0]) : null;
  }

  private mapModelRun(r: Record<string, unknown>): ModelRun {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      watershedId: (r.watershed_id as string) ?? null,
      engine: r.engine as ModelRun['engine'],
      name: r.name as string,
      status: r.status as ModelRun['status'],
      adapterAvailable: Boolean(r.adapter_available),
      createdBy: (r.created_by as string) ?? '',
      createdAt: iso(r.created_at as Date),
      startedAt: r.started_at ? iso(r.started_at as Date) : null,
      finishedAt: r.finished_at ? iso(r.finished_at as Date) : null,
      parameters: (r.parameters as Record<string, unknown>) ?? {},
      metrics: (r.metrics as ModelRun['metrics']) ?? null,
      outputLocation: (r.output_uri as string) ?? null,
      logs: ((r.logs as string[]) ?? []) as string[],
      message: (r.message as string) ?? null,
    };
  }

  async listModelRuns(projectId: string): Promise<ModelRun[]> {
    const rows = await this.q('SELECT * FROM hydro.model_runs WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    return rows.map((r) => this.mapModelRun(r));
  }

  async getModelRun(id: string): Promise<ModelRun | null> {
    const rows = await this.q('SELECT * FROM hydro.model_runs WHERE id = $1', [id]);
    return rows[0] ? this.mapModelRun(rows[0]) : null;
  }

  async createModelRun(r: Omit<ModelRun, 'id' | 'createdAt'>): Promise<ModelRun> {
    const rows = await this.q(
      `INSERT INTO hydro.model_runs (project_id, watershed_id, engine, name, status, adapter_available,
                                      parameters, metrics, message, logs, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [r.projectId, r.watershedId, r.engine, r.name, r.status, r.adapterAvailable,
       JSON.stringify(r.parameters), r.metrics ? JSON.stringify(r.metrics) : null, r.message,
       JSON.stringify(r.logs), r.createdBy || null],
    );
    return this.mapModelRun(rows[0]);
  }

  async updateModelRun(id: string, patch: Partial<ModelRun>): Promise<ModelRun | null> {
    const rows = await this.q(
      `UPDATE hydro.model_runs SET
         status = COALESCE($2, status),
         metrics = COALESCE($3::jsonb, metrics),
         message = COALESCE($4, message),
         logs = COALESCE($5::jsonb, logs),
         output_uri = COALESCE($6, output_uri),
         started_at = COALESCE($7, started_at),
         finished_at = COALESCE($8, finished_at)
       WHERE id = $1 RETURNING *`,
      [id, patch.status ?? null, patch.metrics ? JSON.stringify(patch.metrics) : null, patch.message ?? null,
       patch.logs ? JSON.stringify(patch.logs) : null, patch.outputLocation ?? null,
       patch.startedAt ?? null, patch.finishedAt ?? null],
    );
    return rows[0] ? this.mapModelRun(rows[0]) : null;
  }

  private mapReport(r: Record<string, unknown>): Report & { contentHtml: string | null } {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      kind: r.kind as Report['kind'],
      title: r.title as string,
      status: r.status as Report['status'],
      formats: (r.formats as Report['formats']) ?? [],
      storageUri: (r.storage_uri as string) ?? null,
      createdBy: (r.created_by as string) ?? '',
      createdAt: iso(r.created_at as Date),
      provenanceId: (r.provenance_id as string) ?? null,
      contentHtml: (r.content_html as string) ?? null,
    };
  }

  async listReports(projectId: string): Promise<Report[]> {
    const rows = await this.q(
      'SELECT id, project_id, kind, title, status, formats, storage_uri, created_by, created_at, provenance_id FROM hydro.reports WHERE project_id = $1 ORDER BY created_at DESC',
      [projectId],
    );
    return rows.map((r) => this.mapReport(r));
  }

  async getReport(id: string) {
    const rows = await this.q('SELECT * FROM hydro.reports WHERE id = $1', [id]);
    return rows[0] ? this.mapReport(rows[0]) : null;
  }

  async createReport(r: Omit<Report, 'id' | 'createdAt'> & { contentHtml?: string }): Promise<Report> {
    const rows = await this.q(
      `INSERT INTO hydro.reports (project_id, kind, title, status, formats, storage_uri, content_html, provenance_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [r.projectId, r.kind, r.title, r.status, r.formats, r.storageUri, r.contentHtml ?? null, r.provenanceId, r.createdBy || null],
    );
    const { contentHtml: _c, ...out } = this.mapReport(rows[0]);
    return out;
  }

  async listScenarios(projectId: string): Promise<Scenario[]> {
    const rows = await this.q('SELECT * FROM hydro.scenarios WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      name: r.name as string,
      kind: r.kind as Scenario['kind'],
      description: (r.description as string) ?? '',
      parameters: (r.parameters as Scenario['parameters']) ?? {},
      createdAt: iso(r.created_at as Date),
    }));
  }

  async createScenario(s: Omit<Scenario, 'id' | 'createdAt'>): Promise<Scenario> {
    const rows = await this.q(
      `INSERT INTO hydro.scenarios (id, project_id, name, kind, description, parameters)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, name) DO UPDATE SET parameters = EXCLUDED.parameters
       RETURNING *`,
      [randomUUID(), s.projectId, s.name, s.kind, s.description, JSON.stringify(s.parameters)],
    );
    const r = rows[0];
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      name: r.name as string,
      kind: r.kind as Scenario['kind'],
      description: (r.description as string) ?? '',
      parameters: (r.parameters as Scenario['parameters']) ?? {},
      createdAt: iso(r.created_at as Date),
    };
  }

  async deleteScenario(id: string): Promise<boolean> {
    const rows = await this.q('DELETE FROM hydro.scenarios WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }
}
