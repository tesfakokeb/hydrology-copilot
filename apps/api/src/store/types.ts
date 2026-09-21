import type {
  Conversation,
  CopilotMessage,
  Dataset,
  Job,
  ModelRun,
  Project,
  Report,
  Reservoir,
  Scenario,
  Station,
  Subbasin,
  TimeSeries,
  User,
  Watershed,
} from '@hydro/shared-types';
import type { ProvenanceRecord } from '@hydro/shared-types';

export interface StoredUser extends User {
  passwordHash: string;
  isActive: boolean;
}

export interface SeriesQuery {
  stationId?: string;
  stationCode?: string;
  watershedId?: string;
  variable: string;
  start?: string;
  end?: string;
  /** Maximum points to return; the series is decimated, never truncated. */
  maxPoints?: number;
}

export interface WaterQualityQuery {
  stationId?: string;
  watershedId?: string;
  parameters?: string[];
  start?: string;
  end?: string;
}

export interface WaterQualityRow {
  t: string;
  stationId: string;
  stationCode: string;
  parameter: string;
  value: number;
  unit: string;
}

export interface DemandRow {
  t: string;
  sector: 'municipal' | 'agricultural' | 'industrial';
  demandMcm: number;
  population: number;
}

export interface ReservoirRow {
  t: string;
  storageMcm: number;
  elevationM: number;
  inflowM3s: number;
  releaseM3s: number;
  spillM3s: number;
  evaporationMcm: number;
}

/**
 * The persistence contract. Two implementations exist: an in-memory store
 * seeded with the synthetic demonstration watershed (always available), and a
 * PostgreSQL/PostGIS store used when DATABASE_URL is configured and reachable.
 */
export interface DataAccess {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;

  // Users -------------------------------------------------------------------
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  createUser(u: Omit<StoredUser, 'createdAt'>): Promise<StoredUser>;
  recordLogin(id: string): Promise<void>;

  // Projects ----------------------------------------------------------------
  listProjects(userId: string): Promise<Project[]>;
  getProject(id: string, userId: string): Promise<Project | null>;
  createProject(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project>;
  updateProject(id: string, userId: string, patch: Partial<Project>): Promise<Project | null>;
  deleteProject(id: string, userId: string): Promise<boolean>;

  // Spatial -----------------------------------------------------------------
  listWatersheds(projectId?: string): Promise<Watershed[]>;
  getWatershed(id: string): Promise<Watershed | null>;
  listSubbasins(watershedId: string): Promise<Subbasin[]>;
  listStations(filter?: { watershedId?: string; type?: string }): Promise<Station[]>;
  getStation(idOrCode: string): Promise<Station | null>;
  getWatershedGeoJson(watershedId: string): Promise<unknown>;
  getReaches(watershedId: string): Promise<unknown>;

  // Observations ------------------------------------------------------------
  getSeries(q: SeriesQuery): Promise<TimeSeries>;
  getWaterQuality(q: WaterQualityQuery): Promise<WaterQualityRow[]>;
  listReservoirs(watershedId?: string): Promise<Reservoir[]>;
  getReservoirSeries(reservoirId: string, start?: string, end?: string): Promise<ReservoirRow[]>;
  getDemand(projectId: string, start?: string, end?: string): Promise<DemandRow[]>;

  // Datasets ----------------------------------------------------------------
  listDatasets(projectId: string): Promise<Dataset[]>;
  getDataset(id: string): Promise<Dataset | null>;
  createDataset(d: Omit<Dataset, 'id' | 'uploadedAt'>): Promise<Dataset>;
  deleteDataset(id: string): Promise<boolean>;

  // Copilot -----------------------------------------------------------------
  listConversations(userId: string, projectId?: string): Promise<Conversation[]>;
  createConversation(c: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt' | 'messageCount'>): Promise<Conversation>;
  getConversation(id: string, userId: string): Promise<Conversation | null>;
  listMessages(conversationId: string): Promise<CopilotMessage[]>;
  appendMessage(m: Omit<CopilotMessage, 'id' | 'createdAt'>): Promise<CopilotMessage>;

  // Analysis artefacts ------------------------------------------------------
  saveProvenance(p: ProvenanceRecord): Promise<void>;
  getProvenance(id: string): Promise<ProvenanceRecord | null>;
  listProvenance(projectId: string, limit: number): Promise<ProvenanceRecord[]>;

  listJobs(projectId?: string, limit?: number): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  createJob(j: Omit<Job, 'id' | 'createdAt'>): Promise<Job>;
  updateJob(id: string, patch: Partial<Job>): Promise<Job | null>;

  listModelRuns(projectId: string): Promise<ModelRun[]>;
  getModelRun(id: string): Promise<ModelRun | null>;
  createModelRun(r: Omit<ModelRun, 'id' | 'createdAt'>): Promise<ModelRun>;
  updateModelRun(id: string, patch: Partial<ModelRun>): Promise<ModelRun | null>;

  listReports(projectId: string): Promise<Report[]>;
  getReport(id: string): Promise<(Report & { contentHtml: string | null }) | null>;
  createReport(r: Omit<Report, 'id' | 'createdAt'> & { contentHtml?: string }): Promise<Report>;

  listScenarios(projectId: string): Promise<Scenario[]>;
  createScenario(s: Omit<Scenario, 'id' | 'createdAt'>): Promise<Scenario>;
  deleteScenario(id: string): Promise<boolean>;
}
