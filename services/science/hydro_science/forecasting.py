"""Machine-learning streamflow and demand forecasting.

Design
------
The predictors are the standard set for short-range hydrologic forecasting:
recent discharge (as a log anomaly against a smoothed day-of-year
climatology), antecedent precipitation over several accumulation windows,
temperature, and a seasonal harmonic. The target is the log anomaly of
discharge, which stabilises variance and guarantees a non-negative forecast
after back-transformation.

Multi-step forecasts are produced recursively: each predicted step becomes an
input to the next. Uncertainty is propagated by resampling validation
residuals through the recursion, giving an ensemble rather than a single
trajectory. Because no quantitative precipitation forecast is ingested, the
model runs on a zero-future-rainfall assumption beyond the last observation —
this is stated in every response and is the dominant limitation of the
forecast at storm-driven lead times.

The train/validation split is strictly chronological. No shuffled
cross-validation is used anywhere in this module: shuffling a hydrologic time
series leaks future information into the training set and produces skill
scores that cannot be reproduced operationally.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .capabilities import CAPABILITIES
from .metrics import evaluate

LOG_EPS = 1e-3
SEASONAL_WINDOW_DAYS = 5


def _to_log(x: np.ndarray) -> np.ndarray:
    return np.log(np.maximum(x, LOG_EPS))


@dataclass
class FeatureSet:
    X: np.ndarray
    y: np.ndarray
    index: np.ndarray
    names: list[str]
    climatology: pd.Series


def smoothed_climatology(dates: pd.DatetimeIndex, values: np.ndarray, window: int = SEASONAL_WINDOW_DAYS) -> pd.Series:
    """Day-of-year mean smoothed over ±`window` days, wrapping at the year end."""
    doy = dates.dayofyear.values
    frame = pd.DataFrame({"doy": doy, "v": values}).dropna()
    raw = frame.groupby("doy")["v"].mean()
    full = raw.reindex(range(1, 367))
    # Circular rolling mean.
    padded = pd.concat([full.iloc[-window:], full, full.iloc[:window]])
    smoothed = padded.rolling(2 * window + 1, center=True, min_periods=1).mean()
    out = smoothed.iloc[window:-window]
    out.index = range(1, 367)
    return out.ffill().bfill()


def build_features(
    dates: pd.DatetimeIndex,
    target: np.ndarray,
    precipitation: np.ndarray | None,
    temperature: np.ndarray | None,
    lags: int = 7,
) -> FeatureSet:
    clim = smoothed_climatology(dates, target)
    clim_series = pd.Series(clim.reindex(dates.dayofyear).values, index=dates)

    df = pd.DataFrame({"q": target}, index=dates)
    df["clim"] = clim_series.values
    df["anom"] = _to_log(df["q"].values) - _to_log(df["clim"].values)

    names: list[str] = []
    for lag in range(1, lags + 1):
        df[f"anom_lag{lag}"] = df["anom"].shift(lag)
        names.append(f"discharge log-anomaly, lag {lag} d")

    # Rate of change over the last three days captures the limb the
    # hydrograph is on, which lag values alone do not express cleanly.
    df["anom_delta1"] = df["anom"].shift(1) - df["anom"].shift(2)
    df["anom_delta3"] = df["anom"].shift(1) - df["anom"].shift(4)
    names += ["1-day change in log-anomaly", "3-day change in log-anomaly"]

    if precipitation is not None:
        p = pd.Series(np.nan_to_num(precipitation, nan=0.0), index=dates)
        for lag in (0, 1, 2, 3):
            df[f"p_lag{lag}"] = np.log1p(p.shift(lag).values)
            names.append(f"log(1+precipitation), lag {lag} d")
        for window in (7, 30, 90):
            df[f"p_sum{window}"] = np.log1p(p.rolling(window, min_periods=1).sum().shift(1).values)
            names.append(f"log(1+{window}-day antecedent precipitation)")
    if temperature is not None:
        t = pd.Series(np.nan_to_num(temperature, nan=0.0), index=dates)
        df["t_lag1"] = t.shift(1).values
        df["t_mean30"] = t.rolling(30, min_periods=1).mean().shift(1).values
        names += ["temperature, lag 1 d", "30-day mean temperature"]

    doy = dates.dayofyear.values
    df["sin_doy"] = np.sin(2 * np.pi * doy / 365.25)
    df["cos_doy"] = np.cos(2 * np.pi * doy / 365.25)
    names += ["sin(day of year)", "cos(day of year)"]

    feature_cols = [c for c in df.columns if c not in ("q", "clim", "anom")]
    complete = df[feature_cols + ["anom"]].dropna()

    return FeatureSet(
        X=complete[feature_cols].to_numpy(dtype=float),
        y=complete["anom"].to_numpy(dtype=float),
        index=complete.index.values,
        names=names,
        climatology=clim,
    )


# ---------------------------------------------------------------------------
# Estimators
# ---------------------------------------------------------------------------


def _make_estimator(model: str, seed: int):
    """Return (estimator, resolved_model_name, library, hyperparameters, warnings)."""
    warnings: list[str] = []

    if model in ("xgboost", "tft") and CAPABILITIES.has_xgboost:
        import xgboost as xgb  # type: ignore

        params = dict(n_estimators=400, max_depth=6, learning_rate=0.05, subsample=0.85,
                      colsample_bytree=0.85, reg_lambda=1.0, random_state=seed, n_jobs=2)
        if model == "tft":
            warnings.append(
                "A Temporal Fusion Transformer is not implemented in this build. The architecture is scaffolded "
                "in hydro_science/models/tft.py; XGBoost was used instead and the reported skill is XGBoost's."
            )
        return xgb.XGBRegressor(**params), "xgboost", f"xgboost {CAPABILITIES.versions['xgboost']}", params, warnings

    if model == "lightgbm" and CAPABILITIES.has_lightgbm:
        import lightgbm as lgb  # type: ignore

        params = dict(n_estimators=500, num_leaves=31, learning_rate=0.05, subsample=0.85,
                      colsample_bytree=0.85, random_state=seed, n_jobs=2, verbose=-1)
        return lgb.LGBMRegressor(**params), "lightgbm", f"lightgbm {CAPABILITIES.versions['lightgbm']}", params, warnings

    if model in ("lstm", "gru"):
        if CAPABILITIES.has_torch:
            from .models.recurrent import RecurrentForecaster  # type: ignore

            est = RecurrentForecaster(kind=model, seed=seed)
            return est, model, f"torch {CAPABILITIES.versions['torch']}", est.hyperparameters, warnings
        warnings.append(
            f"PyTorch is not installed, so the {model.upper()} model could not be trained. "
            "A gradient-boosted regressor was used instead; the reported skill is the boosted model's, "
            f"not {model.upper()}'s. Install services/science/requirements-deep.txt to enable it."
        )

    if model == "random_forest":
        from sklearn.ensemble import RandomForestRegressor

        params = dict(n_estimators=300, max_depth=None, min_samples_leaf=3, random_state=seed, n_jobs=2)
        return RandomForestRegressor(**params), "random_forest", f"scikit-learn {CAPABILITIES.versions.get('sklearn')}", params, warnings

    # Default and fallback: scikit-learn's histogram gradient boosting, which
    # is always available and behaves closely to LightGBM.
    from sklearn.ensemble import HistGradientBoostingRegressor

    params = dict(max_iter=400, max_depth=6, learning_rate=0.05, l2_regularization=1.0, random_state=seed)
    resolved = "xgboost" if model in ("xgboost", "tft") else model
    if model in ("xgboost", "tft") and not CAPABILITIES.has_xgboost:
        warnings.append(
            "XGBoost is not installed. scikit-learn's HistGradientBoostingRegressor was used instead — a closely "
            "related algorithm, but not the same implementation. Install xgboost to use the requested model."
        )
    return (
        HistGradientBoostingRegressor(**params),
        resolved,
        f"scikit-learn {CAPABILITIES.versions.get('sklearn')} (HistGradientBoosting)",
        params,
        warnings,
    )


def _permutation_importance(est, X: np.ndarray, y: np.ndarray, names: list[str], seed: int, repeats: int = 3):
    """Permutation importance — model-agnostic, and computed on validation
    data so it reflects predictive contribution rather than training fit."""
    rng = np.random.default_rng(seed)
    baseline = float(np.mean((y - est.predict(X)) ** 2))
    out = []
    for j in range(X.shape[1]):
        scores = []
        for _ in range(repeats):
            Xp = X.copy()
            rng.shuffle(Xp[:, j])
            scores.append(float(np.mean((y - est.predict(Xp)) ** 2)))
        out.append(max(float(np.mean(scores)) - baseline, 0.0))
    total = sum(out) or 1.0
    ranked = sorted(
        ({"feature": names[j] if j < len(names) else f"feature {j}", "importance": out[j] / total} for j in range(len(out))),
        key=lambda d: d["importance"],
        reverse=True,
    )
    return ranked[:15]


# ---------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------


def forecast(
    dates: list[str],
    values: list[float | None],
    model: str = "xgboost",
    horizon_days: int = 7,
    precipitation: list[float | None] | None = None,
    temperature: list[float | None] | None = None,
    validation_fraction: float = 0.25,
    seed: int = 20260901,
    ensemble_size: int = 200,
) -> dict:
    idx = pd.to_datetime(pd.Series(dates))
    target = pd.to_numeric(pd.Series(values), errors="coerce").to_numpy(dtype=float)
    if np.isfinite(target).sum() < 120:
        raise ValueError(
            f"Only {int(np.isfinite(target).sum())} valid observations were supplied. "
            "At least 120 are required before a machine-learning model is fitted."
        )

    dt = pd.DatetimeIndex(idx)
    precip = pd.to_numeric(pd.Series(precipitation), errors="coerce").to_numpy(dtype=float) if precipitation else None
    temp = pd.to_numeric(pd.Series(temperature), errors="coerce").to_numpy(dtype=float) if temperature else None

    fs = build_features(dt, target, precip, temp)
    n = fs.X.shape[0]
    split = int(n * (1 - validation_fraction))
    if split < 60:
        raise ValueError("The record is too short to leave a usable validation period after feature construction.")

    est, resolved, library, hyperparameters, warnings = _make_estimator(model, seed)
    est.fit(fs.X[:split], fs.y[:split])

    # Validation in the original units, not in the transformed space: a skill
    # score on log anomalies would flatter the model.
    clim_by_date = pd.Series(fs.climatology.reindex(dt.dayofyear).values, index=dt)
    valid_index = pd.DatetimeIndex(fs.index[split:])
    pred_anom = est.predict(fs.X[split:])
    clim_valid = clim_by_date.reindex(valid_index).to_numpy(dtype=float)
    sim = np.exp(pred_anom + _to_log(clim_valid))
    obs = pd.Series(target, index=dt).reindex(valid_index).to_numpy(dtype=float)
    metrics = evaluate(obs, sim)

    residuals = fs.y[split:] - pred_anom
    resid_sd = float(np.std(residuals, ddof=1)) if residuals.size > 2 else 0.25

    importances = _permutation_importance(est, fs.X[split:], fs.y[split:], fs.names, seed)

    # ---- Recursive multi-step forecast with a residual ensemble ------------
    rng = np.random.default_rng(seed)
    history_dates = list(dt)
    history_values = list(target)
    last_date = history_dates[-1]

    members = np.zeros((ensemble_size, horizon_days), dtype=float)
    for m in range(ensemble_size):
        h_dates = list(history_dates)
        h_values = list(history_values)
        h_precip = list(precip) if precip is not None else None
        h_temp = list(temp) if temp is not None else None
        for step in range(horizon_days):
            next_date = last_date + pd.Timedelta(days=step + 1)
            h_dates.append(next_date)
            h_values.append(np.nan)
            # No forecast forcing is available: rainfall is assumed zero and
            # temperature is held at the seasonal value of the last 30 days.
            if h_precip is not None:
                h_precip.append(0.0)
            if h_temp is not None:
                h_temp.append(float(np.nanmean(h_temp[-30:])))

            tmp_idx = pd.DatetimeIndex(h_dates)
            tmp_target = np.asarray(h_values, dtype=float)
            # Fill the pending step so feature construction can build the row.
            tmp_target[-1] = tmp_target[-2] if np.isfinite(tmp_target[-2]) else float(np.nanmean(tmp_target))
            f = build_features(
                tmp_idx,
                tmp_target,
                np.asarray(h_precip, dtype=float) if h_precip is not None else None,
                np.asarray(h_temp, dtype=float) if h_temp is not None else None,
            )
            row = f.X[-1:].copy()
            pred = float(est.predict(row)[0])
            noise = 0.0 if m == 0 else float(rng.normal(0.0, resid_sd))
            clim_next = float(fs.climatology.get(int(next_date.dayofyear), np.nanmean(target)))
            value = float(np.exp(pred + noise + np.log(max(clim_next, LOG_EPS))))
            h_values[-1] = value
            members[m, step] = value

    points = []
    for step in range(horizon_days):
        col = np.sort(members[:, step])
        points.append({
            "t": (last_date + pd.Timedelta(days=step + 1)).strftime("%Y-%m-%d"),
            "mean": float(members[0, step]),
            "lower80": float(np.quantile(col, 0.10)),
            "upper80": float(np.quantile(col, 0.90)),
            "lower95": float(np.quantile(col, 0.025)),
            "upper95": float(np.quantile(col, 0.975)),
            "ensemble": [float(v) for v in col[::10]],
        })

    return {
        "model": resolved,
        "library": library,
        "hyperparameters": {k: (v if isinstance(v, (int, float, str, bool)) else str(v)) for k, v in hyperparameters.items()},
        "points": points,
        "metrics": metrics,
        "featureImportance": importances,
        "trainingPeriod": {
            "start": pd.Timestamp(fs.index[0]).strftime("%Y-%m-%d"),
            "end": pd.Timestamp(fs.index[split - 1]).strftime("%Y-%m-%d"),
        },
        "validationPeriod": {
            "start": pd.Timestamp(fs.index[split]).strftime("%Y-%m-%d"),
            "end": pd.Timestamp(fs.index[-1]).strftime("%Y-%m-%d"),
        },
        "limitations": [
            "No quantitative precipitation forecast is ingested. Beyond the last observation the model assumes no "
            "further rainfall, so the forecast is a recession-biased lower bound during storm periods.",
            "Multi-step forecasts are produced recursively, so errors compound with lead time.",
            "Prediction intervals come from resampled validation residuals, not from a formal predictive distribution, "
            "and they do not include forcing or structural uncertainty.",
            "The train/validation split is chronological; skill on a different period, or a different catchment, will differ.",
        ],
        "warnings": warnings,
    }
