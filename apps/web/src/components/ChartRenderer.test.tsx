import type { ChartSpec } from '@hydro/shared-types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartRenderer } from './ChartRenderer';

const spec: ChartSpec = {
  id: 'c1',
  kind: 'hydrograph',
  title: 'Daily discharge',
  subtitle: 'Point of Rocks',
  xLabel: 'Date',
  yLabel: 'Discharge',
  unit: 'm3/s',
  series: [{ key: 'q', label: 'Observed', kind: 'observed', color: '#0f6fb8' }],
  data: [
    { t: '2026-01-01', q: 120 },
    { t: '2026-01-02', q: 135 },
    { t: '2026-01-03', q: null },
  ],
  annotations: [{ kind: 'hline', value: 500, label: 'Flood threshold' }],
  caption: 'Observed daily mean discharge. Gaps are breaks, not interpolated.',
};

describe('ChartRenderer', () => {
  it('renders the title, subtitle and caption supplied by the API', () => {
    render(<ChartRenderer spec={spec} />);
    expect(screen.getByText('Daily discharge')).toBeInTheDocument();
    expect(screen.getByText('Point of Rocks')).toBeInTheDocument();
    expect(screen.getByText(/Gaps are breaks, not interpolated/)).toBeInTheDocument();
  });

  it('offers a log-scale toggle for hydrographs, where it is diagnostically useful', () => {
    render(<ChartRenderer spec={spec} />);
    expect(screen.getByRole('button', { name: /log scale/i })).toBeInTheDocument();
  });

  it('does not offer a log toggle for a bar chart', () => {
    render(<ChartRenderer spec={{ ...spec, kind: 'bar' }} />);
    expect(screen.queryByRole('button', { name: /log scale/i })).toBeNull();
  });

  it('says so rather than drawing an empty axis when there is nothing to plot', () => {
    render(<ChartRenderer spec={{ ...spec, data: [] }} />);
    expect(screen.getByText(/No data to plot/i)).toBeInTheDocument();
  });
});
