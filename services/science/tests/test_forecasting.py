"""Scientific tests for the machine-learning forecasting pipeline."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from hydro_science.forecasting import build_features, forecast, smoothed_climatology


def test_smoothed_climatology_covers_every_day_of_year(catchment):
    dates = pd.DatetimeIndex(catchment["dates"])
    clim = smoothed_climatology(dates, np.asarray(catchment["flow"]))
    assert len(clim) == 366
    assert clim.notna().all()
    # A seasonal signal must produce a seasonal climatology.
    assert clim.max() > clim.min() * 1.2


def test_features_never_use_the_current_day_target(catchment):
    dates = pd.DatetimeIndex(catchment["dates"])
    fs = build_features(dates, np.asarray(catchment["flow"]), np.asarray(catchment["precipitation"]), None)
    # Every named feature must be a lag, an antecedent accumulation, or a
    # calendar term. A same-day discharge feature would leak the target.
    for name in fs.names:
        assert "lag" in name or "antecedent" in name or "day of year" in name or "change in" in name or "mean temperature" in name


def test_features_align_with_the_target(catchment):
    dates = pd.DatetimeIndex(catchment["dates"])
    fs = build_features(dates, np.asarray(catchment["flow"]), np.asarray(catchment["precipitation"]), None)
    assert fs.X.shape[0] == fs.y.shape[0] == fs.index.shape[0]
    assert np.isfinite(fs.X).all()
    assert np.isfinite(fs.y).all()


def test_forecast_refuses_a_short_record():
    with pytest.raises(ValueError, match="At least 120"):
        forecast(dates=["2024-01-01"] * 10, values=[1.0] * 10)


@pytest.mark.parametrize("model", ["random_forest", "xgboost"])
def test_forecast_produces_a_validated_probabilistic_forecast(catchment, model):
    result = forecast(
        dates=catchment["dates"],
        values=catchment["flow"],
        precipitation=catchment["precipitation"],
        temperature=catchment["temperature"],
        model=model,
        horizon_days=7,
        ensemble_size=40,
    )

    assert len(result["points"]) == 7
    for p in result["points"]:
        assert p["mean"] >= 0
        assert p["lower95"] <= p["lower80"] <= p["upper80"] <= p["upper95"]
        assert p["lower95"] >= 0

    # The model must beat climatology by a clear margin on held-out data.
    assert result["metrics"]["nse"] > 0.5
    assert result["metrics"]["n"] > 100

    # Training and validation must not overlap.
    assert result["validationPeriod"]["start"] > result["trainingPeriod"]["end"]

    # Importances must be reported and normalised.
    total = sum(f["importance"] for f in result["featureImportance"])
    assert 0.99 <= total <= 1.01

    # The zero-rainfall assumption must be stated.
    assert any("no further rainfall" in lim for lim in result["limitations"])


def test_forecast_is_reproducible(catchment):
    kwargs = dict(
        dates=catchment["dates"], values=catchment["flow"],
        precipitation=catchment["precipitation"], model="random_forest",
        horizon_days=5, ensemble_size=30, seed=7,
    )
    a = forecast(**kwargs)
    b = forecast(**kwargs)
    # The deterministic member (no residual noise) must match exactly.
    assert [p["mean"] for p in a["points"]] == [p["mean"] for p in b["points"]]
    # Ensemble quantiles come from multi-threaded estimators, so they agree to
    # floating-point rounding rather than bit-for-bit. Anything looser than
    # this would indicate a genuinely unseeded source of randomness.
    for pa, pb in zip(a["points"], b["points"]):
        assert pa["upper95"] == pytest.approx(pb["upper95"], rel=1e-12)
        assert pa["lower95"] == pytest.approx(pb["lower95"], rel=1e-12)


def test_unavailable_model_is_reported_not_silently_substituted(catchment):
    result = forecast(
        dates=catchment["dates"], values=catchment["flow"],
        model="lstm", horizon_days=3, ensemble_size=20,
    )
    from hydro_science.capabilities import CAPABILITIES

    if not CAPABILITIES.has_torch:
        assert result["warnings"], "A substitution must be reported"
        assert "PyTorch is not installed" in " ".join(result["warnings"])
    else:
        assert result["model"] == "lstm"


def test_tft_request_is_never_reported_as_a_tft_result(catchment):
    result = forecast(
        dates=catchment["dates"], values=catchment["flow"],
        model="tft", horizon_days=3, ensemble_size=20,
    )
    assert result["model"] != "tft"
    assert any("Temporal Fusion Transformer" in w or "HistGradientBoosting" in w for w in result["warnings"])


def test_uncertainty_grows_with_lead_time(catchment):
    result = forecast(
        dates=catchment["dates"], values=catchment["flow"],
        precipitation=catchment["precipitation"], model="random_forest",
        horizon_days=14, ensemble_size=60,
    )
    width = [p["upper95"] - p["lower95"] for p in result["points"]]
    # Later leads must, on average, be more uncertain than the first few.
    assert np.mean(width[-4:]) > np.mean(width[:4])
