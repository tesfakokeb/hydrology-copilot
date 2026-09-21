import { Link } from 'react-router-dom';

const featureCards = [
  'Drought analysis and monitoring',
  'Forecasts and probabilistic modelling',
  'Watershed, water quality and GIS insights',
  'Transparent provenance for every result',
];

export function LandingPage() {
  return (
    <div className="min-h-screen bg-ink-50 text-ink-900">
      <header className="border-b border-ink-200 bg-white/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded bg-hydro-600 font-bold text-white" aria-hidden>
              HC
            </span>
            <div>
              <p className="text-lg font-semibold">Hydrology Copilot</p>
              <p className="text-xs text-ink-500">AI-Powered Water Resources Intelligence</p>
            </div>
          </div>

          <Link to="/login" className="btn btn-primary">
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <span className="chip border-hydro-200 bg-hydro-50 text-hydro-800">Decision support platform</span>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight text-ink-900 md:text-5xl">
              Analyze. Forecast. Model. Manage water.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-ink-600">
              Hydrology Copilot brings together hydrologic science, forecasting, GIS, and transparent provenance in a single
              workspace for water resources teams and analysts.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/login" className="btn btn-primary">
                Open sign in
              </Link>
              <Link to="/login" className="btn btn-secondary">
                Use demo account
              </Link>
            </div>

            <p className="mt-6 text-sm text-ink-500">
              Demo access: <span className="font-mono text-ink-700">demo@hydrologycopilot.org / demo1234</span>
            </p>
          </div>

          <div className="grid gap-4">
            {featureCards.map((feature) => (
              <div key={feature} className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-hydro-100 text-hydro-700" aria-hidden>
                    ✓
                  </span>
                  <p className="text-sm font-medium text-ink-800">{feature}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
