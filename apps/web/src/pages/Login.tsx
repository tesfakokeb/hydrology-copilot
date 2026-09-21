import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';
import { Spinner } from '@/components/ui';

export function Login() {
  const { login } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: demo } = useQuery({ queryKey: ['demo-credentials'], queryFn: api.demoCredentials });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const useDemo = async () => {
    if (!demo?.email || !demo.password) return;
    setEmail(demo.email);
    setPassword(demo.password);
    setBusy(true);
    setError(null);
    try {
      await login(demo.email, demo.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      <div className="hidden flex-col justify-between bg-ink-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded bg-hydro-600 font-bold" aria-hidden>
            HC
          </span>
          <div>
            <p className="text-lg font-semibold">Hydrology Copilot</p>
            <p className="text-xs text-ink-400">AI-Powered Water Resources Intelligence</p>
          </div>
        </div>

        <div className="max-w-lg">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Analyze. Forecast. Model.
            <br />
            Predict. Manage Water.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-ink-300">
            A decision-support platform for hydrologists and water resources engineers. Every number it reports comes from a
            computation over your data, and every computation carries a provenance record naming the datasets, methods,
            assumptions, limitations and uncertainty behind it.
          </p>
          <ul className="mt-6 space-y-2 text-xs text-ink-300">
            {[
              'Streamflow statistics, flow-duration curves, 7Q10 and baseflow separation',
              'SPI, SPEI and streamflow drought indices with US Drought Monitor classification',
              'Log-Pearson III and GEV flood frequency with confidence limits',
              'Probabilistic forecasting, validated on held-out data',
              'GR4J rainfall-runoff modelling with automatic calibration',
              'Adapters for HEC-HMS, HEC-RAS, SWAT, SWAT+ and MODFLOW',
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-hydro-400" aria-hidden>
                  ▸
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-2xs text-ink-500">
          Demonstration data is synthetic. Results are analytical products, not regulatory determinations.
        </p>
      </div>

      <div className="flex items-center justify-center bg-white p-8">
        <div className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <p className="text-lg font-semibold text-ink-900">Hydrology Copilot</p>
            <p className="text-xs text-ink-500">AI-Powered Water Resources Intelligence</p>
          </div>

          <h2 className="text-lg font-semibold text-ink-900">Sign in</h2>
          <p className="mt-1 text-xs text-ink-500">Use your account, or the demonstration account below.</p>

          <form onSubmit={submit} className="mt-5 space-y-3">
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full justify-center !py-2" disabled={busy}>
              {busy && <Spinner />}
              Sign in
            </button>
          </form>

          {demo?.enabled && (
            <div className="mt-5 rounded-md border border-hydro-200 bg-hydro-50 p-3">
              <p className="text-xs font-medium text-hydro-900">Demonstration account</p>
              <p className="mt-1 font-mono text-2xs text-hydro-800">
                {demo.email} · {demo.password}
              </p>
              <button type="button" className="btn btn-secondary mt-2 w-full justify-center" onClick={() => void useDemo()} disabled={busy}>
                Sign in with the demonstration account
              </button>
              <p className="mt-2 text-[10px] leading-snug text-hydro-800">{demo.note}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
