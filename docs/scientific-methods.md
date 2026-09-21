# Scientific methods reference

Every method the platform reports, with its implementation, its parameters, what it assumes and
where it breaks down. This document is the companion to the provenance panel: the panel tells you
which method produced a number, this tells you what that method can and cannot support.

---

## 1. Unit handling

Units are never implicit. `@hydro/units` defines each unit with a dimension and a conversion factor
to that dimension's base unit, and `convert()` throws on a cross-dimension request rather than
returning a plausible number.

Exact factors used (not rounded):

| Conversion | Factor |
| --- | --- |
| ft³ → m³ | 0.028316846592 (exact, international foot) |
| in → mm | 25.4 (exact) |
| mi² → km² | 2.589988110336 |
| acre → ha | 0.40468564224 |
| acre-foot → m³ | 1233.4818375475 |
| MGD → m³/s | 0.0438126363888889 |

Temperature is affine, not multiplicative, and is handled with an offset. `formatQuantity()` renders
an em dash for a missing value — never zero, which would read as a measurement.

**Derived hydrologic conversions.** `dischargeToDepth()` converts a discharge to an equivalent runoff
depth over a catchment: `Q [m³/s] × seconds ÷ area [m²] → m → mm`. One cubic metre per second over
86.4 km² for one day is exactly 1 mm, which is the test that pins the implementation.

---

## 2. Descriptive flow statistics

**Flow-duration curve.** Discharges sorted descending, plotted at Weibull positions `p = i/(n+1)`.
The Weibull position is unbiased for the exceedance probability of the *r*th of *n* order statistics
and is USGS convention. `Q95` — exceeded 95 % of the time — is the low-flow reference most regulatory
frameworks use.

**7Q10.** The annual minimum 7-day mean flow with a 10-year recurrence interval, estimated by fitting
a log-normal distribution to the annual 7-day minima and evaluating at the 10 % non-exceedance
quantile (z = −1.2816). Requires at least 10 water years; returns `null` below that rather than an
unstable estimate.

**Baseflow index.** Lyne–Hollick recursive digital filter, applied forward–backward–forward with
α = 0.925 (Nathan & McMahon 1990). Baseflow is clipped so it never exceeds total flow.

> **This is an index, not a measurement.** A digital filter separates a hydrograph into a fast and a
> slow component by its recession behaviour. It does not measure groundwater contribution, and the
> value depends on α. It is comparable *between catchments analysed the same way*, not against a
> tracer-based separation.

**Water year.** 1 October through 30 September, USGS convention. Annual peaks and low-flow statistics
are computed on water years, not calendar years, because a calendar year splits the winter recession.

---

## 3. Standardised drought indices

### SPI

1. Aggregate daily precipitation to monthly totals, discarding months with under 80 % daily coverage.
2. Accumulate over the timescale (1, 3, 6, 12, 24 months).
3. Fit a two-parameter gamma **separately for each calendar month** over the calibration period,
   using Thom's (1958) maximum-likelihood approximation:
   `A = ln(x̄) − mean(ln x)`, `α = (1 + √(1 + 4A/3)) / (4A)`, `β = x̄/α`.
4. Handle zero-precipitation months with the mixed distribution `H(x) = q + (1 − q)·G(x)`, where `q`
   is the observed fraction of zeros.
5. Transform `H` to the standard normal variate, truncated at ±3.09 (p = 0.001).

Per-calendar-month fitting is what makes the index comparable across seasons; a single fit would make
a wet-season deficit look like a dry-season one.

**Verification.** The test suite asserts that a 40-year synthetic record gives SPI with |mean| < 0.15
and 0.85 < sd < 1.15, and that the fraction of months at or below −0.8 falls between 13 % and 30 %
(the theoretical value is 21.2 %). A standardisation that fails these is broken regardless of whether
it runs.

**Limits.** WMO guidance recommends 30 years per calendar month. Below that the platform warns and
labels values provisional. Values near ±3 are extrapolations into the fitted tail and should be read
as "extreme", not as a precise magnitude.

### SPEI

The same transform applied to the climatic water balance `D = P − PET`, fitted to a three-parameter
log-logistic distribution by L-moments (probability-weighted moments). PET comes from
Hargreaves–Samani.

SPEI answers a different question from SPI: it accounts for atmospheric demand, so a warm dry period
scores worse on SPEI than on SPI. Disagreement between them is informative and the platform reports
both.

### SSI

SPI's transform applied to accumulated monthly mean streamflow. This is the *hydrological* drought
signal, and it typically lags the meteorological signal by weeks to months.

### Reference evapotranspiration

Hargreaves–Samani (1985): `ET₀ = 0.0023 · Ra · (Tmean + 17.8) · √(Tmax − Tmin)` with extraterrestrial
radiation `Ra` from FAO-56. Chosen over Penman–Monteith because it needs only temperature and
latitude — the variables a hydrology archive reliably has. Tested against FAO-56 `Ra` table values at
40° N.

### Classification

US Drought Monitor breakpoints on the standardised scale: D0 ≤ −0.5, D1 ≤ −0.8, D2 ≤ −1.3,
D3 ≤ −1.6, D4 ≤ −2.0, with mirrored wet categories.

> **This is not a US Drought Monitor determination.** The operational USDM is a
> convergence-of-evidence product with human authors who weigh many indicators, local reports and
> impacts. This is one index compared with the same breakpoints.

---

## 4. Flood frequency

### Log-Pearson III

Fit Pearson III to `log₁₀` of the annual peak series; evaluate quantiles with the Wilson–Hilferty
frequency factor:

```
K = (2/G) · [(1 + Gz/6 − G²/36)³ − 1],   z = Φ⁻¹(p)
log Q_T = μ_log + K · σ_log
```

Confidence limits use the Bulletin 17B Appendix 9 first-order approximation:
`SE_log = σ_log · √((1 + K²/2)/n)`.

Wilson–Hilferty is an approximation to the exact Pearson III quantile, agreeing with Bulletin 17B
tables to about 0.01 in K for |G| ≤ 1 — the tolerance the test suite asserts.

Optional Bulletin 17B skew weighting when a regional skew is supplied:
`G_w = (MSE_R·G_s + MSE_s·G_R)/(MSE_R + MSE_s)`.

**Not implemented, and stated in every result:** the Expected Moments Algorithm, Multiple Grubbs–Beck
low-outlier screening, regional skew mapping, historical/paleoflood information, confidence limits by
the Bulletin 17C method.

### GEV

Fitted by L-moments (Hosking 1990), using Hosking's rational approximation for the shape parameter.
Reported alongside LP3 specifically so the reader can see distribution-choice uncertainty, which at
the 1 %-annual-chance level is usually larger than the confidence interval of either fit alone.

### What a return period is not

A 100-year flood is not a once-a-century event. `encounterProbability(T, n) = 1 − (1 − 1/T)ⁿ` gives
≈ 26 % over a 30-year horizon, and the flood-risk page shows this table because the "1-in-100"
framing routinely misleads.

Annual peaks here are maxima of **daily mean** discharge, which under-estimates instantaneous peaks —
typically by 5–20 % on a basin of a few thousand km², more on a flashy one.

---

## 5. Water quality

### CCME Water Quality Index

```
F1 = (failed variables / total variables) × 100
F2 = (failed tests / total tests) × 100
F3 = nse / (0.01·nse + 0.01),   nse = Σ excursions / total tests
WQI = 100 − √(F1² + F2² + F3²) / 1.732
```

Chosen over the NSF index because it accepts an arbitrary parameter set and reports its three
components separately, which makes the score auditable rather than a single opaque number.

> **The index is sensitive to which parameters are included.** Adding a parameter that never fails
> raises the score. Comparisons are only meaningful between assessments using the same parameter set.

### Trend testing

Seasonal Mann–Kendall (Hirsch et al. 1982) where the record supports it, otherwise Mann–Kendall,
both with tie correction; slope by Theil–Sen. Non-parametric throughout because water-quality records
are non-normal, irregularly sampled and censored.

The test suite asserts that Theil–Sen recovers the true slope in the presence of a single 100×
outlier, which is exactly where ordinary least squares fails.

### Screening criteria

The defaults are general aquatic-life and drinking-water benchmarks (US EPA and common state
narrative values), listed with their source in the UI.

> **A screening value is not the applicable standard** for any specific waterbody. The applicable
> standard is set by the state or tribal authority with jurisdiction, and often varies by designated
> use, season and receiving water.

---

## 6. GR4J

Four parameters, daily time step (Perrin, Michel & Andréassian 2003):

| Parameter | Meaning | Bounds |
| --- | --- | --- |
| x1 | Production store capacity (mm) | 50 – 3000 |
| x2 | Groundwater exchange coefficient (mm/day) | −8 – 6 |
| x3 | Routing store capacity (mm) | 10 – 500 |
| x4 | Unit hydrograph time base (days) | 0.5 – 8 |

Structure: net rainfall/evaporation → production store with `tanh` filling and drying → percolation
→ split 90/10 into UH1 and UH2 → groundwater exchange `F = x2·(R/x3)^3.5` → routing store → total flow.

**Calibration** is bounded coordinate descent maximising KGE (or NSE) on the first 65 % of the record
after a 365-day warm-up, validated on the remainder. Deliberately simple and deterministic:
reproducibility matters more here than the last hundredth of an efficiency, and the full search trace
is returned so the optimisation can be inspected.

**Verified properties:** non-negative runoff; production store bounded by x1; long-run mass balance;
a larger x1 never increases total runoff (more water is held for evaporation); a larger x4 lowers the
peak of a unit impulse; calibration is bit-for-bit reproducible.

**Limits.** A lumped model treats the catchment as one unit — no spatial variability in soil, land
cover or rainfall. No snow module, so a snowpack-dominated catchment needs a CemaNeige-style
extension. No regulation, diversions or sub-daily dynamics. Parameter equifinality is real: several
parameter sets give near-identical skill, and the calibrated set should not be interpreted as
physically measured properties.

---

## 7. Model evaluation

| Metric | Formula | Reads as |
| --- | --- | --- |
| NSE | `1 − Σ(o−s)² / Σ(o−ō)²` | 1 perfect; 0 no better than the observed mean; < 0 worse |
| KGE | `1 − √((r−1)² + (α−1)² + (β−1)²)` | Decomposes into correlation, variability ratio and bias ratio |
| RMSE, MAE | — | Same units as the variable |
| MAPE | — | Excludes zero observations, where it is undefined |
| PBIAS | `Σ(s−o)/Σo × 100` | Positive = over-prediction |
| Peak / volume error | — | What a flood or a water-supply study respectively cares about |

Performance ratings follow Moriasi et al. (2015) for daily streamflow: NSE > 0.80 very good,
> 0.70 good, > 0.50 satisfactory; |PBIAS| < 5/10/15 % correspondingly.

> **A rating is a convention, not a certification.** It says the simulation is consistent with a
> published expectation for this class of model at this time step. It does not make the model fit
> for a particular decision.

KGE is reported alongside NSE because NSE is dominated by high flows and can be high for a model that
badly mis-represents the low-flow regime. When they disagree, the α and β components say why.

---

## 8. Reservoir simulation

Sequential monthly mass balance with a simple rule: meet demand from storage above the dead pool,
after the minimum instream release. Spill above the flood pool.

Performance follows Hashimoto, Stedinger & Loucks (1982):

- **Reliability** — fraction of time steps meeting full demand (time) and delivered ÷ requested volume (volumetric).
- **Resilience** — failure runs ÷ failure steps: how quickly the system recovers.
- **Vulnerability** — the worst single-step shortfall.

**Safe yield** is found by bisection: the largest constant withdrawal met in every step of the
historical inflow record.

> Safe yield is **conditional on the historical sequence**. A drought worse than anything in the
> record gives a lower value, and a single historical realisation is not a stochastic ensemble.

Scenarios are multiplicative factors on inflow and demand. They are illustrative planning
assumptions, not projections from a climate or econometric model, and every result that uses them
says so.

---

## 9. Catchment water balance

`P = Q + ET + ΔS`, with the residual **reported rather than forced to zero**. Closure quality is
graded: good < 10 % of precipitation, acceptable < 25 %, poor above that.

A poor closure is diagnostic, not a bug. It usually means the ET estimate, the areal precipitation
estimate or the assumed catchment area is inconsistent with the gauge record — or that inter-basin
transfers or regulation are present. Reporting the residual is the only honest option; a balance that
always closes has had a fudge term added.

---

## 10. Forecasting

**Features.** Log-anomaly of discharge against a smoothed day-of-year climatology at lags 1–7; 1-day
and 3-day rates of change; `log(1+P)` at lags 0–3 and 7/30/90-day antecedent accumulations;
temperature at lag 1 and its 30-day mean; sine and cosine of day of year.

The log-anomaly transform stabilises variance, removes the seasonal cycle from the target, and
guarantees a non-negative forecast after back-transformation.

**No target leakage.** Every feature is a lag, an antecedent accumulation or a calendar term — never
a same-day value of the target. The test suite asserts this over the feature name list.

**Split.** Strictly chronological. No shuffled cross-validation anywhere: shuffling a hydrologic
series leaks future information into training and produces skill that cannot be reproduced
operationally.

**Multi-step.** Recursive — each predicted step becomes an input to the next — so errors compound
with lead time and the interval widens accordingly.

**Uncertainty.** Validation residuals resampled through the recursion, giving an ensemble. This
captures the model's own error distribution. It does **not** capture forcing uncertainty or
structural error, and the response says so.

**The dominant limitation.** No quantitative precipitation forecast is ingested. Beyond the last
observation the models assume no further rainfall, so a forecast is recession-biased and threshold
exceedance probabilities are lower bounds during an approaching storm. This is stated in every
forecast response, on the flood-forecasting page, and in the roadmap — it is the single change that
would most improve skill.

---

## 11. Explicitly not implemented

Listed because a platform that quietly omits these is harder to evaluate than one that names them.

| Not implemented | What it would need |
| --- | --- |
| PDSI | Soil available-water capacity by climate division and a calibrated Palmer water balance |
| Bulletin 17C EMA | Expected Moments Algorithm, MGBT low-outlier screening, regional skew mapping |
| Hydraulic modelling | HEC-RAS 2D with terrain, mesh, roughness and boundary conditions |
| Distributed modelling | Gridded forcing, DEM-based delineation, routing between subbasins |
| Temporal Fusion Transformer | Multi-catchment training, known-future covariates, quantile loss |
| Seasonal drought outlook | A seasonal climate forecast as input |
| Sediment and nutrient transport | SWAT or an equivalent with land-management inputs |
| Groundwater flow | MODFLOW with a discretised aquifer and boundary packages |

---

## References

- CCME (2001). *Canadian Water Quality Index 1.0 Technical Report.*
- Gupta, H.V., Kling, H., Yilmaz, K.K., Martinez, G.F. (2009). Decomposition of the mean squared error and NSE criteria. *J. Hydrol.* 377, 80–91.
- Hargreaves, G.H., Samani, Z.A. (1985). Reference crop evapotranspiration from temperature. *Applied Eng. in Agric.* 1, 96–99.
- Hashimoto, T., Stedinger, J.R., Loucks, D.P. (1982). Reliability, resiliency, and vulnerability criteria. *Water Resour. Res.* 18, 14–20.
- Hirsch, R.M., Slack, J.R., Smith, R.A. (1982). Techniques of trend analysis for monthly water quality data. *Water Resour. Res.* 18, 107–121.
- Hosking, J.R.M. (1990). L-moments. *JRSS-B* 52, 105–124.
- Iglewicz, B., Hoaglin, D.C. (1993). *How to Detect and Handle Outliers.* ASQC Quality Press.
- Interagency Advisory Committee on Water Data (1982). *Bulletin 17B.* USGS (2018). *Bulletin 17C.*
- Lim, B., Arık, S.Ö., Loeff, N., Pfister, T. (2021). Temporal Fusion Transformers. *Int. J. Forecasting* 37(4), 1748–1764.
- McKee, T.B., Doesken, N.J., Kleist, J. (1993). The relationship of drought frequency and duration to time scales. *8th Conf. Applied Climatology.*
- Moriasi, D.N. et al. (2007, 2015). Model evaluation guidelines. *Trans. ASABE.*
- Nash, J.E., Sutcliffe, J.V. (1970). River flow forecasting through conceptual models part I. *J. Hydrol.* 10, 282–290.
- Nathan, R.J., McMahon, T.A. (1990). Evaluation of automated techniques for baseflow and recession analysis. *Water Resour. Res.* 26, 1465–1473.
- Perrin, C., Michel, C., Andréassian, V. (2003). Improvement of a parsimonious model for streamflow simulation. *J. Hydrol.* 279, 275–289.
- Sen, P.K. (1968). Estimates of the regression coefficient based on Kendall's tau. *JASA* 63, 1379–1389.
- Svoboda, M. et al. (2002). The Drought Monitor. *Bull. Amer. Meteor. Soc.* 83, 1181–1190.
- Vicente-Serrano, S.M., Beguería, S., López-Moreno, J.I. (2010). A multiscalar drought index: SPEI. *J. Climate* 23, 1696–1718.
- WMO (2012). *Standardized Precipitation Index User Guide.* WMO-No. 1090.
