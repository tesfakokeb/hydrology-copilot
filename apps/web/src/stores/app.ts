import type { Project, User, Watershed } from '@hydro/shared-types';
import { create } from 'zustand';
import { api, getAccessToken, setTokens } from '@/services/api';

export interface DateRange {
  start: string | null;
  end: string | null;
  label: string;
}

export const PUBLIC_USER: User = {
  id: 'public',
  email: 'guest@hydrologycopilot.org',
  fullName: 'Guest Analyst',
  organization: 'Hydrology Copilot',
  role: 'viewer',
  createdAt: new Date().toISOString(),
};

export const DATE_PRESETS: DateRange[] = [
  { start: null, end: null, label: 'Full record' },
  { start: isoDaysAgo(365), end: null, label: 'Last 1 year' },
  { start: isoDaysAgo(365 * 5), end: null, label: 'Last 5 years' },
  { start: isoDaysAgo(365 * 10), end: null, label: 'Last 10 years' },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
}

interface AppState {
  user: User | null;
  authChecked: boolean;
  projects: Project[];
  projectId: string | null;
  watersheds: Watershed[];
  watershedId: string | null;
  dateRange: DateRange;
  unitSystem: 'SI' | 'US';
  toasts: Toast[];

  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setProject: (id: string) => Promise<void>;
  setWatershed: (id: string) => void;
  setDateRange: (r: DateRange) => void;
  setUnitSystem: (s: 'SI' | 'US') => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  user: null,
  authChecked: false,
  projects: [],
  projectId: null,
  watersheds: [],
  watershedId: null,
  dateRange: DATE_PRESETS[0],
  unitSystem: (localStorage.getItem('hydro.unitSystem') as 'SI' | 'US') ?? 'SI',
  toasts: [],

  async bootstrap() {
    if (!getAccessToken()) {
      set({ authChecked: true, user: PUBLIC_USER, projects: [], projectId: null, watersheds: [], watershedId: null });
      return;
    }
    try {
      const user = await api.me();
      if (!user) {
        set({ authChecked: true, user: PUBLIC_USER, projects: [], projectId: null, watersheds: [], watershedId: null });
        return;
      }
      const projects = await api.projects();
      const projectId = localStorage.getItem('hydro.projectId') ?? projects[0]?.id ?? null;
      const watersheds = projectId ? await api.watersheds() : [];
      set({
        user,
        projects,
        projectId,
        watersheds,
        watershedId: watersheds[0]?.id ?? null,
        unitSystem: projects.find((p) => p.id === projectId)?.unitSystem ?? get().unitSystem,
        authChecked: true,
      });
    } catch {
      set({ authChecked: true, user: PUBLIC_USER, projects: [], projectId: null, watersheds: [], watershedId: null });
    }
  },

  async login(email, password) {
    const { tokens, user } = await api.login(email, password);
    setTokens(tokens);
    set({ user });
    await get().bootstrap();
  },

  logout() {
    setTokens(null);
    localStorage.removeItem('hydro.projectId');
    set({ user: PUBLIC_USER, projects: [], projectId: null, watersheds: [], watershedId: null });
  },

  async setProject(id) {
    localStorage.setItem('hydro.projectId', id);
    const watersheds = await api.watersheds();
    const project = get().projects.find((p) => p.id === id);
    set({
      projectId: id,
      watersheds,
      watershedId: project?.defaultWatershedId ?? watersheds[0]?.id ?? null,
      unitSystem: project?.unitSystem ?? get().unitSystem,
    });
  },

  setWatershed(id) {
    set({ watershedId: id });
  },

  setDateRange(dateRange) {
    set({ dateRange });
  },

  setUnitSystem(unitSystem) {
    localStorage.setItem('hydro.unitSystem', unitSystem);
    set({ unitSystem });
  },

  pushToast(t) {
    const id = Math.random().toString(36).slice(2, 10);
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 12_000 : 6_000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
