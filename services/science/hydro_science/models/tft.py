"""Temporal Fusion Transformer — architecture scaffolding.

Not implemented. This module exists so that the shape of the integration is
explicit and so that no other part of the platform can quietly pretend a TFT
ran. Requesting `model: "tft"` returns an XGBoost forecast with a warning
naming the substitution.

What a real implementation needs, beyond the code in this repository:

1. **Multi-series training.** A TFT earns its complexity by learning across
   many catchments with static covariates (drainage area, mean slope, land
   cover, soil). Trained on a single gauge it will not beat gradient boosting.
2. **Known-future covariates.** The architecture's main advantage over
   recurrent models is separating known-future inputs (forecast precipitation,
   day of year, reservoir release schedules) from observed-past inputs. Without
   a quantitative precipitation forecast in the pipeline, that advantage is
   unused.
3. **Quantile loss.** Train with a pinball loss over several quantiles so the
   prediction interval comes from the model rather than from resampled
   residuals.
4. **Variable-selection networks and interpretable attention**, which is what
   makes a TFT worth explaining to a reviewer — per-timestep attention weights
   and per-variable selection weights map directly onto the explainability
   panel the platform already renders.

Reference: Lim, B., Arık, S. Ö., Loeff, N., Pfister, T. (2021). Temporal Fusion
Transformers for interpretable multi-horizon time series forecasting.
International Journal of Forecasting 37(4), 1748–1764.
"""

from __future__ import annotations

REQUIREMENTS = [
    "PyTorch (services/science/requirements-deep.txt)",
    "A multi-catchment training set with static catchment attributes",
    "Quantitative precipitation forecasts as known-future covariates",
    "A quantile (pinball) loss for probabilistic output",
]

IMPLEMENTED = False


def describe() -> dict:
    return {
        "implemented": IMPLEMENTED,
        "requirements": REQUIREMENTS,
        "substitute": "xgboost",
        "note": (
            "The Temporal Fusion Transformer is scaffolded but not implemented. Requests for it are served by "
            "XGBoost and the response says so. No TFT result is ever reported."
        ),
    }
