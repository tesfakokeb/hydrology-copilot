"""FastAPI application for the Hydrology Copilot scientific service.

The Node gateway calls this service for computations that belong in the
scientific Python stack. It holds no database connection and no credentials:
it receives arrays, returns results, and is horizontally scalable because it
is stateless.
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .capabilities import CAPABILITIES
from .forecasting import forecast as run_forecast
from .metrics import evaluate
from .models.tft import describe as describe_tft
from .profiling import profile as run_profile

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("hydro-science")

app = FastAPI(
    title="Hydrology Copilot — Scientific Service",
    version=__version__,
    description=(
        "Machine-learning forecasting, feature attribution and scientific-format profiling for Hydrology Copilot. "
        "Every response reports the model that actually ran, the libraries available, the validation skill achieved "
        "and the limitations of the result."
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ForecastRequest(BaseModel):
    dates: list[str] = Field(..., min_length=120, description="ISO dates, ascending, one per observation.")
    values: list[float | None] = Field(..., description="Target variable, typically discharge in m³/s.")
    precipitation: list[float | None] | None = Field(None, description="Optional daily precipitation, mm.")
    temperature: list[float | None] | None = Field(None, description="Optional daily mean temperature, °C.")
    model: str = Field("xgboost", description="random_forest | xgboost | lightgbm | lstm | gru | tft")
    horizonDays: int = Field(7, ge=1, le=180)
    validationFraction: float = Field(0.25, gt=0.05, lt=0.6)
    seed: int = 20260901
    ensembleSize: int = Field(200, ge=20, le=1000)


class MetricsRequest(BaseModel):
    observed: list[float | None]
    simulated: list[float | None]


class ProfileRequest(BaseModel):
    filename: str
    contentBase64: str


class FeatureImportanceRequest(BaseModel):
    features: dict[str, list[float]]
    target: list[float]
    seed: int = 20260901


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "models": CAPABILITIES.available_models(),
        "libraries": CAPABILITIES.versions,
        "missing": CAPABILITIES.missing,
    }


@app.get("/capabilities")
def capabilities() -> dict:
    return {
        "libraries": CAPABILITIES.versions,
        "missing": CAPABILITIES.missing,
        "models": CAPABILITIES.available_models(),
        "tft": describe_tft(),
        "notes": [
            "Gradient boosting falls back to scikit-learn's HistGradientBoostingRegressor when XGBoost is absent, "
            "and the response says so.",
            "LSTM and GRU require PyTorch (requirements-deep.txt). Without it the request is served by a boosted "
            "model and the substitution is reported.",
            "NetCDF, GeoTIFF and shapefile profiling require requirements-geo.txt.",
        ],
    }


@app.post("/forecast")
def forecast_endpoint(req: ForecastRequest) -> dict:
    started = time.time()
    try:
        result = run_forecast(
            dates=req.dates,
            values=req.values,
            model=req.model,
            horizon_days=req.horizonDays,
            precipitation=req.precipitation,
            temperature=req.temperature,
            validation_fraction=req.validationFraction,
            seed=req.seed,
            ensemble_size=req.ensembleSize,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("Forecast failed")
        raise HTTPException(status_code=500, detail=f"Forecast failed: {exc}") from exc

    result["computeSeconds"] = round(time.time() - started, 3)
    log.info(
        "forecast model=%s horizon=%s nse=%s seconds=%s",
        result["model"], req.horizonDays, result["metrics"].get("nse"), result["computeSeconds"],
    )
    return result


@app.post("/metrics")
def metrics_endpoint(req: MetricsRequest) -> dict:
    return evaluate(
        [v if v is not None else float("nan") for v in req.observed],
        [v if v is not None else float("nan") for v in req.simulated],
    )


@app.post("/feature-importance")
def feature_importance_endpoint(req: FeatureImportanceRequest) -> dict:
    import numpy as np
    from sklearn.ensemble import RandomForestRegressor

    names = list(req.features.keys())
    X = np.column_stack([np.asarray(req.features[k], dtype=float) for k in names])
    y = np.asarray(req.target, dtype=float)
    if X.shape[0] != y.shape[0]:
        raise HTTPException(status_code=422, detail="Every feature must have the same length as the target.")
    if X.shape[0] < 30:
        raise HTTPException(status_code=422, detail="At least 30 samples are required for a stable importance estimate.")

    model = RandomForestRegressor(n_estimators=300, random_state=req.seed, n_jobs=2).fit(X, y)
    total = float(model.feature_importances_.sum()) or 1.0
    return {
        "importances": sorted(
            ({"feature": n, "importance": float(v) / total} for n, v in zip(names, model.feature_importances_)),
            key=lambda d: d["importance"],
            reverse=True,
        ),
        "method": "Random forest impurity-based importance (scikit-learn)",
        "caveat": (
            "Impurity-based importance is biased towards high-cardinality and correlated predictors. Treat it as a "
            "ranking of association, not of causal contribution."
        ),
    }


@app.post("/profile")
def profile_endpoint(req: ProfileRequest) -> dict:
    try:
        return run_profile(req.filename, req.contentBase64)
    except Exception as exc:  # pragma: no cover - depends on the file
        log.exception("Profiling failed")
        raise HTTPException(status_code=422, detail=f"Could not profile {req.filename}: {exc}") from exc
