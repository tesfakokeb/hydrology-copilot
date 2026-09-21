"""Dataset profiling for binary scientific formats.

The Node gateway profiles delimited text itself. Anything that needs a
scientific reader — NetCDF, GeoTIFF, Parquet, Excel, shapefile — comes here,
because this is where xarray, rasterio, geopandas and pyarrow live.

Every profile reports what was actually read. When the reader for a format is
not installed, the response says which library is missing rather than
returning an empty or guessed structure.
"""

from __future__ import annotations

import base64
import io
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

from .capabilities import CAPABILITIES


def _variable_stats(name: str, series: pd.Series) -> dict:
    numeric = pd.to_numeric(series, errors="coerce")
    is_numeric = numeric.notna().sum() > 0.8 * max(series.notna().sum(), 1)
    missing = int(series.isna().sum())
    total = int(len(series))

    outliers = 0
    if is_numeric and numeric.notna().sum() >= 20:
        q1, q3 = numeric.quantile(0.25), numeric.quantile(0.75)
        iqr = q3 - q1
        outliers = int(((numeric < q1 - 3 * iqr) | (numeric > q3 + 3 * iqr)).sum())

    role = "unknown"
    lower = name.lower()
    if any(k in lower for k in ("date", "time")):
        role = "time"
    elif lower in ("lat", "latitude", "y"):
        role = "latitude"
    elif lower in ("lon", "long", "lng", "longitude", "x"):
        role = "longitude"
    elif any(k in lower for k in ("station", "site", "gage", "gauge")):
        role = "station_id"
    elif "flag" in lower or "qual" in lower:
        role = "flag"
    elif is_numeric:
        role = "value"

    return {
        "name": str(name),
        "role": role,
        "dtype": "number" if is_numeric else str(series.dtype),
        "unit": None,
        "missingCount": missing,
        "missingPct": (missing / total * 100) if total else 0.0,
        "min": float(numeric.min()) if is_numeric and numeric.notna().any() else None,
        "max": float(numeric.max()) if is_numeric and numeric.notna().any() else None,
        "mean": float(numeric.mean()) if is_numeric and numeric.notna().any() else None,
        "stdDev": float(numeric.std()) if is_numeric and numeric.notna().sum() > 1 else None,
        "outlierCount": outliers,
        "distinctCount": None if is_numeric else int(series.nunique()),
    }


def _profile_frame(df: pd.DataFrame, name: str, fmt: str, warnings: list[str]) -> dict:
    variables = [_variable_stats(c, df[c]) for c in df.columns]

    temporal = None
    time_cols = [v["name"] for v in variables if v["role"] == "time"]
    if time_cols:
        parsed = pd.to_datetime(df[time_cols[0]], errors="coerce").dropna()
        if len(parsed) >= 2:
            step_days = (parsed.max() - parsed.min()).days / max(len(parsed) - 1, 1)
            temporal = {
                "start": parsed.min().strftime("%Y-%m-%d"),
                "end": parsed.max().strftime("%Y-%m-%d"),
                "step": "daily" if step_days < 1.5 else "monthly" if step_days < 40 else "irregular",
            }

    spatial = None
    lat = next((v for v in variables if v["role"] == "latitude"), None)
    lon = next((v for v in variables if v["role"] == "longitude"), None)
    if lat and lon and lat["min"] is not None and lon["min"] is not None:
        spatial = {"minLon": lon["min"], "minLat": lat["min"], "maxLon": lon["max"], "maxLat": lat["max"]}

    total_cells = max(len(df) * len(df.columns), 1)
    missing_cells = sum(v["missingCount"] for v in variables)

    return {
        "name": name,
        "format": fmt,
        "rows": int(len(df)),
        "columns": int(len(df.columns)),
        "temporalCoverage": temporal,
        "spatialCoverage": spatial,
        "crs": "EPSG:4326 (assumed)" if spatial else None,
        "variables": variables,
        "missingDataPct": missing_cells / total_cells * 100,
        "qualityFlags": [
            f"{v['name']}: {v['missingPct']:.1f} % missing" for v in variables if v["missingPct"] > 20
        ] + [
            f"{v['name']}: {v['outlierCount']} values beyond 3×IQR" for v in variables if v["outlierCount"] > 0
        ],
        "warnings": warnings,
        "profiledAt": pd.Timestamp.utcnow().isoformat(),
    }


def profile(filename: str, content_base64: str) -> dict:
    """Profile an uploaded file by extension."""
    raw = base64.b64decode(content_base64)
    suffix = Path(filename).suffix.lower()
    warnings: list[str] = []

    if suffix in (".xlsx", ".xls"):
        if "openpyxl" not in CAPABILITIES.versions:
            return _unreadable(filename, "xlsx", "openpyxl")
        df = pd.read_excel(io.BytesIO(raw))
        return _profile_frame(df, filename, "xlsx", warnings)

    if suffix == ".parquet":
        if "pyarrow" not in CAPABILITIES.versions:
            return _unreadable(filename, "parquet", "pyarrow")
        df = pd.read_parquet(io.BytesIO(raw))
        return _profile_frame(df, filename, "parquet", warnings)

    if suffix in (".nc", ".nc4", ".cdf"):
        if not CAPABILITIES.has_xarray:
            return _unreadable(filename, "netcdf", "xarray + netCDF4")
        import xarray as xr  # type: ignore

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
            fh.write(raw)
            path = fh.name
        ds = xr.open_dataset(path)
        variables = []
        for name, da in ds.data_vars.items():
            values = np.asarray(da.values, dtype=float).ravel()
            finite = values[np.isfinite(values)]
            variables.append({
                "name": str(name),
                "role": "value",
                "dtype": str(da.dtype),
                "unit": da.attrs.get("units"),
                "missingCount": int(values.size - finite.size),
                "missingPct": float((values.size - finite.size) / max(values.size, 1) * 100),
                "min": float(finite.min()) if finite.size else None,
                "max": float(finite.max()) if finite.size else None,
                "mean": float(finite.mean()) if finite.size else None,
                "stdDev": float(finite.std()) if finite.size > 1 else None,
                "outlierCount": 0,
                "distinctCount": None,
            })
        temporal = None
        if "time" in ds.coords:
            t = pd.to_datetime(ds["time"].values)
            temporal = {"start": str(t.min())[:10], "end": str(t.max())[:10], "step": None}
        spatial = None
        lat_name = next((c for c in ds.coords if str(c).lower() in ("lat", "latitude")), None)
        lon_name = next((c for c in ds.coords if str(c).lower() in ("lon", "longitude")), None)
        if lat_name and lon_name:
            spatial = {
                "minLon": float(np.min(ds[lon_name].values)), "maxLon": float(np.max(ds[lon_name].values)),
                "minLat": float(np.min(ds[lat_name].values)), "maxLat": float(np.max(ds[lat_name].values)),
            }
        dims = {str(k): int(v) for k, v in ds.sizes.items()}
        ds.close()
        return {
            "name": filename, "format": "netcdf",
            "rows": int(np.prod(list(dims.values()))) if dims else 0,
            "columns": len(variables),
            "temporalCoverage": temporal, "spatialCoverage": spatial,
            "crs": ds.attrs.get("crs") if hasattr(ds, "attrs") else None,
            "variables": variables, "missingDataPct": float(np.mean([v["missingPct"] for v in variables]) if variables else 0),
            "qualityFlags": [f"dimensions: {dims}"], "warnings": warnings,
            "profiledAt": pd.Timestamp.utcnow().isoformat(),
        }

    if suffix in (".tif", ".tiff"):
        if not CAPABILITIES.has_geo:
            return _unreadable(filename, "geotiff", "rasterio")
        import rasterio  # type: ignore

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
            fh.write(raw)
            path = fh.name
        with rasterio.open(path) as src:
            band = src.read(1, masked=True)
            data = np.asarray(band.compressed(), dtype=float)
            bounds = src.bounds
            return {
                "name": filename, "format": "geotiff",
                "rows": int(src.height), "columns": int(src.width),
                "temporalCoverage": None,
                "spatialCoverage": {"minLon": bounds.left, "minLat": bounds.bottom, "maxLon": bounds.right, "maxLat": bounds.top},
                "crs": str(src.crs),
                "variables": [{
                    "name": f"band_{i + 1}", "role": "value", "dtype": str(src.dtypes[i]), "unit": None,
                    "missingCount": int(band.mask.sum()) if np.ma.is_masked(band) else 0,
                    "missingPct": float(np.ma.count_masked(band) / band.size * 100),
                    "min": float(data.min()) if data.size else None,
                    "max": float(data.max()) if data.size else None,
                    "mean": float(data.mean()) if data.size else None,
                    "stdDev": float(data.std()) if data.size > 1 else None,
                    "outlierCount": 0, "distinctCount": None,
                } for i in range(src.count)],
                "missingDataPct": float(np.ma.count_masked(band) / band.size * 100),
                "qualityFlags": [f"resolution: {src.res}", f"nodata: {src.nodata}"],
                "warnings": warnings, "profiledAt": pd.Timestamp.utcnow().isoformat(),
            }

    return _unreadable(filename, suffix.lstrip("."), "a reader for this format")


def _unreadable(filename: str, fmt: str, missing: str) -> dict:
    return {
        "name": filename, "format": fmt, "rows": 0, "columns": 0,
        "temporalCoverage": None, "spatialCoverage": None, "crs": None,
        "variables": [], "missingDataPct": 0.0, "qualityFlags": [],
        "warnings": [
            f"This file could not be profiled because {missing} is not installed in the scientific service.",
            "The file has been stored unchanged. No structure was inferred or assumed.",
            "Install services/science/requirements-geo.txt to enable geospatial and multidimensional readers.",
        ],
        "profiledAt": pd.Timestamp.utcnow().isoformat(),
    }
