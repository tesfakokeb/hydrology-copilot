import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DEMO_USER } from '@hydro/config';
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
import { buildDemoWatershed, DEMO_DISCLAIMER, DEMO_IDS, type DemoDataset } from '../demo/potomac.js';
import type {
  DataAccess,
  DemandRow,
  ReservoirRow,
  SeriesQuery,
  StoredUser,
  WaterQualityQuery,
  WaterQualityRow,
} from './types.js';

/**
 * In-memory store seeded with the synthetic Potomac Demonstration Watershed.
 *
 * This is the default backend: it makes the platform fully functional with no
 * external services, which is what lets `npm run dev` produce a working
 * scientific application on a clean machine. It is not durable — entities
 * created here are lost when the process exits, and the API reports
 * `database: not_configured` so no one mistakes it for persistence.
 */
export class MemoryDataAccess implements DataAccess {
  readonly kind = 'memory' as const;

  demo!: DemoDataset;
  private users = new Map<string, StoredUser>();
  private projects = new Map<string, Project>();
  private datasets = new Map<string, Dataset>();
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, CopilotMessage[]>();
  private provenance = new Map<string, ProvenanceRecord>();
  private jobs = new Map<string, Job>();
  private modelRuns = new Map<string, ModelRun>();
  private reports = new Map<string, Report & { contentHtml: string | null }>();
  private scenarios = new Map<string, Scenario>();

  private seriesIndex = new Map<string, number>();

  async init(): Promise<void> {
    this.demo = buildDemoWatershed(30);
    this.demo.daily.dates.forEach((d, i) => this.seriesIndex.set(d, i));

    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(DEMO_USER.password, 10);
    this.users.set(DEMO_USER.id, {
      id: DEMO_USER.id,
      email: DEMO_USER.email,
      fullName: DEMO_USER.fullName,
      organization: DEMO_USER.organization,
      role: DEMO_USER.role,
      createdAt: now,
      passwordHash,
      isActive: true,
    });

    this.projects.set(DEMO_IDS.project, {
      id: DEMO_IDS.project,
      name: 'Potomac Demonstration Project',
      description:
        'Pre-loaded demonstration project exercising every analytical module of Hydrology Copilot against synthetic data.',
      agency: 'Hydrology Copilot Demo',
      defaultWatershedId: DEMO_IDS.watershed,
      createdBy: DEMO_USER.id,
      createdAt: now,
      updatedAt: now,
      unitSystem: 'SI',
    });

    // Register the synthetic series as inspectable datasets.
    const d = this.demo;
    const cover = { start: d.daily.dates[0], end: d.daily.dates[d.daily.dates.length - 1] };
    const mk = (name: string, description: string, rows: number, suffix: string): Dataset => ({
      id: `demo-${suffix}`,
      projectId: DEMO_IDS.project,
      name,
      description,
      format: 'csv',
      source: 'Hydrology Copilot synthetic generator v1.0.0',
      sourceUrl: null,
      version: '1.0.0',
      storageUri: `memory://demo/${suffix}.csv`,
      sizeBytes: rows * 48,
      isSynthetic: true,
      uploadedBy: DEMO_USER.id,
      uploadedAt: now,
      profile: null,
    });

    for (const ds of [
      mk('Daily streamflow — Potomac demo network', `Daily mean discharge at 3 synthetic gauges, ${cover.start} to ${cover.end}.`, d.daily.dates.length * 3, 'streamflow'),
      mk('Daily precipitation — basin average', `Basin-average daily precipitation depth, ${cover.start} to ${cover.end}.`, d.daily.dates.length, 'precipitation'),
      mk('Daily climate — temperature and ET', 'Daily Tmax/Tmin/Tmean, Hargreaves reference ET and modelled actual ET.', d.daily.dates.length, 'climate'),
      mk('Water quality — 3 stations, 13 parameters', 'Monthly synthetic water-quality samples with flow-dependent behaviour.', d.waterQuality.length, 'water-quality'),
      mk('Reservoir operations — Catoctin demo', 'Monthly storage, inflow, release, spill and evaporation.', d.reservoir.monthly.length, 'reservoir'),
      mk('Water demand — municipal, agricultural, industrial', 'Monthly sectoral demand with population growth and weather sensitivity.', d.demand.length, 'demand'),
    ]) {
      this.datasets.set(ds.id, ds);
    }
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    for (const u of this.users.values()) if (u.email.toLowerCase() === email.toLowerCase()) return u;
    return null;
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(u: Omit<StoredUser, 'createdAt'>): Promise<StoredUser> {
    const user: StoredUser = { ...u, createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    return user;
  }

  async recordLogin(): Promise<void> {}

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(userId: string): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((p) => p.createdBy === userId || p.id === DEMO_IDS.project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async createProject(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = { ...p, id: randomUUID(), createdAt: now, updatedAt: now };
    this.projects.set(project.id, project);
    return project;
  }

  async updateProject(id: string, _userId: string, patch: Partial<Project>): Promise<Project | null> {
    const p = this.projects.get(id);
    if (!p) return null;
    const next = { ...p, ...patch, id: p.id, updatedAt: new Date().toISOString() };
    this.projects.set(id, next);
    return next;
  }

  async deleteProject(id: string): Promise<boolean> {
    if (id === DEMO_IDS.project) return false;
    return this.projects.delete(id);
  }

  // -------------------------------------------------------------------------
  // Spatial
  // -------------------------------------------------------------------------

  async listWatersheds(): Promise<Watershed[]> {
    const w = this.demo.watershed;
    return [
      {
        id: w.id,
        projectId: DEMO_IDS.project,
        name: w.name,
        huc: w.huc,
        areaKm2: w.areaKm2,
        outletPoint: w.outlet,
        bbox: w.bbox,
        centroid: w.centroid,
        description: w.description,
        isDemo: true,
      },
    ];
  }

  async getWatershed(id: string): Promise<Watershed | null> {
    const all = await this.listWatersheds();
    return all.find((w) => w.id === id) ?? all[0] ?? null;
  }

  async listSubbasins(): Promise<Subbasin[]> {
    return this.demo.subbasins.map((s) => ({
      id: s.id,
      watershedId: this.demo.watershed.id,
      name: s.name,
      areaKm2: s.areaKm2,
      meanElevationM: s.meanElevationM,
      meanSlopePct: s.meanSlopePct,
      curveNumber: s.curveNumber,
      dominantLandCover: s.dominantLandCover,
      centroid: s.centroid,
    }));
  }

  async listStations(filter?: { watershedId?: string; type?: string }): Promise<Station[]> {
    return this.demo.stations
      .filter((s) => !filter?.type || s.type === filter.type)
      .map((s) => ({
        id: s.id,
        watershedId: this.demo.watershed.id,
        code: s.code,
        name: s.name,
        type: s.type,
        location: { lon: s.lon, lat: s.lat },
        elevationM: s.elevationM,
        drainageAreaKm2: s.drainageAreaKm2,
        operator: s.operator,
        active: true,
        isSynthetic: true,
      }));
  }

  async getStation(idOrCode: string): Promise<Station | null> {
    const all = await this.listStations();
    return all.find((s) => s.id === idOrCode || s.code === idOrCode) ?? null;
  }

  async getWatershedGeoJson(): Promise<unknown> {
    const d = this.demo;
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { kind: 'watershed', name: d.watershed.name, areaKm2: d.watershed.areaKm2, synthetic: true },
          geometry: { type: 'Polygon', coordinates: [d.watershed.polygon] },
        },
        ...d.subbasins.map((s) => ({
          type: 'Feature' as const,
          properties: {
            kind: 'subbasin',
            id: s.id,
            name: s.name,
            areaKm2: s.areaKm2,
            curveNumber: s.curveNumber,
            meanElevationM: s.meanElevationM,
            meanSlopePct: s.meanSlopePct,
            landCover: s.dominantLandCover,
            synthetic: true,
          },
          geometry: { type: 'Polygon' as const, coordinates: [s.polygon] },
        })),
      ],
    };
  }

  async getReaches(): Promise<unknown> {
    return {
      type: 'FeatureCollection',
      features: this.demo.reaches.map((r) => ({
        type: 'Feature' as const,
        properties: { kind: 'reach', name: r.name, streamOrder: r.streamOrder, lengthKm: r.lengthKm, synthetic: true },
        geometry: { type: 'LineString' as const, coordinates: r.line },
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------------

  async getSeries(q: SeriesQuery): Promise<TimeSeries> {
    const d = this.demo.daily;
    const station = q.stationId || q.stationCode ? await this.getStation((q.stationId ?? q.stationCode)!) : null;

    let values: number[];
    let unit = 'm3/s';
    switch (q.variable) {
      case 'discharge':
        values = station && d.byGage[station.code] ? d.byGage[station.code] : d.dischargeM3s;
        unit = 'm3/s';
        break;
      case 'stage':
        values = d.stageM;
        unit = 'm';
        break;
      case 'precipitation':
        values = d.precipMm;
        unit = 'mm';
        break;
      case 'temperature_mean':
        values = d.tmeanC;
        unit = 'degC';
        break;
      case 'temperature_max':
        values = d.tmaxC;
        unit = 'degC';
        break;
      case 'temperature_min':
        values = d.tminC;
        unit = 'degC';
        break;
      case 'et_reference':
        values = d.petMm;
        unit = 'mm';
        break;
      case 'et_actual':
        values = d.aetMm;
        unit = 'mm';
        break;
      case 'soil_moisture':
        values = d.soilMoistureMm;
        unit = 'mm';
        break;
      default:
        return { variable: q.variable, unit: 'dimensionless', points: [] };
    }

    const from = q.start ? this.indexAtOrAfter(q.start) : 0;
    const to = q.end ? this.indexAtOrBefore(q.end) : d.dates.length - 1;
    const points = [];
    for (let i = from; i <= to; i++) points.push({ t: d.dates[i], v: values[i], flag: 'approved' as const });

    return {
      variable: q.variable,
      unit: unit as TimeSeries['unit'],
      stationId: station?.id,
      stationName: station?.name,
      points: decimate(points, q.maxPoints),
    };
  }

  private indexAtOrAfter(date: string): number {
    const d = this.demo.daily.dates;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid] < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexAtOrBefore(date: string): number {
    const d = this.demo.daily.dates;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d[mid] > date) hi = mid - 1;
      else lo = mid;
    }
    return lo;
  }

  async getWaterQuality(q: WaterQualityQuery): Promise<WaterQualityRow[]> {
    const stationById = new Map(this.demo.stations.map((s) => [s.code, s]));
    return this.demo.waterQuality
      .filter((r) => !q.start || r.t >= q.start)
      .filter((r) => !q.end || r.t <= q.end)
      .filter((r) => !q.parameters || q.parameters.length === 0 || q.parameters.includes(r.parameter))
      .filter((r) => {
        if (!q.stationId) return true;
        const st = stationById.get(r.stationCode);
        return st?.id === q.stationId || st?.code === q.stationId;
      })
      .map((r) => ({
        t: r.t,
        stationId: stationById.get(r.stationCode)?.id ?? r.stationCode,
        stationCode: r.stationCode,
        parameter: r.parameter,
        value: r.value,
        unit: r.unit,
      }));
  }

  async listReservoirs(): Promise<Reservoir[]> {
    const r = this.demo.reservoir;
    return [
      {
        id: r.id,
        watershedId: this.demo.watershed.id,
        name: r.name,
        location: { lon: r.lon, lat: r.lat },
        capacityMcm: r.capacityMcm,
        deadStorageMcm: r.deadStorageMcm,
        conservationPoolMcm: r.conservationPoolMcm,
        floodPoolMcm: r.floodPoolMcm,
        purpose: r.purpose,
        isSynthetic: true,
      },
    ];
  }

  async getReservoirSeries(_id: string, start?: string, end?: string): Promise<ReservoirRow[]> {
    return this.demo.reservoir.monthly
      .filter((m) => (!start || m.t >= start) && (!end || m.t <= end))
      .map((m) => ({ ...m }));
  }

  async getDemand(_projectId: string, start?: string, end?: string): Promise<DemandRow[]> {
    return this.demo.demand.filter((r) => (!start || r.t >= start) && (!end || r.t <= end)).map((r) => ({ ...r }));
  }

  // -------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------

  async listDatasets(projectId: string): Promise<Dataset[]> {
    return [...this.datasets.values()].filter((d) => d.projectId === projectId);
  }

  async getDataset(id: string): Promise<Dataset | null> {
    return this.datasets.get(id) ?? null;
  }

  async createDataset(d: Omit<Dataset, 'id' | 'uploadedAt'>): Promise<Dataset> {
    const ds: Dataset = { ...d, id: randomUUID(), uploadedAt: new Date().toISOString() };
    this.datasets.set(ds.id, ds);
    return ds;
  }

  async deleteDataset(id: string): Promise<boolean> {
    if (id.startsWith('demo-')) return false;
    return this.datasets.delete(id);
  }

  // -------------------------------------------------------------------------
  // Copilot
  // -------------------------------------------------------------------------

  async listConversations(userId: string, projectId?: string): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter((c) => c.userId === userId && (!projectId || c.projectId === projectId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createConversation(c: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt' | 'messageCount'>): Promise<Conversation> {
    const now = new Date().toISOString();
    const conv: Conversation = { ...c, id: randomUUID(), createdAt: now, updatedAt: now, messageCount: 0 };
    this.conversations.set(conv.id, conv);
    this.messages.set(conv.id, []);
    return conv;
  }

  async getConversation(id: string, userId: string): Promise<Conversation | null> {
    const c = this.conversations.get(id);
    return c && c.userId === userId ? c : null;
  }

  async listMessages(conversationId: string): Promise<CopilotMessage[]> {
    return this.messages.get(conversationId) ?? [];
  }

  async appendMessage(m: Omit<CopilotMessage, 'id' | 'createdAt'>): Promise<CopilotMessage> {
    const msg: CopilotMessage = { ...m, id: randomUUID(), createdAt: new Date().toISOString() };
    const list = this.messages.get(m.conversationId) ?? [];
    list.push(msg);
    this.messages.set(m.conversationId, list);
    const conv = this.conversations.get(m.conversationId);
    if (conv) {
      conv.messageCount = list.length;
      conv.updatedAt = msg.createdAt;
      if (conv.title === 'New conversation' && m.role === 'user') {
        conv.title = m.content.slice(0, 72);
      }
    }
    return msg;
  }

  // -------------------------------------------------------------------------
  // Analysis artefacts
  // -------------------------------------------------------------------------

  async saveProvenance(p: ProvenanceRecord): Promise<void> {
    this.provenance.set(p.id, p);
  }

  async getProvenance(id: string): Promise<ProvenanceRecord | null> {
    return this.provenance.get(id) ?? null;
  }

  async listProvenance(projectId: string, limit: number): Promise<ProvenanceRecord[]> {
    return [...this.provenance.values()]
      .filter((p) => !projectId || p.projectId === projectId || p.projectId === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listJobs(projectId?: string, limit = 50): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((j) => !projectId || j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getJob(id: string): Promise<Job | null> {
    return this.jobs.get(id) ?? null;
  }

  async createJob(j: Omit<Job, 'id' | 'createdAt'>): Promise<Job> {
    const job: Job = { ...j, id: randomUUID(), createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    return job;
  }

  async updateJob(id: string, patch: Partial<Job>): Promise<Job | null> {
    const j = this.jobs.get(id);
    if (!j) return null;
    const next = { ...j, ...patch, id: j.id };
    this.jobs.set(id, next);
    return next;
  }

  async listModelRuns(projectId: string): Promise<ModelRun[]> {
    return [...this.modelRuns.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getModelRun(id: string): Promise<ModelRun | null> {
    return this.modelRuns.get(id) ?? null;
  }

  async createModelRun(r: Omit<ModelRun, 'id' | 'createdAt'>): Promise<ModelRun> {
    const run: ModelRun = { ...r, id: randomUUID(), createdAt: new Date().toISOString() };
    this.modelRuns.set(run.id, run);
    return run;
  }

  async updateModelRun(id: string, patch: Partial<ModelRun>): Promise<ModelRun | null> {
    const r = this.modelRuns.get(id);
    if (!r) return null;
    const next = { ...r, ...patch, id: r.id };
    this.modelRuns.set(id, next);
    return next;
  }

  async listReports(projectId: string): Promise<Report[]> {
    return [...this.reports.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ contentHtml: _c, ...r }) => r);
  }

  async getReport(id: string) {
    return this.reports.get(id) ?? null;
  }

  async createReport(r: Omit<Report, 'id' | 'createdAt'> & { contentHtml?: string }): Promise<Report> {
    const { contentHtml, ...rest } = r;
    const report = { ...rest, id: randomUUID(), createdAt: new Date().toISOString(), contentHtml: contentHtml ?? null };
    this.reports.set(report.id, report);
    const { contentHtml: _c, ...out } = report;
    return out;
  }

  async listScenarios(projectId: string): Promise<Scenario[]> {
    return [...this.scenarios.values()].filter((s) => s.projectId === projectId);
  }

  async createScenario(s: Omit<Scenario, 'id' | 'createdAt'>): Promise<Scenario> {
    const sc: Scenario = { ...s, id: randomUUID(), createdAt: new Date().toISOString() };
    this.scenarios.set(sc.id, sc);
    return sc;
  }

  async deleteScenario(id: string): Promise<boolean> {
    return this.scenarios.delete(id);
  }

  get disclaimer(): string {
    return DEMO_DISCLAIMER;
  }
}

/**
 * Reduce a series to at most `maxPoints` by min/max-preserving decimation, so
 * that peaks and troughs survive. Never truncates the record — a truncated
 * hydrograph would misrepresent the period of analysis.
 */
export function decimate<T extends { t: string; v: number | null }>(points: T[], maxPoints?: number): T[] {
  if (!maxPoints || points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / (maxPoints / 2));
  const out: T[] = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize).filter((p) => p.v !== null);
    if (bucket.length === 0) continue;
    let min = bucket[0];
    let max = bucket[0];
    for (const p of bucket) {
      if ((p.v as number) < (min.v as number)) min = p;
      if ((p.v as number) > (max.v as number)) max = p;
    }
    const [a, b] = min.t <= max.t ? [min, max] : [max, min];
    out.push(a);
    if (b !== a) out.push(b);
  }
  return out;
}
