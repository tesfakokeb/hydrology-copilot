import type { SystemStatus } from '@hydro/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '@/services/api';
import { DATE_PRESETS, useApp } from '@/stores/app';
import { StatusPill, SyntheticBadge, Toasts, type StatusKind } from '@/components/ui';

/** The 17 sections of §4, grouped so the sidebar reads as a workflow. */
const NAV: { group: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    group: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: '▦' },
      { to: '/copilot', label: 'AI Copilot', icon: '✦' },
    ],
  },
  {
    group: 'Analysis',
    items: [
      { to: '/streamflow', label: 'Streamflow', icon: '∿' },
      { to: '/drought', label: 'Drought', icon: '◷' },
      { to: '/water-quality', label: 'Water Quality', icon: '◈' },
      { to: '/watershed-modeling', label: 'Watershed Modeling', icon: '⛰' },
    ],
  },
  {
    group: 'Flood',
    items: [
      { to: '/flood-risk', label: 'Flood Risk', icon: '⚠' },
      { to: '/flood-forecasting', label: 'Flood Forecasting', icon: '⧗' },
    ],
  },
  {
    group: 'Water management',
    items: [
      { to: '/water-supply', label: 'Water Supply', icon: '▤' },
      { to: '/water-demand', label: 'Water Demand', icon: '▣' },
    ],
  },
  {
    group: 'Data',
    items: [
      { to: '/gis', label: 'GIS & Maps', icon: '◉' },
      { to: '/data-explorer', label: 'Data Explorer', icon: '⌸' },
      { to: '/model-runs', label: 'Model Runs', icon: '⚙' },
      { to: '/forecasts', label: 'Forecasts', icon: '↗' },
      { to: '/reports', label: 'Reports', icon: '▤' },
    ],
  },
  {
    group: 'Workspace',
    items: [
      { to: '/projects', label: 'Projects', icon: '▭' },
      { to: '/settings', label: 'Settings', icon: '⚒' },
    ],
  },
];

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 60_000 });

  return (
    <div className="flex h-full min-h-screen bg-ink-50">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar status={status} />
        <main className="min-w-0 flex-1 overflow-y-auto px-5 py-5">
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <nav
      className={`flex shrink-0 flex-col border-r border-ink-800 bg-ink-900 text-ink-200 transition-[width] ${
        collapsed ? 'w-14' : 'w-60'
      }`}
      aria-label="Primary"
    >
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-hydro-600 text-sm font-bold text-white" aria-hidden>
          HC
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">Hydrology Copilot</p>
            <p className="truncate text-2xs text-ink-400">Water Resources Intelligence</p>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {NAV.map((section) => (
          <div key={section.group} className="mb-1">
            {!collapsed && (
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{section.group}</p>
            )}
            <ul>
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
                        isActive
                          ? 'border-l-2 border-hydro-400 bg-ink-800 pl-[10px] font-medium text-white'
                          : 'border-l-2 border-transparent pl-[10px] text-ink-300 hover:bg-ink-800/60 hover:text-white'
                      }`
                    }
                  >
                    <span className="w-4 shrink-0 text-center text-ink-400" aria-hidden>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onToggle}
        className="border-t border-ink-800 px-3 py-2 text-left text-2xs text-ink-400 hover:text-white"
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
      >
        {collapsed ? '»' : '« Collapse'}
      </button>
    </nav>
  );
}

const STATUS_MAP: Record<string, StatusKind> = {
  online: 'normal',
  degraded: 'watch',
  offline: 'critical',
  not_configured: 'unknown',
};

function TopBar({ status }: { status?: SystemStatus }) {
  const { projects, projectId, setProject, watersheds, watershedId, setWatershed, dateRange, setDateRange, user, logout } = useApp();
  const [showSources, setShowSources] = useState(false);
  const location = useLocation();
  const project = projects.find((p) => p.id === projectId);

  return (
    <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <label className="sr-only" htmlFor="project-select">
          Project
        </label>
        <select
          id="project-select"
          className="input !w-auto !py-1 text-xs"
          value={projectId ?? ''}
          onChange={(e) => void setProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="watershed-select">
          Watershed
        </label>
        <select
          id="watershed-select"
          className="input !w-auto !py-1 text-xs"
          value={watershedId ?? ''}
          onChange={(e) => setWatershed(e.target.value)}
        >
          {watersheds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="range-select">
          Date range
        </label>
        <select
          id="range-select"
          className="input !w-auto !py-1 text-xs"
          value={dateRange.label}
          onChange={(e) => setDateRange(DATE_PRESETS.find((d) => d.label === e.target.value) ?? DATE_PRESETS[0])}
        >
          {DATE_PRESETS.map((d) => (
            <option key={d.label} value={d.label}>
              {d.label}
            </option>
          ))}
        </select>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SyntheticBadge compact />

          <button
            type="button"
            className="chip border-ink-200 bg-white text-ink-700 hover:bg-ink-50"
            onClick={() => setShowSources((v) => !v)}
            aria-expanded={showSources}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status?.database === 'online' && status?.scienceService === 'online' ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              aria-hidden
            />
            Data sources
          </button>

          <StatusPill status={status?.copilotEngine === 'anthropic' ? 'normal' : 'info'}>
            Copilot: {status?.copilotEngine === 'anthropic' ? 'model' : 'deterministic router'}
          </StatusPill>

          <div className="flex items-center gap-2 border-l border-ink-200 pl-2">
            <div className="text-right">
              <p className="text-2xs font-medium leading-tight text-ink-800">{user?.fullName ?? '—'}</p>
              <p className="text-[10px] leading-tight text-ink-500">{user?.role ?? ''}</p>
            </div>
            <button type="button" className="btn btn-ghost !px-2" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      {showSources && status && (
        <div className="border-t border-ink-200 bg-ink-50 px-4 py-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {status.sources.map((s) => (
              <div key={s.id} className="rounded-md border border-ink-200 bg-white px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-medium text-ink-800">{s.name}</p>
                  <StatusPill status={STATUS_MAP[s.status] ?? 'unknown'}>{s.status.replace('_', ' ')}</StatusPill>
                </div>
                <p className="mt-1 text-2xs leading-snug text-ink-500">{s.detail}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-2xs text-ink-500">
            API v{status.version} · project “{project?.name}” · unit system {project?.unitSystem ?? 'SI'} · route {location.pathname}
          </p>
        </div>
      )}
    </header>
  );
}
