/**
 * @hydro/hydrology-core
 *
 * Reference implementations of the hydrologic and statistical methods the
 * platform reports. Everything here is deterministic, dependency-free and
 * unit-tested against published values, so that a result shown in the user
 * interface can be traced to a specific, citable algorithm.
 *
 * Heavier machine-learning and geospatial methods (Random Forest, XGBoost,
 * LSTM/GRU, TFT, raster and vector GIS) live in the Python scientific
 * service; this package is what keeps the platform scientifically useful
 * when that service is unavailable.
 */

export * from './stats.js';
export * from './metrics.js';
export * from './flow.js';
export * from './drought.js';
export * from './flood.js';
export * from './quality.js';
export * from './forecast.js';
export * from './waterbalance.js';
export * from './gr4j.js';

export const HYDROLOGY_CORE_VERSION = '1.0.0';

/** Method citations surfaced in provenance records and reports. */
export const METHOD_REFERENCES: Record<string, string> = {
  spi: 'McKee, T.B., Doesken, N.J., Kleist, J. (1993). The relationship of drought frequency and duration to time scales. 8th Conf. on Applied Climatology. WMO-No. 1090 (2012) standardised procedure.',
  spei: 'Vicente-Serrano, S.M., Beguería, S., López-Moreno, J.I. (2010). A multiscalar drought index sensitive to global warming: SPEI. J. Climate 23, 1696–1718.',
  ssi: 'Vicente-Serrano, S.M. et al. (2012). Accurate computation of a streamflow drought index. J. Hydrol. Eng. 17, 318–332.',
  nse: 'Nash, J.E., Sutcliffe, J.V. (1970). River flow forecasting through conceptual models part I. J. Hydrol. 10, 282–290.',
  kge: 'Gupta, H.V., Kling, H., Yilmaz, K.K., Martinez, G.F. (2009). Decomposition of the mean squared error and NSE criteria. J. Hydrol. 377, 80–91.',
  pbias: 'Moriasi, D.N. et al. (2007, 2015). Model evaluation guidelines for systematic quantification of accuracy. Trans. ASABE.',
  lp3: 'US Interagency Advisory Committee on Water Data, Bulletin 17B (1982); USGS Bulletin 17C (2018), Guidelines for Determining Flood Flow Frequency.',
  gev: 'Hosking, J.R.M. (1990). L-moments: analysis and estimation of distributions using linear combinations of order statistics. JRSS-B 52, 105–124.',
  baseflow: 'Lyne, V., Hollick, M. (1979); Nathan, R.J., McMahon, T.A. (1990). Evaluation of automated techniques for baseflow and recession analysis. Water Resour. Res. 26, 1465–1473.',
  hargreaves: 'Hargreaves, G.H., Samani, Z.A. (1985). Reference crop evapotranspiration from temperature. Applied Eng. in Agric. 1, 96–99.',
  ccme: 'Canadian Council of Ministers of the Environment (2001). Canadian Water Quality Index 1.0 Technical Report.',
  mannKendall: 'Mann, H.B. (1945); Kendall, M.G. (1975); Hirsch, R.M., Slack, J.R., Smith, R.A. (1982). Techniques of trend analysis for monthly water quality data. Water Resour. Res. 18, 107–121.',
  theilSen: 'Sen, P.K. (1968). Estimates of the regression coefficient based on Kendall’s tau. JASA 63, 1379–1389.',
  reliability: 'Hashimoto, T., Stedinger, J.R., Loucks, D.P. (1982). Reliability, resiliency, and vulnerability criteria for water resource system performance evaluation. Water Resour. Res. 18, 14–20.',
  modifiedZ: 'Iglewicz, B., Hoaglin, D.C. (1993). How to Detect and Handle Outliers. ASQC Quality Press.',
  hazard: 'Australian Rainfall & Runoff (2019) Book 6 flood hazard vulnerability curves; FEMA depth–velocity hazard conventions.',
  gr4j: 'Perrin, C., Michel, C., Andréassian, V. (2003). Improvement of a parsimonious model for streamflow simulation. J. Hydrol. 279, 275–289.',
};
