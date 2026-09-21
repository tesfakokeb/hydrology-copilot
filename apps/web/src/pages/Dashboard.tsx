import type { KpiCard } from '@hydro/shared-types';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertList, KpiGroup } from '@/components/KpiCards';
import { ChartRenderer } from '@/components/ChartRenderer';
import { Card, ErrorState, LoadingPanel, PageHeader, StatusPill, SyntheticBadge } from '@/components/ui';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';

const GROUP_ORDER: KpiCard['group'][] = ['hydrology', 'flood', 'drought', 'water_quality', 'supply', 'demand'];

export function Dashboard() {
  const { projectId, watersheds } = useApp();
  const dashboard = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => api.dashboard(projectId ?? undefined),
    enabled: Boolean(projectId),
  });
  const forecast = useQuery({
    queryKey: ['dashboard-forecast', projectId],
    queryFn: () => api.forecast({ horizonDays: 14 }),
    enabled: Boolean(projectId),
  });
  const drought = useQuery({ queryKey: ['dashboard-drought', projectId], queryFn: api.drought, enabled: Boolean(projectId) });

  const watershed = watersheds[0];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          watershed
            ? `${watershed.name} · ${watershed.areaKm2.toLocaleString()} km² · every card below is computed from the record at request time.`
            : 'Operational overview of the selected watershed.'
        }
        actions={
          <>
            <SyntheticBadge />
            {dashboard.data && (
              <StatusPill status="info" dot={false}>
                as of {new Date(dashboard.data.asOf).toLocaleString()}
              </StatusPill>
            )}
          </>
        }
      />

      {dashboard.isLoading && <LoadingPanel label="Computing dashboard indicators…" lines={6} />}
      {dashboard.error && <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />}

      {dashboard.data && (
        <div className="space-y-6">
          {GROUP_ORDER.map((g) => (
            <KpiGroup key={g} group={g} kpis={dashboard.data.kpis.filter((k) => k.group === g)} />
          ))}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card
              title="AI-generated alerts"
              subtitle="Threshold rules evaluated against the current record"
              className="xl:col-span-1"
            >
              <AlertList alerts={dashboard.data.alerts} />
            </Card>

            <Card
              title="Streamflow outlook"
              subtitle="14-day probabilistic forecast with validation skill"
              className="xl:col-span-2"
              actions={
                <Link to="/forecasts" className="btn btn-secondary">
                  Open forecasting
                </Link>
              }
            >
              {forecast.isLoading && <LoadingPanel label="Fitting the forecast model…" />}
              {forecast.error && <ErrorState error={forecast.error} />}
              {forecast.data?.charts[0] && <ChartRenderer spec={forecast.data.charts[0]} height={260} />}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card
              title="Drought indices"
              subtitle="Meteorological, agricultural-proxy and hydrological signals"
              actions={
                <Link to="/drought" className="btn btn-secondary">
                  Open drought
                </Link>
              }
            >
              {drought.isLoading && <LoadingPanel label="Computing drought indices…" />}
              {drought.error && <ErrorState error={drought.error} />}
              {drought.data?.charts[0] && <ChartRenderer spec={drought.data.charts[0]} height={240} />}
            </Card>

            <Card title="What this dashboard is, and is not" subtitle="Read before using any figure above">
              <ul className="space-y-2 text-xs leading-relaxed text-ink-700">
                <li>
                  <strong>Every card is computed, not cached.</strong> Each request refits the seasonal climatology, the
                  drought indices and the forecast against the current record.
                </li>
                <li>
                  <strong>A card with no value means the input was unavailable</strong>, not that the value is zero. Cards
                  report a status of “unknown” rather than substituting a placeholder.
                </li>
                <li>
                  <strong>Flood thresholds here are statistical proxies</strong> derived from the annual peak record. They
                  are not surveyed flood stages, and not National Weather Service flood categories.
                </li>
                <li>
                  <strong>Drought categories follow US Drought Monitor breakpoints</strong> applied to standardised indices.
                  They are not a US Drought Monitor determination, which is a convergence-of-evidence product with human
                  authors.
                </li>
                <li>
                  <strong>Water-quality screening values are general benchmarks</strong>, not the applicable standard for any
                  specific waterbody.
                </li>
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
