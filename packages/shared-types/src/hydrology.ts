/** Core hydrologic domain types. */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type DischargeUnit = 'm3/s' | 'ft3/s' | 'ML/d' | 'MGD';
export type DepthUnit = 'mm' | 'in';
export type LengthUnit = 'm' | 'ft';
export type AreaUnit = 'km2' | 'mi2' | 'ha' | 'ac';
export type VolumeUnit = 'm3' | 'ac-ft' | 'MCM';
export type ConcentrationUnit = 'mg/L' | 'ug/L' | 'NTU' | 'uS/cm' | 'MPN/100mL' | 'pH' | 'degC' | 'degF';
export type TemperatureUnit = 'degC' | 'degF';

export type Unit =
  | DischargeUnit
  | DepthUnit
  | LengthUnit
  | AreaUnit
  | VolumeUnit
  | ConcentrationUnit
  | TemperatureUnit
  | 'dimensionless'
  | '%';

/** A number is never transported without its unit. */
export interface Quantity {
  value: number | null;
  unit: Unit;
}

// ---------------------------------------------------------------------------
// Spatial
// ---------------------------------------------------------------------------

export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface Point {
  lon: number;
  lat: number;
}

export interface Watershed {
  id: string;
  projectId: string | null;
  name: string;
  huc: string | null;
  areaKm2: number;
  outletPoint: Point | null;
  bbox: BoundingBox | null;
  centroid: Point | null;
  description: string | null;
  isDemo: boolean;
}

export interface Subbasin {
  id: string;
  watershedId: string;
  name: string;
  areaKm2: number;
  meanElevationM: number | null;
  meanSlopePct: number | null;
  curveNumber: number | null;
  dominantLandCover: string | null;
  centroid: Point | null;
}

export type StationType =
  | 'streamgage'
  | 'precipitation'
  | 'weather'
  | 'water_quality'
  | 'groundwater'
  | 'reservoir'
  | 'snotel';

export interface Station {
  id: string;
  watershedId: string | null;
  code: string;
  name: string;
  type: StationType;
  location: Point;
  elevationM: number | null;
  drainageAreaKm2: number | null;
  operator: string | null;
  active: boolean;
  isSynthetic: boolean;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export type QualityFlag = 'approved' | 'provisional' | 'estimated' | 'ice_affected' | 'missing' | 'suspect';

export interface TimeSeriesPoint {
  t: string; // ISO-8601 date or datetime
  v: number | null;
  flag?: QualityFlag;
}

export interface TimeSeries {
  variable: string;
  unit: Unit;
  stationId?: string;
  stationName?: string;
  points: TimeSeriesPoint[];
}

export type HydroVariable =
  | 'discharge'
  | 'stage'
  | 'precipitation'
  | 'temperature_mean'
  | 'temperature_min'
  | 'temperature_max'
  | 'et_reference'
  | 'et_actual'
  | 'soil_moisture'
  | 'snow_water_equivalent'
  | 'groundwater_level'
  | 'reservoir_storage'
  | 'reservoir_elevation'
  | 'reservoir_release'
  | 'water_demand';

// ---------------------------------------------------------------------------
// Flow statistics
// ---------------------------------------------------------------------------

export interface FlowStatistics {
  count: number;
  missing: number;
  startDate: string;
  endDate: string;
  unit: DischargeUnit;
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  skew: number;
  cv: number;
  /** Flow-duration percentiles: exceedance probability -> discharge. */
  flowDuration: Record<string, number>;
  q7d10: number | null;
  baseflowIndex: number | null;
  annualPeaks?: { waterYear: number; peak: number; date: string }[];
}

export interface FlowDurationCurvePoint {
  exceedanceProbability: number;
  discharge: number;
}

// ---------------------------------------------------------------------------
// Drought
// ---------------------------------------------------------------------------

export type DroughtIndexName = 'SPI' | 'SPEI' | 'PDSI' | 'SSI' | 'PNI';

export type DroughtCategory = 'D4' | 'D3' | 'D2' | 'D1' | 'D0' | 'Normal' | 'W0' | 'W1' | 'W2' | 'W3' | 'W4';

export interface DroughtClassification {
  category: DroughtCategory;
  label: string;
  severity: number; // 0 = normal, 4 = exceptional drought
  colorHex: string;
}

export interface DroughtIndexSeries {
  index: DroughtIndexName;
  timescaleMonths: number;
  distribution: string;
  calibrationStart: string;
  calibrationEnd: string;
  points: { t: string; v: number | null; category: DroughtCategory }[];
}

export interface DroughtAssessment {
  stationId: string | null;
  watershedId: string | null;
  asOf: string;
  current: { index: DroughtIndexName; timescaleMonths: number; value: number; classification: DroughtClassification }[];
  currentEventStart: string | null;
  currentEventDurationMonths: number | null;
  currentEventSeverity: number | null;
  historicalEvents: DroughtEvent[];
  streamflowPercentile: number | null;
  narrative: string;
}

export interface DroughtEvent {
  start: string;
  end: string;
  durationMonths: number;
  /** Cumulative negative index value over the event (magnitude). */
  severity: number;
  peakIntensity: number;
  peakCategory: DroughtCategory;
}

// ---------------------------------------------------------------------------
// Water quality
// ---------------------------------------------------------------------------

export type WaterQualityParameter =
  | 'temperature'
  | 'ph'
  | 'dissolved_oxygen'
  | 'turbidity'
  | 'conductivity'
  | 'tds'
  | 'nitrate'
  | 'phosphate'
  | 'ammonia'
  | 'chlorophyll_a'
  | 'e_coli'
  | 'tss'
  | 'toc';

export interface WaterQualityThreshold {
  parameter: WaterQualityParameter;
  unit: Unit;
  /** Criterion direction: 'max' = exceedance above, 'min' = exceedance below. */
  direction: 'max' | 'min' | 'range';
  min?: number;
  max?: number;
  source: string;
}

export interface WaterQualityIndexResult {
  wqi: number;
  rating: 'Excellent' | 'Good' | 'Fair' | 'Marginal' | 'Poor';
  method: 'CCME-WQI' | 'NSF-WQI' | 'Weighted-Arithmetic';
  parametersUsed: WaterQualityParameter[];
  f1Scope?: number;
  f2Frequency?: number;
  f3Amplitude?: number;
  exceedances: { parameter: WaterQualityParameter; count: number; total: number; pct: number }[];
  period: { start: string; end: string };
}

export interface TrendResult {
  parameter: string;
  method: 'mann-kendall' | 'seasonal-mann-kendall' | 'ols';
  n: number;
  tau: number | null;
  pValue: number;
  slopePerYear: number;
  slopeUnit: string;
  significant: boolean;
  alpha: number;
  direction: 'increasing' | 'decreasing' | 'no trend';
}

// ---------------------------------------------------------------------------
// Forecasting
// ---------------------------------------------------------------------------

export type ForecastModelKind =
  | 'persistence'
  | 'climatology'
  | 'moving_average'
  | 'arima'
  | 'sarima'
  | 'random_forest'
  | 'xgboost'
  | 'lstm'
  | 'gru'
  | 'tft';

export interface ForecastPoint {
  t: string;
  mean: number;
  lower80?: number;
  upper80?: number;
  lower95?: number;
  upper95?: number;
  /** Ensemble member values when the model is ensemble-based. */
  ensemble?: number[];
}

export interface ModelMetrics {
  nse: number | null;
  kge: number | null;
  rmse: number | null;
  mae: number | null;
  mape: number | null;
  r2: number | null;
  bias: number | null;
  pbias: number | null;
  correlation: number | null;
  peakErrorPct: number | null;
  volumeErrorPct: number | null;
  n: number;
}

export interface ForecastResult {
  id: string;
  variable: HydroVariable;
  unit: Unit;
  stationId: string | null;
  model: ForecastModelKind;
  issuedAt: string;
  horizonDays: number;
  trainingPeriod: { start: string; end: string };
  validationPeriod: { start: string; end: string } | null;
  metrics: ModelMetrics;
  featureImportance: { feature: string; importance: number }[];
  points: ForecastPoint[];
  thresholds: ForecastThreshold[];
  limitations: string[];
}

export interface ForecastThreshold {
  name: string;
  value: number;
  unit: Unit;
  kind: 'flood' | 'action' | 'bankfull' | 'low_flow' | 'custom';
  exceedanceProbability: number | null;
  firstExceedance: string | null;
}

// ---------------------------------------------------------------------------
// Flood
// ---------------------------------------------------------------------------

export interface FloodFrequencyResult {
  method: 'log-pearson-iii' | 'gev' | 'gumbel' | 'weibull-plotting';
  stationId: string | null;
  nYears: number;
  waterYears: number[];
  skewOption?: 'station' | 'weighted' | 'regional';
  unit: DischargeUnit;
  quantiles: {
    returnPeriodYears: number;
    annualExceedanceProbability: number;
    discharge: number;
    lower95: number | null;
    upper95: number | null;
  }[];
  notes: string[];
}

export type FloodHazardClass = 'low' | 'moderate' | 'high' | 'extreme';

export interface FloodRiskAssessment {
  watershedId: string;
  asOf: string;
  currentDischarge: Quantity;
  actionStage: Quantity | null;
  floodStage: Quantity | null;
  probabilityOfFloodStage7d: number | null;
  peakForecast: Quantity | null;
  peakForecastTime: string | null;
  hazardClass: FloodHazardClass;
  inundationAreaKm2: number | null;
  populationAtRisk: number | null;
  disclaimers: string[];
}

export interface InundationCell {
  lon: number;
  lat: number;
  depthM: number;
  velocityMs: number | null;
  hazard: FloodHazardClass;
  arrivalHours: number | null;
}

// ---------------------------------------------------------------------------
// Water supply and demand
// ---------------------------------------------------------------------------

export interface Reservoir {
  id: string;
  watershedId: string;
  name: string;
  location: Point;
  capacityMcm: number;
  deadStorageMcm: number;
  conservationPoolMcm: number | null;
  floodPoolMcm: number | null;
  purpose: string[];
  isSynthetic: boolean;
}

export interface SupplyReliabilityResult {
  reservoirId: string;
  scenario: ScenarioName;
  periodYears: number;
  /** Fraction of time-steps where demand is fully met. */
  timeReliability: number;
  volumetricReliability: number;
  resilience: number;
  vulnerabilityMcm: number;
  safeYieldMcmPerYear: number | null;
  deficitProbability: number;
  storageExceedance: { probability: number; storageMcm: number }[];
}

export type ScenarioName =
  | 'baseline'
  | 'dry'
  | 'average'
  | 'wet'
  | 'extreme_drought'
  | 'climate_change'
  | 'population_growth'
  | 'high_demand'
  | 'conservation'
  | 'reservoir_operation'
  | 'land_use_change';

export interface Scenario {
  id: string;
  projectId: string;
  name: string;
  kind: ScenarioName;
  description: string;
  parameters: Record<string, number | string | boolean>;
  createdAt: string;
}

export interface SupplyDemandBalance {
  scenario: ScenarioName;
  unit: VolumeUnit;
  periods: {
    t: string;
    supplyAvailable: number;
    demand: number;
    balance: number;
    storageMcm: number;
    shortfall: number;
  }[];
  totalShortfall: number;
  monthsInDeficit: number;
}

export interface DemandForecastResult extends Omit<ForecastResult, 'variable'> {
  variable: 'water_demand';
  sector: 'municipal' | 'agricultural' | 'industrial' | 'total';
  peakDemand: Quantity;
  peakDemandDate: string | null;
  seasonalPattern: { month: number; indexValue: number }[];
  anomalies: { t: string; observed: number; expected: number; zScore: number }[];
}

// ---------------------------------------------------------------------------
// Hydrologic models
// ---------------------------------------------------------------------------

export type ModelEngine = 'HEC-HMS' | 'HEC-RAS' | 'SWAT' | 'SWAT+' | 'MODFLOW' | 'PYTHON-CUSTOM' | 'GR4J';

export type ModelRunStatus = 'queued' | 'validating' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ModelRun {
  id: string;
  projectId: string;
  watershedId: string | null;
  engine: ModelEngine;
  name: string;
  status: ModelRunStatus;
  adapterAvailable: boolean;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  parameters: Record<string, unknown>;
  metrics: ModelMetrics | null;
  outputLocation: string | null;
  logs: string[];
  message: string | null;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  checkedAt: string;
}

export interface ModelOutput {
  runId: string;
  series: TimeSeries[];
  summary: Record<string, Quantity>;
  artifacts: { name: string; kind: string; uri: string }[];
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export type DatasetFormat = 'csv' | 'xlsx' | 'netcdf' | 'geotiff' | 'geojson' | 'shapefile' | 'parquet' | 'json';

export interface DatasetVariable {
  name: string;
  role: 'time' | 'latitude' | 'longitude' | 'station_id' | 'value' | 'flag' | 'unknown';
  dtype: string;
  unit: Unit | null;
  missingCount: number;
  missingPct: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  stdDev: number | null;
  outlierCount: number;
  distinctCount: number | null;
}

export interface DatasetProfile {
  datasetId: string;
  name: string;
  format: DatasetFormat;
  rows: number;
  columns: number;
  temporalCoverage: { start: string; end: string; step: string | null } | null;
  spatialCoverage: BoundingBox | null;
  crs: string | null;
  variables: DatasetVariable[];
  missingDataPct: number;
  qualityFlags: string[];
  warnings: string[];
  profiledAt: string;
}

export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  format: DatasetFormat;
  source: string;
  sourceUrl: string | null;
  version: string;
  storageUri: string;
  sizeBytes: number;
  isSynthetic: boolean;
  uploadedBy: string;
  uploadedAt: string;
  profile: DatasetProfile | null;
}

// ---------------------------------------------------------------------------
// Projects, users, jobs, reports
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'modeler' | 'analyst' | 'viewer';

export interface User {
  id: string;
  email: string;
  fullName: string;
  organization: string | null;
  role: Role;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  agency: string | null;
  defaultWatershedId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  unitSystem: 'SI' | 'US';
  role?: Role;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: string;
  projectId: string | null;
  userId: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputLocation: string | null;
  error: string | null;
  logs: { t: string; level: string; message: string }[];
}

export type ReportKind =
  | 'hydrology_assessment'
  | 'drought_assessment'
  | 'flood_risk'
  | 'water_quality'
  | 'water_supply_planning'
  | 'water_demand_forecast';

export interface Report {
  id: string;
  projectId: string;
  kind: ReportKind;
  title: string;
  status: 'generating' | 'ready' | 'failed';
  formats: ('pdf' | 'docx' | 'html')[];
  storageUri: string | null;
  createdBy: string;
  createdAt: string;
  provenanceId: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface KpiCard {
  id: string;
  group: 'hydrology' | 'drought' | 'flood' | 'water_quality' | 'supply' | 'demand';
  label: string;
  value: number | null;
  unit: Unit;
  precision: number;
  delta: number | null;
  deltaLabel: string | null;
  status: 'normal' | 'watch' | 'warning' | 'critical' | 'unknown';
  context: string;
  asOf: string;
  sourceDatasetId: string | null;
}

export interface Alert {
  id: string;
  severity: 'info' | 'watch' | 'warning' | 'critical';
  title: string;
  body: string;
  category: 'flood' | 'drought' | 'water_quality' | 'supply' | 'data';
  issuedAt: string;
  generatedBy: 'rule' | 'copilot';
  evidence: string[];
}
