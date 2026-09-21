"""Hydrology Copilot — Python scientific service.

This package hosts the computations that belong in the scientific Python
stack rather than in the Node gateway: machine-learning streamflow and demand
forecasting, feature attribution, and profiling of binary scientific formats
(NetCDF, GeoTIFF, Parquet, Excel, shapefile).

Design commitments, mirroring the platform's scientific guardrails:

* Every model reports the skill it achieved on a held-out validation period.
  A model that was not validated does not return a forecast.
* Optional libraries (XGBoost, LightGBM, PyTorch, geospatial readers) are
  detected at import time. When one is missing the service substitutes a
  documented alternative and says so in the response, never silently.
* Every fit is seeded, so the same request returns the same numbers.
"""

__version__ = "1.0.0"
