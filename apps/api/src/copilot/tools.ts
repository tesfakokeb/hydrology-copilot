import type { ToolDefinition } from '@hydro/shared-types';

/**
 * The Copilot tool catalogue (§7).
 *
 * Every tool the Copilot can call is declared here with a machine-readable
 * parameter schema. The same catalogue drives three things: the tool schema
 * sent to the language model, the deterministic keyword router used when no
 * model is configured, and the tool documentation surfaced in the interface.
 * There is exactly one source of truth.
 */

const station = { type: 'string' as const, description: 'Station identifier or code. Defaults to the watershed outlet gauge.' };
const startDate = { type: 'string' as const, description: 'Start of the analysis period, YYYY-MM-DD. Defaults to the start of the record.' };
const endDate = { type: 'string' as const, description: 'End of the analysis period, YYYY-MM-DD. Defaults to the end of the record.' };

export const TOOLS: ToolDefinition[] = [
  // ---- Streamflow ---------------------------------------------------------
  {
    name: 'get_streamflow',
    category: 'streamflow',
    intent: 'data_retrieval',
    description: 'Retrieve the daily discharge record for a gauge, with a completeness report. Use this when the user asks what the flow is or wants to see the record.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: station, startDate, endDate }, required: [] },
    keywords: ['streamflow', 'discharge', 'flow', 'current flow', 'gauge', 'hydrograph', 'cfs', 'cms', 'show flow'],
  },
  {
    name: 'analyze_streamflow',
    category: 'streamflow',
    intent: 'statistical_analysis',
    description: 'Compute descriptive flow statistics, the flow-duration curve, 7Q10, baseflow index, annual peaks and the current percentile and anomaly.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: station, startDate, endDate }, required: [] },
    keywords: ['analyze streamflow', 'flow statistics', 'flow duration', 'baseflow', 'q95', '7q10', 'low flow', 'percentile', 'flow condition', 'streamflow condition'],
  },
  {
    name: 'calculate_flow_statistics',
    category: 'statistics',
    intent: 'statistical_analysis',
    description: 'Alias of analyze_streamflow that emphasises the summary statistics of a discharge record.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: station, startDate, endDate }, required: [] },
    keywords: ['mean flow', 'median flow', 'statistics', 'summary statistics', 'standard deviation', 'skew'],
  },
  {
    name: 'forecast_streamflow',
    category: 'forecasting',
    intent: 'forecasting',
    description: 'Fit a forecasting model, validate it on held-out data, and produce a probabilistic streamflow forecast with prediction intervals and threshold exceedance probabilities.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        stationId: station,
        horizonDays: { type: 'integer', description: 'Forecast horizon in days (1–180). Common choices: 1, 3, 7, 14, 30.', default: 7 },
        model: { type: 'string', description: 'Forecast model. Machine-learning models run in the Python scientific service; the others run in-process.', enum: ['persistence', 'climatology', 'moving_average', 'arima', 'sarima', 'random_forest', 'xgboost', 'lstm', 'gru', 'tft'], default: 'xgboost' },
      },
      required: [],
    },
    keywords: ['forecast streamflow', 'streamflow forecast', 'forecast', 'predict flow', 'next 7 days', 'next week', 'prediction', 'outlook', 'will the flow', 'flow forecast'],
  },
  {
    name: 'detect_flood_events',
    category: 'streamflow',
    intent: 'statistical_analysis',
    description: 'Extract peak-over-threshold flow events and annual peaks, and identify unusual or extreme discharge episodes in the record.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        stationId: station,
        thresholdPercentile: { type: 'number', description: 'Percentile of the daily record defining an event, 90–99.9.', default: 99 },
        minSeparationDays: { type: 'integer', description: 'Declustering window in days.', default: 5 },
        startDate, endDate,
      },
      required: [],
    },
    keywords: ['unusual', 'anomalous', 'extreme events', 'flood events', 'largest floods', 'peak flow', 'annual peaks', 'biggest flow'],
  },

  // ---- Drought ------------------------------------------------------------
  {
    name: 'calculate_spi',
    category: 'drought',
    intent: 'statistical_analysis',
    description: 'Compute the Standardized Precipitation Index at a chosen accumulation timescale, with drought categories and event identification.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: { timescaleMonths: { type: 'integer', description: 'Accumulation window in months: 1, 3, 6, 12, 24.', default: 3 }, startDate, endDate },
      required: [],
    },
    keywords: ['spi', 'standardized precipitation index', 'spi-1', 'spi-3', 'spi-6', 'spi-12', 'precipitation index'],
  },
  {
    name: 'calculate_spei',
    category: 'drought',
    intent: 'statistical_analysis',
    description: 'Compute the Standardized Precipitation-Evapotranspiration Index, which accounts for atmospheric demand as well as rainfall.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { timescaleMonths: { type: 'integer', description: 'Accumulation window in months.', default: 6 }, startDate, endDate }, required: [] },
    keywords: ['spei', 'evapotranspiration index', 'water balance index'],
  },
  {
    name: 'calculate_pdsi',
    category: 'drought',
    intent: 'statistical_analysis',
    description: 'Palmer Drought Severity Index. Requires calibrated soil water-holding capacity by climate division, which this deployment does not hold; the tool explains what is needed and suggests SPEI as the closest available alternative.',
    requiresIntegration: true,
    integrationNote: 'PDSI needs soil available-water capacity and a calibrated Palmer climate-division water balance. Provide those and this tool becomes computable.',
    parameters: { type: 'object', properties: {}, required: [] },
    keywords: ['pdsi', 'palmer', 'palmer drought severity'],
  },
  {
    name: 'assess_drought',
    category: 'drought',
    intent: 'statistical_analysis',
    description: 'Full drought assessment: SPI at several timescales, SPEI, the streamflow drought index, current category, ongoing episode duration and a narrative summary.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { startDate, endDate }, required: [] },
    keywords: ['drought', 'is there a drought', 'drought conditions', 'dry', 'drought status', 'drought assessment', 'experiencing drought'],
  },
  {
    name: 'forecast_drought',
    category: 'drought',
    intent: 'forecasting',
    description: 'Project the drought index forward from the current accumulation state under a no-additional-precipitation assumption, which gives a conservative lower bound on recovery.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { timescaleMonths: { type: 'integer', description: 'SPI timescale.', default: 3 }, horizonMonths: { type: 'integer', description: 'Months ahead.', default: 3 } }, required: [] },
    keywords: ['drought forecast', 'drought outlook', 'will the drought', 'drought recovery'],
  },

  // ---- Water quality ------------------------------------------------------
  {
    name: 'analyze_water_quality',
    category: 'water_quality',
    intent: 'statistical_analysis',
    description: 'Water-quality assessment: CCME Water Quality Index, criterion exceedances, non-parametric trends per parameter, anomalies and parameter correlations.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        stationId: { type: 'string', description: 'Water-quality station identifier or code.' },
        parameters: { type: 'array', items: { type: 'string' }, description: 'Parameters to include, e.g. nitrate, dissolved_oxygen, e_coli. Defaults to all available.' },
        startDate, endDate,
      },
      required: [],
    },
    keywords: ['water quality', 'wqi', 'nitrate', 'dissolved oxygen', 'turbidity', 'e. coli', 'ecoli', 'phosphorus', 'phosphate', 'contamination', 'pollution', 'water quality trends'],
  },
  {
    name: 'calculate_wqi',
    category: 'water_quality',
    intent: 'statistical_analysis',
    description: 'Compute the CCME Water Quality Index and its scope, frequency and amplitude components.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: { type: 'string', description: 'Station identifier.' }, startDate, endDate }, required: [] },
    keywords: ['water quality index', 'wqi', 'ccme'],
  },
  {
    name: 'detect_water_quality_trends',
    category: 'water_quality',
    intent: 'statistical_analysis',
    description: 'Seasonal Mann–Kendall trend tests with Theil–Sen slopes for every water-quality parameter with enough samples.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: { type: 'string', description: 'Station identifier.' }, startDate, endDate }, required: [] },
    keywords: ['trend', 'trends', 'increasing', 'decreasing', 'getting worse', 'improving', 'mann-kendall'],
  },
  {
    name: 'detect_water_quality_anomalies',
    category: 'water_quality',
    intent: 'statistical_analysis',
    description: 'Flag water-quality results that depart from the robust centre of their distribution, using the modified z-score.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: { type: 'string', description: 'Station identifier.' } }, required: [] },
    keywords: ['water quality anomalies', 'outliers', 'suspect results', 'spikes'],
  },

  // ---- Watershed and modelling -------------------------------------------
  {
    name: 'analyze_watershed',
    category: 'gis',
    intent: 'gis_analysis',
    description: 'Characterise the watershed: area, subbasins, elevation, slope, land cover, monitoring network, annual water balance and estimated subbasin flow contributions.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { watershedId: { type: 'string', description: 'Watershed identifier. Defaults to the project watershed.' } }, required: [] },
    keywords: ['watershed', 'basin', 'catchment', 'subbasin', 'analyze my watershed', 'characterise', 'contribute', 'which subbasins', 'drainage area'],
  },
  {
    name: 'calculate_water_balance',
    category: 'gis',
    intent: 'statistical_analysis',
    description: 'Close the catchment water balance P = Q + ET + ΔS and report the residual and runoff coefficient.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { startDate, endDate }, required: [] },
    keywords: ['water balance', 'runoff coefficient', 'evapotranspiration', 'closure', 'budget'],
  },
  {
    name: 'analyze_precipitation',
    category: 'gis',
    intent: 'statistical_analysis',
    description: 'Precipitation statistics, seasonal distribution, and the lagged relationship between rainfall and discharge.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { startDate, endDate }, required: [] },
    keywords: ['precipitation', 'rainfall', 'rain', 'relationship between precipitation and streamflow', 'wet days', 'storm'],
  },
  {
    name: 'analyze_evapotranspiration',
    category: 'gis',
    intent: 'statistical_analysis',
    description: 'Reference and actual evapotranspiration summary, computed within the water balance.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { startDate, endDate }, required: [] },
    keywords: ['evapotranspiration', 'et', 'pet', 'atmospheric demand'],
  },
  {
    name: 'run_hydrologic_model',
    category: 'modeling',
    intent: 'hydrologic_modeling',
    description: 'Run a hydrologic model. GR4J is built in and runs immediately, with optional automatic calibration. HEC-HMS, HEC-RAS, SWAT, SWAT+ and MODFLOW are reached through adapters and report their requirements when the engine is not installed.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        engine: { type: 'string', description: 'Model engine.', enum: ['GR4J', 'HEC-HMS', 'HEC-RAS', 'SWAT', 'SWAT+', 'MODFLOW', 'PYTHON-CUSTOM'], default: 'GR4J' },
        calibrate: { type: 'boolean', description: 'Calibrate GR4J against observed discharge before simulating.', default: true },
      },
      required: [],
    },
    keywords: ['run model', 'hydrologic model', 'gr4j', 'hec-hms', 'hec-ras', 'swat', 'modflow', 'simulate', 'rainfall runoff model'],
  },
  {
    name: 'evaluate_hydrologic_model',
    category: 'modeling',
    intent: 'statistical_analysis',
    description: 'Evaluate a model simulation against observations: NSE, KGE, RMSE, MAE, MAPE, R², bias, PBIAS, peak error and volume error, with a performance rating.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { engine: { type: 'string', description: 'Engine whose most recent run should be evaluated.', default: 'GR4J' } }, required: [] },
    keywords: ['evaluate model', 'model performance', 'nse', 'kge', 'rmse', 'mae', 'r2', 'pbias', 'observed vs simulated', 'compare observed and simulated', 'how good is my model'],
  },
  {
    name: 'calibrate_model',
    category: 'modeling',
    intent: 'hydrologic_modeling',
    description: 'Calibrate the built-in GR4J model by bounded search on KGE or NSE with a split-sample validation period.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { objective: { type: 'string', description: 'Objective function.', enum: ['KGE', 'NSE'], default: 'KGE' } }, required: [] },
    keywords: ['calibrate', 'calibration', 'fit the model', 'tune parameters', 'optimise'],
  },

  // ---- Flood --------------------------------------------------------------
  {
    name: 'calculate_flood_frequency',
    category: 'flood',
    intent: 'statistical_analysis',
    description: 'Flood-frequency analysis by log-Pearson III and GEV, giving design discharges at standard return periods with confidence limits.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        stationId: station,
        method: { type: 'string', description: 'Primary distribution.', enum: ['log-pearson-iii', 'gev'], default: 'log-pearson-iii' },
        regionalSkew: { type: 'number', description: 'Optional regional skew coefficient for Bulletin 17B weighting.' },
      },
      required: [],
    },
    keywords: ['flood frequency', '100-year', '100 year flood', 'return period', 'design flood', 'recurrence interval', 'annual chance', 'base flood', '1%'],
  },
  {
    name: 'estimate_return_period',
    category: 'flood',
    intent: 'statistical_analysis',
    description: 'Estimate the return period and annual exceedance probability of a specified discharge.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { discharge: { type: 'number', description: 'Discharge in m³/s.' }, stationId: station }, required: ['discharge'] },
    keywords: ['return period of', 'how often', 'recurrence of', 'exceedance probability of'],
  },
  {
    name: 'analyze_flood_risk',
    category: 'flood',
    intent: 'forecasting',
    description: 'Current flood risk plus a probabilistic short-range outlook: threshold exceedance probability by day, forecast peak, hazard classification and an illustrative inundation footprint.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { stationId: station, horizonDays: { type: 'integer', description: 'Outlook horizon in days.', default: 7 } }, required: [] },
    keywords: ['flood risk', 'flooding', 'flood', 'will it flood', 'flood warning', 'flood prone', 'inundation', 'bankfull', 'overtop'],
  },
  {
    name: 'generate_floodplain_map',
    category: 'flood',
    intent: 'gis_analysis',
    description: 'Produce a floodplain inundation map. Analysis-grade depth, velocity and extent require a HEC-RAS 2D run; without that engine the tool returns an explicitly illustrative footprint and states what is required.',
    requiresIntegration: true,
    integrationNote: 'Requires a HEC-RAS 2D model with terrain, mesh, roughness and boundary conditions. Configure HEC_RAS_PATH and upload a project.',
    parameters: { type: 'object', properties: { returnPeriodYears: { type: 'number', description: 'Design event, e.g. 100 for the 1 %-annual-chance flood.', default: 100 } }, required: [] },
    keywords: ['floodplain map', 'inundation map', 'flood map', 'depth map', 'floodway', 'firm', 'fema map', 'base flood elevation'],
  },

  // ---- Water supply and demand -------------------------------------------
  {
    name: 'analyze_reservoir_storage',
    category: 'water_supply',
    intent: 'statistical_analysis',
    description: 'Simulate reservoir operation and report reliability, resilience, vulnerability, deficit probability, safe yield and the storage exceedance curve under a scenario.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: { scenario: { type: 'string', description: 'Planning scenario.', enum: ['baseline', 'dry', 'average', 'wet', 'extreme_drought', 'climate_change', 'population_growth', 'high_demand', 'conservation', 'land_use_change'], default: 'baseline' } },
      required: [],
    },
    keywords: ['reservoir', 'storage', 'water supply', 'safe yield', 'reliability', 'supply available', 'how much water'],
  },
  {
    name: 'forecast_water_supply',
    category: 'water_supply',
    intent: 'forecasting',
    description: 'Project available supply under a scenario, reporting reliability and deficit probability over the simulation.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { scenario: { type: 'string', description: 'Planning scenario.', default: 'baseline' } }, required: [] },
    keywords: ['supply forecast', 'water availability', 'available supply', 'will we have enough water'],
  },
  {
    name: 'perform_supply_demand_balance',
    category: 'water_supply',
    intent: 'statistical_analysis',
    description: 'Compare supply against demand across several planning scenarios and report reliability and unmet demand for each.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: { scenarios: { type: 'array', items: { type: 'string' }, description: 'Scenarios to compare.' } },
      required: [],
    },
    keywords: ['supply and demand', 'supply demand balance', 'compare supply', 'shortfall', 'deficit', 'scenario comparison', 'water shortage'],
  },
  {
    name: 'forecast_water_demand',
    category: 'water_demand',
    intent: 'forecasting',
    description: 'Forecast municipal, agricultural, industrial or total water demand with prediction intervals, seasonal shape, peak demand and anomaly detection.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        horizonMonths: { type: 'integer', description: 'Forecast horizon in months (1–60).', default: 12 },
        sector: { type: 'string', description: 'Demand sector.', enum: ['municipal', 'agricultural', 'industrial', 'total'], default: 'total' },
      },
      required: [],
    },
    keywords: ['demand', 'water demand', 'consumption', 'usage forecast', 'demand forecast', 'how much will we use'],
  },
  {
    name: 'analyze_consumption',
    category: 'water_demand',
    intent: 'statistical_analysis',
    description: 'Analyse historical consumption by sector, its trend, seasonal shape and per-capita behaviour.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { sector: { type: 'string', description: 'Demand sector.', default: 'total' } }, required: [] },
    keywords: ['consumption', 'per capita', 'usage', 'sectoral demand', 'municipal use'],
  },
  {
    name: 'detect_demand_anomalies',
    category: 'water_demand',
    intent: 'statistical_analysis',
    description: 'Flag months whose demand departs sharply from the fitted trend-plus-seasonal model — often a metering or reporting problem.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { sector: { type: 'string', description: 'Demand sector.', default: 'total' } }, required: [] },
    keywords: ['demand anomalies', 'unusual consumption', 'leak', 'metering error'],
  },

  // ---- GIS and output -----------------------------------------------------
  {
    name: 'run_gis_analysis',
    category: 'gis',
    intent: 'gis_analysis',
    description: 'Spatial queries over the project layers: subbasin summaries, stations within the watershed, bounding box, nearest station to a coordinate.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'Spatial operation.', enum: ['subbasin_summary', 'stations_in_watershed', 'bounding_box', 'nearest_station'], default: 'subbasin_summary' },
        lon: { type: 'number', description: 'Longitude for a nearest-station query.' },
        lat: { type: 'number', description: 'Latitude for a nearest-station query.' },
      },
      required: [],
    },
    keywords: ['gis', 'spatial', 'nearest station', 'map query', 'where is', 'bounding box', 'intersect'],
  },
  {
    name: 'intersect_spatial_layers',
    category: 'gis',
    intent: 'gis_analysis',
    description: 'Intersect two project layers, e.g. stations against subbasins. Uses PostGIS when a database is configured.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { operation: { type: 'string', description: 'Operation.', default: 'stations_in_watershed' } }, required: [] },
    keywords: ['intersect', 'overlay', 'clip', 'within', 'spatial join'],
  },
  {
    name: 'calculate_watershed_statistics',
    category: 'gis',
    intent: 'gis_analysis',
    description: 'Area, elevation, slope, curve number and land-cover statistics by subbasin.',
    requiresIntegration: false,
    parameters: { type: 'object', properties: { watershedId: { type: 'string', description: 'Watershed identifier.' } }, required: [] },
    keywords: ['watershed statistics', 'basin statistics', 'curve number', 'slope', 'elevation', 'land cover'],
  },
  {
    name: 'generate_report',
    category: 'output',
    intent: 'report_generation',
    description: 'Assemble a full scientific report by running the relevant analyses and composing their results, figures, methods, assumptions, limitations, uncertainty and provenance.',
    requiresIntegration: false,
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Report type.', enum: ['hydrology_assessment', 'drought_assessment', 'flood_risk', 'water_quality', 'water_supply_planning', 'water_demand_forecast'], default: 'hydrology_assessment' },
        title: { type: 'string', description: 'Optional report title.' },
      },
      required: [],
    },
    keywords: ['report', 'generate a report', 'write up', 'summary report', 'assessment report', 'document', 'deliverable'],
  },
];

export const TOOLS_BY_NAME: Record<string, ToolDefinition> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Anthropic tool-use schema derived from the same catalogue. */
export function toAnthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(t.parameters.properties).map(([k, v]) => [
          k,
          {
            type: v.type,
            description: v.description,
            ...(v.enum ? { enum: [...v.enum] } : {}),
            ...(v.items ? { items: v.items } : {}),
          },
        ]),
      ),
      required: t.parameters.required,
    },
  }));
}

export const SUGGESTED_PROMPTS = [
  'Analyze my watershed',
  'Forecast streamflow for the next 7 days',
  'Assess drought conditions',
  'Analyze water quality trends',
  'Evaluate my hydrologic model',
  'Calculate flood risk',
  'Compare water supply and demand',
  'Find anomalous streamflow events',
  'Calculate SPI-12 from the precipitation dataset',
  'What is the probability of exceeding bankfull discharge?',
  'Which subbasins contribute the most flow?',
  'Generate a hydrology report',
];
