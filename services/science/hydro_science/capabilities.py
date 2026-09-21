"""Optional-dependency detection.

The service is useful with only numpy, pandas, scipy and scikit-learn
installed. Heavier libraries are optional, and every response states which
were actually available, so a result is never mistaken for one produced by a
library that was not installed.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field


def _try(module: str) -> tuple[bool, str | None]:
    try:
        m = importlib.import_module(module)
        return True, getattr(m, "__version__", "unknown")
    except Exception:  # pragma: no cover - depends on the environment
        return False, None


@dataclass(frozen=True)
class Capabilities:
    versions: dict[str, str] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)

    @property
    def has_xgboost(self) -> bool:
        return "xgboost" in self.versions

    @property
    def has_lightgbm(self) -> bool:
        return "lightgbm" in self.versions

    @property
    def has_torch(self) -> bool:
        return "torch" in self.versions

    @property
    def has_geo(self) -> bool:
        return "geopandas" in self.versions and "rasterio" in self.versions

    @property
    def has_xarray(self) -> bool:
        return "xarray" in self.versions

    def available_models(self) -> list[str]:
        models = ["persistence", "climatology", "moving_average", "arima", "sarima", "random_forest"]
        models.append("xgboost" if self.has_xgboost else "xgboost (falls back to HistGradientBoosting)")
        if self.has_lightgbm:
            models.append("lightgbm")
        if self.has_torch:
            models.extend(["lstm", "gru", "tft (scaffolded)"])
        else:
            models.append("lstm/gru (unavailable: PyTorch not installed)")
        return models


def detect() -> Capabilities:
    versions: dict[str, str] = {}
    missing: list[str] = []
    for module in (
        "numpy", "pandas", "scipy", "sklearn",
        "xgboost", "lightgbm", "torch",
        "geopandas", "rasterio", "xarray", "netCDF4", "pyarrow", "openpyxl",
    ):
        ok, version = _try(module)
        if ok and version:
            versions[module] = version
        elif ok:
            versions[module] = "unknown"
        else:
            missing.append(module)
    return Capabilities(versions=versions, missing=missing)


CAPABILITIES = detect()
