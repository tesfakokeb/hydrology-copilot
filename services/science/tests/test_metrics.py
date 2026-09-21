"""Scientific tests for the metric suite.

These assert the same reference values as the TypeScript implementation in
packages/hydrology-core/test/metrics.test.ts. If the two ever disagree, one of
them is wrong and this suite fails.
"""

import math

import numpy as np
import pytest

from hydro_science.metrics import evaluate, kge, mae, mape, nse, pbias, rmse

OBS = [10, 12, 15, 20, 35, 60, 45, 30, 22, 18, 15, 12]


def test_nse_is_one_for_a_perfect_simulation():
    assert nse(OBS, OBS) == pytest.approx(1.0, abs=1e-12)


def test_nse_is_zero_when_the_simulation_is_the_observed_mean():
    mean = float(np.mean(OBS))
    assert nse(OBS, [mean] * len(OBS)) == pytest.approx(0.0, abs=1e-12)


def test_nse_matches_a_hand_computed_value():
    o = [1, 2, 3, 4]
    s = [1.1, 1.9, 3.2, 3.8]
    # SSE = 0.10, SST = 5.0
    assert nse(o, s) == pytest.approx(1 - 0.10 / 5.0, abs=1e-10)


def test_kge_decomposes_a_pure_scaling_error():
    sim = [v * 1.2 for v in OBS]
    k = kge(OBS, sim)
    assert k["r"] == pytest.approx(1.0, abs=1e-10)
    assert k["alpha"] == pytest.approx(1.2, abs=1e-10)
    assert k["beta"] == pytest.approx(1.2, abs=1e-10)
    assert k["kge"] == pytest.approx(1 - math.sqrt(0.04 + 0.04), abs=1e-10)


def test_kge_is_one_for_a_perfect_simulation():
    assert kge(OBS, OBS)["kge"] == pytest.approx(1.0, abs=1e-12)


def test_error_magnitudes():
    o, s = [1, 2, 3, 4], [2, 3, 4, 5]
    assert rmse(o, s) == pytest.approx(1.0)
    assert mae(o, s) == pytest.approx(1.0)
    assert pbias(o, s) == pytest.approx(40.0)


def test_mape_skips_zero_observations():
    assert mape([0, 2, 4], [1, 3, 5]) == pytest.approx(((1 / 2 + 1 / 4) / 2) * 100)


def test_evaluate_deletes_pairs_with_a_missing_member():
    m = evaluate([1, float("nan"), 3, 4], [1, 2, 3, float("nan")])
    assert m["n"] == 2


def test_evaluate_returns_nulls_rather_than_nan_on_empty_input():
    m = evaluate([], [])
    assert m["nse"] is None
    assert m["n"] == 0


def test_evaluate_reports_peak_and_volume_error():
    m = evaluate([10, 50, 20], [10, 45, 20])
    assert m["peakErrorPct"] == pytest.approx(-10.0)
    assert m["volumeErrorPct"] == pytest.approx((75 - 80) / 80 * 100)
