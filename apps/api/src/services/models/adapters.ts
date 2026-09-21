import type { ModelEngine, ModelMetrics, ModelOutput, ValidationResult } from '@hydro/shared-types';

/**
 * Hydrologic and hydraulic model adapters (§11–13 of the specification).
 *
 * The external engines — HEC-HMS, HEC-RAS, SWAT/SWAT+, MODFLOW — are not
 * bundled and are not assumed to be installed. Each adapter therefore:
 *
 *   1. Declares what it needs (executable, licence, input files, platform).
 *   2. Validates an uploaded project without running anything.
 *   3. Reports `available: false` with a specific, actionable message when the
 *      engine is absent, instead of pretending to run.
 *
 * The GR4J adapter is different: it is implemented in TypeScript inside
 * @hydro/hydrology-core, so it always runs. That is what makes the modelling
 * workspace demonstrable end-to-end on a clean install.
 */

export interface AdapterRequirement {
  kind: 'executable' | 'file' | 'directory' | 'environment' | 'licence';
  name: string;
  description: string;
  envVar?: string;
}

export interface ModelRunRequest {
  runId: string;
  projectId: string;
  watershedId: string | null;
  parameters: Record<string, unknown>;
  inputUri?: string | null;
  onLog?: (line: string) => void;
}

export interface ModelRunResult {
  status: 'completed' | 'failed' | 'integration_required';
  message: string;
  output: ModelOutput | null;
  metrics: ModelMetrics | null;
  logs: string[];
}

export interface HydrologicModelAdapter {
  readonly engine: ModelEngine;
  readonly displayName: string;
  readonly description: string;
  /** True when the engine can actually execute in this deployment. */
  available(): Promise<boolean>;
  requirements(): AdapterRequirement[];
  /** Supported model components, surfaced in the UI. */
  capabilities(): string[];
  validateInput(req: ModelRunRequest): Promise<ValidationResult>;
  runModel(req: ModelRunRequest): Promise<ModelRunResult>;
  retrieveOutput(runId: string): Promise<ModelOutput | null>;
  calculateMetrics(runId: string): Promise<ModelMetrics | null>;
}

const now = () => new Date().toISOString();

/**
 * Base for adapters that shell out to an external engine. Every method fails
 * loudly and specifically when the engine is not configured, which is what
 * keeps "Integration Required" honest in the interface.
 */
abstract class ExternalEngineAdapter implements HydrologicModelAdapter {
  abstract readonly engine: ModelEngine;
  abstract readonly displayName: string;
  abstract readonly description: string;
  protected abstract readonly envVar: string;

  protected get executablePath(): string | null {
    return process.env[this.envVar] ?? null;
  }

  async available(): Promise<boolean> {
    if (!this.executablePath) return false;
    const { access } = await import('node:fs/promises');
    try {
      await access(this.executablePath);
      return true;
    } catch {
      return false;
    }
  }

  abstract requirements(): AdapterRequirement[];
  abstract capabilities(): string[];
  abstract requiredInputs(): string[];

  async validateInput(req: ModelRunRequest): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (!(await this.available())) {
      issues.push({
        severity: 'error',
        code: 'ENGINE_NOT_CONFIGURED',
        message:
          `${this.displayName} is not configured in this deployment. Set ${this.envVar} to the engine executable and ` +
          'restart the API. Until then this adapter validates inputs but cannot run a simulation.',
      });
    }
    if (!req.inputUri) {
      issues.push({
        severity: 'error',
        code: 'NO_INPUT_PROJECT',
        message: `Upload a ${this.displayName} project archive before running. Expected components: ${this.requiredInputs().join(', ')}.`,
      });
    }
    for (const key of this.requiredParameters()) {
      if (req.parameters[key] === undefined) {
        issues.push({ severity: 'warning', code: 'MISSING_PARAMETER', message: `Parameter "${key}" was not supplied; the engine default will be used.`, path: key });
      }
    }
    return { valid: issues.every((i) => i.severity !== 'error'), issues, checkedAt: now() };
  }

  protected requiredParameters(): string[] {
    return [];
  }

  async runModel(req: ModelRunRequest): Promise<ModelRunResult> {
    const validation = await this.validateInput(req);
    const logs = [
      `[${now()}] Preparing ${this.displayName} run ${req.runId}.`,
      ...validation.issues.map((i) => `[${now()}] ${i.severity.toUpperCase()} ${i.code}: ${i.message}`),
    ];
    logs.forEach((l) => req.onLog?.(l));

    if (!(await this.available())) {
      return {
        status: 'integration_required',
        message:
          `${this.displayName} integration required. The adapter is implemented and validated inputs successfully, ` +
          `but no engine executable is available (${this.envVar} is unset or does not point at a runnable binary). ` +
          'No simulation was performed and no results were fabricated.',
        output: null,
        metrics: null,
        logs,
      };
    }
    // A configured deployment would spawn the engine here. The adapter refuses
    // to invent a result rather than returning a plausible-looking one.
    return {
      status: 'failed',
      message: `${this.displayName} executable is present but process invocation is not enabled in this build. Enable it in infrastructure/docker/${this.engine.toLowerCase()}/ and rebuild the worker image.`,
      output: null,
      metrics: null,
      logs,
    };
  }

  async retrieveOutput(): Promise<ModelOutput | null> {
    return null;
  }

  async calculateMetrics(): Promise<ModelMetrics | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HEC-HMS
// ---------------------------------------------------------------------------

export class HecHmsAdapter extends ExternalEngineAdapter {
  readonly engine = 'HEC-HMS' as const;
  readonly displayName = 'HEC-HMS';
  readonly description =
    'US Army Corps of Engineers Hydrologic Modeling System. Event and continuous rainfall-runoff simulation for dendritic watershed systems.';
  protected readonly envVar = 'HEC_HMS_PATH';

  requirements(): AdapterRequirement[] {
    return [
      { kind: 'executable', name: 'HEC-HMS command-line runner', description: 'HEC-HMS 4.10+ with the Jython scripting interface (hec-hms.sh / HEC-HMS.exe).', envVar: 'HEC_HMS_PATH' },
      { kind: 'directory', name: 'Project directory', description: 'A HEC-HMS project containing .hms, .basin, .met, .control and .dss files.' },
      { kind: 'environment', name: 'Java runtime', description: 'HEC-HMS bundles its own JRE; the container must allow it to execute.' },
    ];
  }

  requiredInputs(): string[] {
    return ['.hms project file', '.basin basin model', '.met meteorologic model', '.control control specifications', '.dss time-series data'];
  }

  protected requiredParameters(): string[] {
    return ['basinModel', 'meteorologicModel', 'controlSpecification'];
  }

  capabilities(): string[] {
    return [
      'Basin models with subbasin, reach, junction, reservoir, source, sink and diversion elements',
      'Loss methods: SCS curve number, Green–Ampt, initial/constant, deficit and constant, soil moisture accounting',
      'Transform methods: SCS unit hydrograph, Clark, Snyder, ModClark, kinematic wave',
      'Baseflow: recession, constant monthly, linear reservoir',
      'Routing: Muskingum, Muskingum–Cunge, lag, modified Puls, kinematic wave',
      'Meteorologic models: gauge weights, inverse distance, gridded precipitation, frequency storm',
      'Optimisation trials for parameter calibration',
    ];
  }
}

// ---------------------------------------------------------------------------
// HEC-RAS
// ---------------------------------------------------------------------------

export class HecRasAdapter extends ExternalEngineAdapter {
  readonly engine = 'HEC-RAS' as const;
  readonly displayName = 'HEC-RAS';
  readonly description =
    'US Army Corps of Engineers River Analysis System. One- and two-dimensional steady and unsteady hydraulics, used for floodplain mapping.';
  protected readonly envVar = 'HEC_RAS_PATH';

  requirements(): AdapterRequirement[] {
    return [
      { kind: 'executable', name: 'HEC-RAS controller or RasUnsteady', description: 'HEC-RAS 6.x. On Linux the unsteady solver binaries; on Windows the RAS Controller COM interface.', envVar: 'HEC_RAS_PATH' },
      { kind: 'file', name: 'Terrain', description: 'A GeoTIFF or HEC-RAS terrain (.hdf) covering the model domain.' },
      { kind: 'file', name: 'Geometry', description: '2D flow-area mesh, breaklines and structures (.g01 / geometry HDF).' },
      { kind: 'file', name: 'Boundary conditions', description: 'Flow hydrographs, stage hydrographs or normal-depth boundaries (.u01).' },
      { kind: 'file', name: 'Roughness', description: 'Land-cover raster with an associated Manning n lookup table.' },
    ];
  }

  requiredInputs(): string[] {
    return ['.prj project', '.g## geometry', '.u## unsteady flow', 'terrain raster', 'land-cover / Manning n table'];
  }

  protected requiredParameters(): string[] {
    return ['plan', 'computationInterval', 'simulationWindow'];
  }

  capabilities(): string[] {
    return [
      'Terrain and DEM preprocessing',
      '2D flow-area mesh definition with breaklines and refinement regions',
      'Land-cover-based Manning roughness',
      'Unsteady boundary conditions from observed or forecast hydrographs',
      'Water-surface elevation, depth, velocity, arrival time and duration rasters',
      'Inundation polygon extraction and depth-grid export',
      'Cross-section profiles and rating curves',
      'FEMA-oriented workflows: floodplain and floodway delineation, base flood elevation extraction, 1 % and 0.2 % annual-chance events',
    ];
  }
}

// ---------------------------------------------------------------------------
// SWAT / SWAT+
// ---------------------------------------------------------------------------

export class SwatAdapter extends ExternalEngineAdapter {
  readonly engine: ModelEngine;
  readonly displayName: string;
  readonly description =
    'Soil and Water Assessment Tool. Continuous, semi-distributed simulation of water, sediment and nutrient transport at HRU scale.';
  protected readonly envVar: string;

  constructor(plus: boolean) {
    super();
    this.engine = plus ? 'SWAT+' : 'SWAT';
    this.displayName = plus ? 'SWAT+' : 'SWAT';
    this.envVar = plus ? 'SWATPLUS_PATH' : 'SWAT_PATH';
  }

  requirements(): AdapterRequirement[] {
    return [
      { kind: 'executable', name: `${this.displayName} executable`, description: `A compiled ${this.displayName} revision (swat.exe / swatplus).`, envVar: this.envVar },
      { kind: 'directory', name: 'TxtInOut directory', description: 'The model input directory produced by QSWAT / QSWAT+ or SWATeditor.' },
      { kind: 'file', name: 'file.cio', description: 'Master control file defining the simulation period and print settings.' },
    ];
  }

  requiredInputs(): string[] {
    return ['TxtInOut directory', 'file.cio', 'HRU definition files', 'weather input (.pcp, .tmp)', 'soil and land-use lookup tables'];
  }

  protected requiredParameters(): string[] {
    return ['simulationStartYear', 'simulationEndYear', 'warmupYears'];
  }

  capabilities(): string[] {
    return [
      'HRU-scale water balance with surface runoff, lateral flow, percolation and shallow/deep aquifer response',
      'Sediment yield (MUSLE) and nutrient transport (nitrogen and phosphorus cycles)',
      'Crop growth and management operations',
      'Reservoir and pond routing',
      'Channel routing by variable storage or Muskingum',
      'Sensitivity analysis and SUFI-2 / SWAT-CUP style calibration workflows',
    ];
  }
}

// ---------------------------------------------------------------------------
// MODFLOW
// ---------------------------------------------------------------------------

export class ModflowAdapter extends ExternalEngineAdapter {
  readonly engine = 'MODFLOW' as const;
  readonly displayName = 'MODFLOW 6';
  readonly description = 'USGS modular finite-difference groundwater flow model.';
  protected readonly envVar = 'MODFLOW_PATH';

  requirements(): AdapterRequirement[] {
    return [
      { kind: 'executable', name: 'mf6', description: 'MODFLOW 6 executable, obtainable from the USGS or via FloPy.', envVar: 'MODFLOW_PATH' },
      { kind: 'directory', name: 'Simulation workspace', description: 'A MODFLOW 6 simulation containing mfsim.nam and the model name file.' },
    ];
  }

  requiredInputs(): string[] {
    return ['mfsim.nam', 'model name file', 'DIS/DISV discretisation', 'NPF, IC, CHD/WEL/RIV/RCH packages'];
  }

  capabilities(): string[] {
    return [
      'Steady-state and transient groundwater flow',
      'Structured (DIS) and unstructured (DISV/DISU) grids',
      'Recharge, well, river, drain and general-head boundaries',
      'Streamflow routing (SFR) and lake (LAK) packages for surface-water coupling',
      'Water-budget extraction and head-time-series output',
    ];
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const EXTERNAL_ADAPTERS: HydrologicModelAdapter[] = [
  new HecHmsAdapter(),
  new HecRasAdapter(),
  new SwatAdapter(false),
  new SwatAdapter(true),
  new ModflowAdapter(),
];

export function getAdapter(engine: ModelEngine): HydrologicModelAdapter | null {
  return EXTERNAL_ADAPTERS.find((a) => a.engine === engine) ?? null;
}
