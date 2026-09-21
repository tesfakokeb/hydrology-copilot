"""Shared fixtures: a deterministic synthetic catchment.

Mirrors the generator used by the TypeScript test suite so both stacks are
exercised against a record with the same statistical character.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest


def _mulberry32(seed: int):
    a = seed & 0xFFFFFFFF

    def rnd() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (t ^ (t >> 15)) * (1 | t) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) ^ t
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


@pytest.fixture(scope="session")
def catchment() -> dict:
    """15 years of daily precipitation, temperature and discharge."""
    rnd = _mulberry32(4242)
    n = 365 * 15
    dates = pd.date_range("2011-01-01", periods=n, freq="D")

    precip = np.zeros(n)
    tmean = np.zeros(n)
    flow = np.zeros(n)

    soil, quick, slow = 180.0, 0.0, 40.0
    cap = 330.0
    for i in range(n):
        doy = dates[i].dayofyear
        seasonal = np.sin(2 * np.pi * (doy - 100) / 365.25)
        decadal = np.sin(2 * np.pi * i / (365.25 * 6.5))

        p = 0.0
        if rnd() < 0.30 + 0.05 * seasonal + 0.05 * decadal:
            p = -np.log(max(rnd(), 1e-9)) * (9.0 + 2.5 * seasonal)
        precip[i] = round(p, 2)

        t = 12.5 + 12.0 * np.sin(2 * np.pi * (doy - 110) / 365.25) + (rnd() - 0.5) * 5
        tmean[i] = round(t, 2)
        pet = max(0.0023 * 15 * (t + 17.8) * np.sqrt(10.0), 0)

        wet = soil / cap
        direct = p * (0.05 + 0.5 * wet ** 2)
        soil = min(soil + (p - direct), cap)
        aet = min(pet * (0.2 + 0.8 * soil / cap), soil)
        soil -= aet
        recharge = (soil - 0.55 * cap) * 0.06 if soil > 0.55 * cap else 0.0
        soil = max(soil - recharge, 0.0)

        quick += direct
        q_quick = quick * 0.45
        quick -= q_quick
        slow += recharge
        q_slow = slow * 0.022
        slow -= q_slow

        depth = q_quick + q_slow
        flow[i] = round(max(depth * 289.3, 4.0), 2)

    return {
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "precipitation": precip.tolist(),
        "temperature": tmean.tolist(),
        "flow": flow.tolist(),
    }
