import type { ProvenanceRecord } from '@hydro/shared-types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProvenancePanel } from './ProvenancePanel';

const record: ProvenanceRecord = {
  id: 'prov-1',
  runId: 'run-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  userId: 'u1',
  projectId: 'p1',
  toolName: 'calculate_spi',
  toolVersion: '1.0.0',
  dataSources: [
    {
      datasetId: null,
      name: 'Basin-average precipitation',
      source: 'Hydrology Copilot synthetic demonstration generator',
      version: '1.0.0',
      isSynthetic: true,
      temporalCoverage: { start: '1996-08-31', end: '2026-08-31' },
      spatialExtent: 'Potomac Demonstration Watershed',
      variables: ['precipitation'],
      units: { precipitation: 'mm' },
      recordCount: 10958,
      missingPct: 0,
      accessedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  processingSteps: [
    { order: 1, operation: 'aggregate', description: 'Aggregated daily values to monthly totals.', parameters: {}, durationMs: 12 },
  ],
  methods: [
    { name: 'SPI-3', kind: 'index', implementation: '@hydro/hydrology-core calculateSpi', reference: 'McKee et al. 1993', parameters: { timescaleMonths: 3 } },
  ],
  temporalCoverage: { start: '1996-08', end: '2026-08' },
  spatialExtent: 'Potomac Demonstration Watershed',
  assumptions: ['The monthly series is stationary over the calibration period.'],
  limitations: ['Provisional where fewer than 30 years are available.'],
  uncertainty: { sources: ['Distribution-fitting uncertainty.'], interval: null, validationMetrics: null, qualitative: 'moderate' },
  inputHash: 'abc123',
  softwareVersions: { node: 'v22' },
};

describe('ProvenancePanel', () => {
  it('summarises the record without expanding', () => {
    render(<ProvenancePanel record={record} />);
    expect(screen.getByText('calculate_spi')).toBeInTheDocument();
    expect(screen.getByText(/1 source · 1 method · 1 steps/)).toBeInTheDocument();
  });

  it('flags synthetic inputs prominently', () => {
    render(<ProvenancePanel record={record} />);
    expect(screen.getByText('Synthetic input')).toBeInTheDocument();
  });

  it('reveals data, methods, assumptions, limitations and the input hash when expanded', async () => {
    const user = userEvent.setup();
    render(<ProvenancePanel record={record} />);
    await user.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Basin-average precipitation')).toBeInTheDocument();
    expect(screen.getByText(/McKee et al. 1993/)).toBeInTheDocument();
    expect(screen.getByText(/stationary over the calibration period/)).toBeInTheDocument();
    expect(screen.getByText(/Provisional where fewer than 30 years/)).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });
});
