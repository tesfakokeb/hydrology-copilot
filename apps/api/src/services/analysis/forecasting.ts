import {
  annualPeaks,
  bankfullProxy,
  flowExceededPercent,
  forecast as baselineForecast,
  logPearson3,
  METHOD_REFERENCES,
  thresholdExceedanceProbability,
} from '@hydro/hydrology-core';
import type { ForecastModelKind, ForecastResult, ForecastThreshold, ToolResult } from '@hydro/shared-types';
import { ScienceClient } from '../science-client.js';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, fmt, insufficient, lineChart, ok, q, type ToolContext } from './common.js';
import { loadFlow } from './streamflow.js';

const ML_MODELS: ForecastModelKind[] = ['random_forest', 'xgboost', 'lstm', 'gru', 'tft'];

/** forecast_streamflow */
export async function forecastStreamflow(
  ctx: ToolContext,
  args: { stationId?: string; horizonDays?: number; model?: ForecastModelKind; seed?: number },
): Promise<ToolResult> {
  const horizon = Math.min(Math.max(args.horizonDays ?? 7, 1), 180);
  const requested = args.model ?? 'xgboost';
  const p = new ProvenanceBuilder('forecast_streamflow', { projectId: ctx.projectId, userId: ctx.userId });

  const { station, series } = await loadFlow(ctx, args.stationId);
  const precip = await ctx.db.getSeries({ variable: 'precipitation' });
  if (series.points.length < 365) {
    return insufficient(p, `Only ${series.points.length} daily discharge values are available; at least one year is required to fit a forecast model.`, args);
  }
  ctx.emit?.('Retrieved training record', 'ok', `${series.points.length} daily values`);

  const dates = series.points.map((pt) => pt.t);
  const values = series.points.map((pt) => pt.v);
  const precipByDate = new Map(precip.points.map((pt) => [pt.t, pt.v]));
  const precipAligned = dates.map((d) => precipByDate.get(d) ?? null);

  const warnings: string[] = [];
  let modelUsed: ForecastModelKind = requested;
  let library = '@hydro/hydrology-core (TypeScript baseline)';
  let hyperparameters: Record<string, unknown> = {};
  let result: {
    points: ForecastResult['points'];
    metrics: ForecastResult['metrics'];
    featureImportance: { feature: string; importance: number }[];
    trainingPeriod: { start: string; end: string };
    validationPeriod: { start: string; end: string } | null;
    limitations: string[];
  };

  const science = new ScienceClient(ctx.scienceServiceUrl);
  const remote = ML_MODELS.includes(requested)
    ? await science.forecast({ dates, values, precipitation: precipAligned, model: requested, horizonDays: horizon, seed: args.seed ?? 20260901 })
    : null;

  if (remote) {
    ctx.emit?.(`Trained ${requested} in the Python scientific service`, 'ok', remote.library);
    modelUsed = remote.model;
    library = remote.library;
    hyperparameters = remote.hyperparameters;
    result = {
      points: remote.points,
      metrics: remote.metrics,
      featureImportance: remote.featureImportance,
      trainingPeriod: remote.trainingPeriod,
      validationPeriod: remote.validationPeriod,
      limitations: remote.limitations,
    };
    warnings.push(...remote.warnings);
  } else {
    if (ML_MODELS.includes(requested)) {
      warnings.push(
        `The ${requested} model is hosted by the Python scientific service, which is ${science.configured ? 'not responding' : 'not configured'}. ` +
          'The autoregressive baseline was used instead — this is a different model with different skill, and the metrics below are the baseline\'s, not the requested model\'s.',
      );
      ctx.emit?.(`${requested} unavailable — fell back to the autoregressive baseline`, 'warn', science.configured ? 'science service not responding' : 'SCIENCE_SERVICE_URL not set');
    }
    const baseline = baselineForecast(
      { dates, values, precipitation: precipAligned },
      { model: ML_MODELS.includes(requested) ? 'arima' : requested, horizonDays: horizon, seed: args.seed ?? 20260901, ensembleSize: 200 },
    );
    if (baseline.points.length === 0) {
      return insufficient(p, baseline.warnings[0] ?? 'The forecast model could not be fitted.', args);
    }
    modelUsed = baseline.model;
    hyperparameters = { lags: 5, precipLags: 5, transform: 'log anomaly vs day-of-year climatology', ensembleSize: 200 };
    result = {
      points: baseline.points,
      metrics: baseline.metrics,
      featureImportance: baseline.featureImportance,
      trainingPeriod: baseline.trainingPeriod,
      validationPeriod: baseline.validationPeriod,
      limitations: baseline.limitations,
    };
    warnings.push(...baseline.warnings);
    ctx.emit?.('Fitted the autoregressive baseline and validated on held-out data', 'ok', `NSE ${baseline.metrics.nse?.toFixed(3) ?? 'n/a'}`);
  }

  // Thresholds against which the forecast is assessed.
  const peaks = annualPeaks(dates, values);
  const bank = bankfullProxy(peaks);
  const ff = logPearson3(peaks, 'm3/s');
  const q2 = ff.quantiles.find((x) => x.returnPeriodYears === 2)?.discharge ?? null;
  const lowFlow = flowExceededPercent(values, 95);

  const thresholds: ForecastThreshold[] = [];
  const addThreshold = (name: string, value: number | null, kind: ForecastThreshold['kind']) => {
    if (value === null || !Number.isFinite(value)) return;
    const ex = thresholdExceedanceProbability(result.points, value);
    thresholds.push({
      name,
      value,
      unit: series.unit as never,
      kind,
      exceedanceProbability: ex.overall,
      firstExceedance: ex.byDay.find((d) => d.p > 0.5)?.t ?? null,
    });
  };
  addThreshold('Bankfull proxy (1.5-year peak)', bank.discharge, 'bankfull');
  addThreshold('2-year flood (LP3)', q2, 'flood');
  addThreshold('Action stage proxy (80 % of bankfull)', bank.discharge ? bank.discharge * 0.8 : null, 'action');
  addThreshold('Low-flow threshold (Q95)', lowFlow, 'low_flow');
  ctx.emit?.('Evaluated threshold exceedance probabilities', 'ok', `${thresholds.length} thresholds`);

  const isBaseline = library.includes('TypeScript');

  p.source(demoSource(`Daily discharge — ${station?.name}`, ['discharge', 'precipitation'], { discharge: series.unit, precipitation: 'mm' }, { start: dates[0], end: dates[dates.length - 1] }, dates.length, station?.name ?? ''))
    .method({
      name: `${modelUsed} streamflow forecast`,
      kind: 'ml_model',
      implementation: library,
      reference: isBaseline ? 'Linear autoregression on log-flow anomalies with precipitation lags' : null,
      parameters: { horizonDays: horizon, ...hyperparameters },
    })
    .method({ name: 'Log-Pearson III flood frequency (for thresholds)', kind: 'statistic', implementation: '@hydro/hydrology-core logPearson3', reference: METHOD_REFERENCES.lp3, parameters: {} })
    .step('assemble', 'Assembled the target series and precipitation predictors on a common daily index.', {})
    .step('split', 'Held out the most recent quarter of the record for validation; the model never saw it during fitting.', { validationFraction: 0.25 })
    .step('fit', `Fitted ${modelUsed}.`, hyperparameters)
    .step('validate', 'Evaluated NSE, KGE, RMSE, MAE, PBIAS and R² on the held-out period.', {})
    .step('propagate', 'Generated an ensemble by resampling training residuals through the forecast recursion.', { ensembleSize: 200 })
    .coverage(result.trainingPeriod.start, result.points[result.points.length - 1].t)
    .extent(station?.name ?? null)
    .assume(
      'No forecast precipitation is ingested. Beyond the last observation the model assumes no further rainfall, which biases the forecast low during storms.',
      'Forecast-day residuals are treated as independent when combining daily exceedance probabilities into an overall probability.',
    )
    .limit(...result.limitations)
    .uncertain({
      sources: [
        'Model structural error, quantified only indirectly through validation skill.',
        'No meteorological forcing uncertainty, because no forecast precipitation is used.',
        'Residual resampling assumes the error distribution during the forecast resembles the training period.',
      ],
      interval: { level: 0.95, lower: result.points[0].lower95 ?? null, upper: result.points[0].upper95 ?? null, unit: series.unit },
      validationMetrics: { nse: result.metrics.nse, kge: result.metrics.kge, rmse: result.metrics.rmse, pbias: result.metrics.pbias },
      qualitative: (result.metrics.nse ?? 0) > 0.7 ? 'moderate' : 'high',
    });

  const history = series.points.slice(-90);
  const chartData = [
    ...history.map((pt) => ({ t: pt.t, observed: pt.v, forecast: null as number | null, lower95: null as number | null, upper95: null as number | null, lower80: null as number | null, upper80: null as number | null })),
    ...result.points.map((pt) => ({ t: pt.t, observed: null as number | null, forecast: pt.mean, lower95: pt.lower95 ?? null, upper95: pt.upper95 ?? null, lower80: pt.lower80 ?? null, upper80: pt.upper80 ?? null })),
  ];

  const peakForecast = result.points.reduce((a, b) => (b.mean > a.mean ? b : a), result.points[0]);

  return ok(
    `${horizon}-day ${modelUsed} forecast for ${station?.name ?? 'the outlet gauge'}: peak of ${fmt(peakForecast.mean, series.unit)} on ${peakForecast.t}. ` +
      `Validation skill on held-out data: NSE ${result.metrics.nse?.toFixed(3) ?? 'n/a'}, KGE ${result.metrics.kge?.toFixed(3) ?? 'n/a'}, PBIAS ${result.metrics.pbias?.toFixed(1) ?? 'n/a'} %.`,
    {
      data: {
        forecast: {
          variable: 'discharge',
          unit: series.unit,
          stationId: station?.id ?? null,
          model: modelUsed,
          requestedModel: requested,
          library,
          issuedAt: new Date().toISOString(),
          horizonDays: horizon,
          trainingPeriod: result.trainingPeriod,
          validationPeriod: result.validationPeriod,
          metrics: result.metrics,
          featureImportance: result.featureImportance,
          points: result.points,
          thresholds,
          limitations: result.limitations,
          hyperparameters,
        } satisfies Partial<ForecastResult> & Record<string, unknown>,
        history: history.map((pt) => ({ t: pt.t, v: pt.v })),
        floodFrequency: ff,
      },
      metrics: {
        ...(result.metrics as unknown as Record<string, number | null>),
        peakForecast: peakForecast.mean,
        exceedanceProbabilityBankfull: thresholds.find((t) => t.kind === 'bankfull')?.exceedanceProbability ?? null,
      },
      quantities: {
        peakForecast: q(peakForecast.mean, series.unit),
        currentObserved: q(history[history.length - 1]?.v ?? null, series.unit),
      },
      charts: [
        lineChart({
          kind: 'forecast',
          title: `${horizon}-day streamflow forecast — ${station?.name}`,
          subtitle: `${modelUsed} · validation NSE ${result.metrics.nse?.toFixed(3) ?? 'n/a'}`,
          xLabel: 'Date',
          yLabel: 'Discharge',
          unit: series.unit,
          series: [
            { key: 'observed', label: 'Observed', kind: 'observed', color: CHART_COLORS.observed },
            { key: 'forecast', label: 'Forecast (median)', kind: 'forecast', color: CHART_COLORS.forecast },
            { key: 'upper95', label: '95 % interval', kind: 'band', color: CHART_COLORS.band },
            { key: 'lower95', label: '95 % interval', kind: 'band', color: CHART_COLORS.band },
          ],
          data: chartData,
          annotations: thresholds
            .filter((t) => t.kind !== 'low_flow')
            .map((t) => ({ kind: 'hline' as const, value: t.value, label: t.name, color: CHART_COLORS.threshold })),
          caption: `Last 90 days of observations followed by the forecast with 80 % and 95 % prediction intervals. Intervals come from resampled validation residuals, not from a formal predictive distribution.`,
        }),
      ],
      warnings,
      provenance: p.build({ ...args, horizon }),
    },
  );
}
