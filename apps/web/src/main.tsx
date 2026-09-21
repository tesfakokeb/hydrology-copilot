import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { AppShell } from '@/layouts/AppShell';
import { Copilot } from '@/pages/Copilot';
import { Dashboard } from '@/pages/Dashboard';
import { DataExplorer, Forecasts, GisMaps } from '@/pages/Data';
import { Drought } from '@/pages/Drought';
import { FloodForecasting, FloodRisk } from '@/pages/Flood';
import { LandingPage } from '@/pages/LandingPage';
import { Login } from '@/pages/Login';
import { WatershedModeling } from '@/pages/Modeling';
import { Streamflow } from '@/pages/Streamflow';
import { WaterDemand, WaterSupply } from '@/pages/Water';
import { WaterQuality } from '@/pages/WaterQuality';
import { ModelRuns, Projects, Reports, Settings } from '@/pages/Workspace';
import { setUnauthenticatedHandler } from '@/services/api';
import { useApp } from '@/stores/app';
import { Spinner } from '@/components/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Scientific results are deterministic for a given record, so a short
      // stale time avoids recomputing an identical analysis on every mount
      // while still refetching when the user changes anything meaningful.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Root() {
  const { user, authChecked, bootstrap, logout } = useApp();

  useEffect(() => {
    setUnauthenticatedHandler(logout);
    void bootstrap();
  }, [bootstrap, logout]);

  if (!authChecked) {
    return (
      <div className="grid min-h-screen place-items-center bg-ink-50">
        <div className="flex items-center gap-2 text-sm text-ink-600">
          <Spinner className="h-4 w-4" />
          Starting Hydrology Copilot…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/landing" element={<LandingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="copilot" element={<Copilot />} />
        <Route path="streamflow" element={<Streamflow />} />
        <Route path="drought" element={<Drought />} />
        <Route path="water-quality" element={<WaterQuality />} />
        <Route path="watershed-modeling" element={<WatershedModeling />} />
        <Route path="flood-risk" element={<FloodRisk />} />
        <Route path="flood-forecasting" element={<FloodForecasting />} />
        <Route path="water-supply" element={<WaterSupply />} />
        <Route path="water-demand" element={<WaterDemand />} />
        <Route path="gis" element={<GisMaps />} />
        <Route path="data-explorer" element={<DataExplorer />} />
        <Route path="model-runs" element={<ModelRuns />} />
        <Route path="forecasts" element={<Forecasts />} />
        <Route path="reports" element={<Reports />} />
        <Route path="projects" element={<Projects />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="*"
          element={
            <div className="rounded-lg border border-dashed border-ink-300 bg-white px-6 py-10 text-center">
              <p className="text-sm font-medium text-ink-800">Page not found</p>
              <p className="mt-1 text-xs text-ink-500">Use the navigation on the left.</p>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
