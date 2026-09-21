"""Goodness-of-fit metrics.

Deliberately duplicated from the TypeScript `@hydro/hydrology-core`
implementation and tested against the same reference values, so that a metric
computed here and one computed in the gateway agree. Any divergence between
the two implementations is a test failure, not a rounding difference.
"""

from __future__ import annotations

import numpy as np


def _pair(observed, simulated) -> tuple[np.ndarray, np.ndarray]:
    o = np.asarray(observed, dtype=float)
    s = np.asarray(simulated, dtype=float)
    n = min(o.size, s.size)
    o, s = o[:n], s[:n]
    mask = np.isfinite(o) & np.isfinite(s)
    return o[mask], s[mask]


def nse(observed, simulated) -> float:
    """Nash–Sutcliffe efficiency (Nash & Sutcliffe 1970)."""
    o, s = _pair(observed, simulated)
    denom = np.sum((o - o.mean()) ** 2)
    if denom == 0:
        return float("nan")
    return float(1 - np.sum((o - s) ** 2) / denom)


def kge(observed, simulated) -> dict[str, float]:
    """Kling–Gupta efficiency, 2009 formulation (Gupta et al.)."""
    o, s = _pair(observed, simulated)
    if o.size < 2:
        return {"kge": float("nan"), "r": float("nan"), "alpha": float("nan"), "beta": float("nan")}
    r = float(np.corrcoef(o, s)[0, 1])
    alpha = float(s.std(ddof=1) / o.std(ddof=1))
    beta = float(s.mean() / o.mean())
    value = float(1 - np.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2))
    return {"kge": value, "r": r, "alpha": alpha, "beta": beta}


def rmse(observed, simulated) -> float:
    o, s = _pair(observed, simulated)
    return float(np.sqrt(np.mean((o - s) ** 2))) if o.size else float("nan")


def mae(observed, simulated) -> float:
    o, s = _pair(observed, simulated)
    return float(np.mean(np.abs(o - s))) if o.size else float("nan")


def mape(observed, simulated) -> float:
    """Undefined where the observation is zero; those pairs are excluded."""
    o, s = _pair(observed, simulated)
    mask = o != 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs((o[mask] - s[mask]) / o[mask])) * 100)


def pbias(observed, simulated) -> float:
    """Percent bias (Moriasi et al. 2007)."""
    o, s = _pair(observed, simulated)
    denom = np.sum(o)
    if denom == 0:
        return float("nan")
    return float(np.sum(s - o) / denom * 100)


def evaluate(observed, simulated) -> dict[str, float | int | None]:
    """The full metric suite reported by every model in this service."""
    o, s = _pair(observed, simulated)
    if o.size < 2:
        return {k: None for k in (
            "nse", "kge", "rmse", "mae", "mape", "r2", "bias", "pbias",
            "correlation", "peakErrorPct", "volumeErrorPct")} | {"n": int(o.size)}

    r = float(np.corrcoef(o, s)[0, 1])
    peak_o, peak_s = float(o.max()), float(s.max())
    vol_o, vol_s = float(o.sum()), float(s.sum())

    def clean(v: float) -> float | None:
        return None if not np.isfinite(v) else float(v)

    return {
        "nse": clean(nse(o, s)),
        "kge": clean(kge(o, s)["kge"]),
        "rmse": clean(rmse(o, s)),
        "mae": clean(mae(o, s)),
        "mape": clean(mape(o, s)),
        "r2": clean(r * r),
        "bias": clean(float(s.mean() - o.mean())),
        "pbias": clean(pbias(o, s)),
        "correlation": clean(r),
        "peakErrorPct": clean((peak_s - peak_o) / peak_o * 100 if peak_o else float("nan")),
        "volumeErrorPct": clean((vol_s - vol_o) / vol_o * 100 if vol_o else float("nan")),
        "n": int(o.size),
    }
