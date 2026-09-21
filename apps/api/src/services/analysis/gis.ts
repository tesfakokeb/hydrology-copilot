import { METHOD_REFERENCES, mean } from '@hydro/hydrology-core';
import type { ToolResult } from '@hydro/shared-types';
import { convert, dischargeToDepth } from '@hydro/units';
import { ProvenanceBuilder, demoSource } from '../provenance.js';
import { CHART_COLORS, insufficient, lineChart, mapSpec, ok, q, type ToolContext } from './common.js';

/** analyze_watershed / calculate_watershed_statistics */
export async function analyzeWatershed(ctx: ToolContext, args: { watershedId?: string } = {}): Promise<ToolResult> {
  const p = new ProvenanceBuilder('analyze_watershed', { projectId: ctx.projectId, userId: ctx.userId });
  const watersheds = await ctx.db.listWatersheds();
  const watershed = watersheds.find((w) => w.id === (args.watershedId ?? ctx.watershedId)) ?? watersheds[0];
  if (!watershed) return insufficient(p, 'No watershed is defined for this project.', args);

  const [subbasins, stations, flow, precip, aet] = await Promise.all([
    ctx.db.listSubbasins(watershed.id),
    ctx.db.listStations({ watershedId: watershed.id }),
    ctx.db.getSeries({ variable: 'discharge' }),
    ctx.db.getSeries({ variable: 'precipitation' }),
    ctx.db.getSeries({ variable: 'et_actual' }),
  ]);
  ctx.emit?.('Loaded watershed geometry and monitoring network', 'ok', `${subbasins.length} subbasins, ${stations.length} stations`);

  const flowValues = flow.points.map((pt) => pt.v).filter((v): v is number => v !== null);
  const meanQ = mean(flowValues);
  const years = flow.points.length / 365.25;
  const annualPrecip = precip.points.reduce((s, pt) => s + (pt.v ?? 0), 0) / years;
  const annualEt = aet.points.reduce((s, pt) => s + (pt.v ?? 0), 0) / years;
  const annualRunoff = dischargeToDepth(meanQ, 'm3/s', watershed.areaKm2, 'km2', 365.25 * 86400, 'mm');

  // Subbasin contribution apportioned by area and curve number — an explicit
  // approximation, since no subbasin gauges exist in the demonstration network.
  const weights = subbasins.map((s) => ({
    subbasin: s,
    weight: s.areaKm2 * (1 + ((s.curveNumber ?? 75) - 75) / 100),
  }));
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  const contributions = weights
    .map((w) => ({
      id: w.subbasin.id,
      name: w.subbasin.name,
      areaKm2: w.subbasin.areaKm2,
      areaPct: (w.subbasin.areaKm2 / watershed.areaKm2) * 100,
      curveNumber: w.subbasin.curveNumber,
      meanElevationM: w.subbasin.meanElevationM,
      meanSlopePct: w.subbasin.meanSlopePct,
      landCover: w.subbasin.dominantLandCover,
      estimatedFlowSharePct: (w.weight / totalWeight) * 100,
      estimatedMeanFlowM3s: (w.weight / totalWeight) * meanQ,
    }))
    .sort((a, b) => b.estimatedFlowSharePct - a.estimatedFlowSharePct);

  const geojson = await ctx.db.getWatershedGeoJson(watershed.id);
  const reaches = await ctx.db.getReaches(watershed.id);

  p.source(demoSource('Watershed and subbasin geometry, monitoring network, and basin fluxes', ['geometry', 'discharge', 'precipitation', 'et_actual'], { discharge: 'm3/s', precipitation: 'mm', et_actual: 'mm' }, { start: flow.points[0].t, end: flow.points[flow.points.length - 1].t }, flow.points.length, watershed.name))
    .method({ name: 'Area- and curve-number-weighted flow apportionment', kind: 'gis', implementation: 'apps/api/src/services/analysis/gis.ts', reference: null, parameters: { weighting: 'area × (1 + (CN − 75)/100)' } })
    .method({ name: 'Runoff depth from discharge', kind: 'statistic', implementation: '@hydro/units dischargeToDepth', reference: null, parameters: { areaKm2: watershed.areaKm2 } })
    .step('load', 'Read watershed and subbasin geometry from the spatial store.', { subbasins: subbasins.length })
    .step('summarise', 'Computed area, elevation and land-cover summaries per subbasin.', {})
    .step('apportion', 'Estimated each subbasin\'s flow contribution by area weighted by curve number.', {})
    .coverage(flow.points[0].t, flow.points[flow.points.length - 1].t)
    .extent(`${watershed.name}, ${watershed.areaKm2.toLocaleString()} km²`)
    .assume(
      'Subbasin flow contributions are apportioned from area and curve number because no subbasin-outlet gauges exist. They are estimates, not measurements.',
      'Basin-average precipitation is applied uniformly across subbasins.',
    )
    .limit('Watershed geometry in the demonstration dataset is generated, not delineated from a DEM. A real delineation requires a conditioned DEM and a flow-accumulation threshold.')
    .uncertain({ sources: ['Flow apportionment is an unvalidated heuristic.', 'Geometry is synthetic.'], qualitative: 'high' });

  return ok(
    `${watershed.name} covers ${watershed.areaKm2.toLocaleString()} km² across ${subbasins.length} subbasins with ${stations.length} monitoring stations. ` +
      `Mean annual precipitation is ${annualPrecip.toFixed(0)} mm, evapotranspiration ${annualEt.toFixed(0)} mm and runoff ${annualRunoff.toFixed(0)} mm, giving a runoff ratio of ${(annualRunoff / annualPrecip).toFixed(2)}. ` +
      `The largest estimated contributor is ${contributions[0].name} at ${contributions[0].estimatedFlowSharePct.toFixed(1)} % of flow.`,
    {
      data: {
        watershed,
        subbasins: contributions,
        stations,
        geojson,
        reaches,
        summary: {
          areaKm2: watershed.areaKm2,
          areaMi2: convert(watershed.areaKm2, 'km2', 'mi2'),
          subbasinCount: subbasins.length,
          stationCount: stations.length,
          meanElevationM: mean(subbasins.map((s) => s.meanElevationM ?? 0)),
          meanSlopePct: mean(subbasins.map((s) => s.meanSlopePct ?? 0)),
          areaWeightedCurveNumber: subbasins.reduce((s, b) => s + (b.curveNumber ?? 0) * b.areaKm2, 0) / watershed.areaKm2,
          annualPrecipitationMm: annualPrecip,
          annualEtMm: annualEt,
          annualRunoffMm: annualRunoff,
          runoffRatio: annualRunoff / annualPrecip,
          meanDischargeM3s: meanQ,
          specificDischargeM3sPerKm2: meanQ / watershed.areaKm2,
        },
      },
      metrics: {
        areaKm2: watershed.areaKm2,
        subbasinCount: subbasins.length,
        annualPrecipitationMm: annualPrecip,
        annualRunoffMm: annualRunoff,
        runoffRatio: annualRunoff / annualPrecip,
        meanDischargeM3s: meanQ,
      },
      quantities: {
        area: q(watershed.areaKm2, 'km2'),
        meanDischarge: q(meanQ, 'm3/s'),
        annualPrecipitation: q(annualPrecip, 'mm'),
        annualRunoff: q(annualRunoff, 'mm'),
      },
      charts: [
        lineChart({
          kind: 'bar',
          title: 'Estimated flow contribution by subbasin',
          xLabel: 'Subbasin',
          yLabel: 'Share of mean flow',
          unit: '%',
          series: [{ key: 'share', label: 'Estimated share', color: CHART_COLORS.observed }],
          data: contributions.map((c) => ({ t: c.name, share: c.estimatedFlowSharePct })),
          caption: 'Area- and curve-number-weighted estimate. Not measured — the demonstration network has no subbasin-outlet gauges.',
        }),
      ],
      maps: [
        mapSpec({
          title: watershed.name,
          caption: 'Watershed boundary, subbasins, stream network and monitoring stations. Geometry is synthetic.',
          center: [watershed.centroid?.lon ?? -77.6, watershed.centroid?.lat ?? 39.3],
          zoom: 7.5,
          layers: [
            { id: 'basins', label: 'Watershed and subbasins', kind: 'geojson', data: geojson, legend: [{ label: 'Subbasin', color: '#0f6fb8' }] },
            { id: 'reaches', label: 'Stream network', kind: 'geojson', data: reaches, legend: [{ label: 'Reach', color: '#12897b' }] },
            {
              id: 'stations',
              label: 'Monitoring stations',
              kind: 'points',
              data: {
                type: 'FeatureCollection',
                features: stations.map((s) => ({
                  type: 'Feature',
                  properties: { name: s.name, code: s.code, stationType: s.type, drainageAreaKm2: s.drainageAreaKm2 },
                  geometry: { type: 'Point', coordinates: [s.location.lon, s.location.lat] },
                })),
              },
              legend: [
                { label: 'Streamgage', color: '#0f6fb8' },
                { label: 'Precipitation', color: '#12897b' },
                { label: 'Weather', color: '#e0721c' },
                { label: 'Water quality', color: '#7b3ff2' },
                { label: 'Groundwater', color: '#8b5e34' },
              ],
            },
          ],
        }),
      ],
      provenance: p.build(args),
    },
  );
}

/** run_gis_analysis — spatial queries over the project's layers. */
export async function runGisAnalysis(
  ctx: ToolContext,
  args: { operation?: 'stations_in_watershed' | 'subbasin_summary' | 'bounding_box' | 'nearest_station'; lon?: number; lat?: number },
): Promise<ToolResult> {
  const operation = args.operation ?? 'subbasin_summary';
  const p = new ProvenanceBuilder('run_gis_analysis', { projectId: ctx.projectId, userId: ctx.userId });
  const watershed = (await ctx.db.listWatersheds())[0];
  if (!watershed) return insufficient(p, 'No watershed geometry is available.', args);
  const [subbasins, stations] = await Promise.all([ctx.db.listSubbasins(watershed.id), ctx.db.listStations({ watershedId: watershed.id })]);

  p.method({ name: `GIS operation: ${operation}`, kind: 'gis', implementation: 'PostGIS when a database is configured; in-process geometry otherwise', reference: null, parameters: args as Record<string, unknown> })
    .step('query', `Executed the ${operation} spatial query.`, {})
    .extent(watershed.name)
    .assume('Coordinates are WGS 84 (EPSG:4326). Distances are computed on a spherical approximation, adequate at basin scale but not for survey work.')
    .uncertain({ sources: ['Synthetic geometry.'], qualitative: 'not_quantified' });

  let summary: string;
  let data: Record<string, unknown>;

  switch (operation) {
    case 'nearest_station': {
      if (args.lon === undefined || args.lat === undefined) {
        return insufficient(p, 'A longitude and latitude are required for a nearest-station query.', args);
      }
      const withDist = stations
        .map((s) => ({ station: s, distanceKm: haversineKm(args.lon!, args.lat!, s.location.lon, s.location.lat) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      summary = `The nearest station to ${args.lat.toFixed(4)}, ${args.lon.toFixed(4)} is ${withDist[0].station.name}, ${withDist[0].distanceKm.toFixed(1)} km away.`;
      data = { query: { lon: args.lon, lat: args.lat }, nearest: withDist.slice(0, 5) };
      break;
    }
    case 'bounding_box': {
      summary = `${watershed.name} spans ${watershed.bbox ? `${(watershed.bbox.maxLon - watershed.bbox.minLon).toFixed(2)}° of longitude and ${(watershed.bbox.maxLat - watershed.bbox.minLat).toFixed(2)}° of latitude` : 'an unknown extent'}.`;
      data = { bbox: watershed.bbox, centroid: watershed.centroid, areaKm2: watershed.areaKm2 };
      break;
    }
    case 'stations_in_watershed': {
      const byType = stations.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.type]: (acc[s.type] ?? 0) + 1 }), {});
      summary = `${stations.length} stations fall within ${watershed.name}: ${Object.entries(byType).map(([t, n]) => `${n} ${t.replace('_', ' ')}`).join(', ')}.`;
      data = { stations, byType };
      break;
    }
    default: {
      summary = `${watershed.name} contains ${subbasins.length} subbasins ranging from ${Math.min(...subbasins.map((s) => s.areaKm2)).toFixed(0)} to ${Math.max(...subbasins.map((s) => s.areaKm2)).toFixed(0)} km².`;
      data = { subbasins };
    }
  }

  return ok(summary, {
    data: { ...data, operation, watershed },
    maps: [
      mapSpec({
        title: `GIS query: ${operation.replace(/_/g, ' ')}`,
        caption: 'Result of the spatial query over the project layers.',
        center: [watershed.centroid?.lon ?? -77.6, watershed.centroid?.lat ?? 39.3],
        zoom: 7.5,
        layers: [
          { id: 'basins', label: 'Watershed', kind: 'geojson', data: await ctx.db.getWatershedGeoJson(watershed.id) },
          {
            id: 'stations',
            label: 'Stations',
            kind: 'points',
            data: {
              type: 'FeatureCollection',
              features: stations.map((s) => ({
                type: 'Feature',
                properties: { name: s.name, code: s.code, stationType: s.type },
                geometry: { type: 'Point', coordinates: [s.location.lon, s.location.lat] },
              })),
            },
          },
        ],
      }),
    ],
    provenance: p.build(args),
  });
}

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** analyze_precipitation */
export async function analyzePrecipitation(ctx: ToolContext, args: { startDate?: string; endDate?: string } = {}): Promise<ToolResult> {
  const p = new ProvenanceBuilder('analyze_precipitation', { projectId: ctx.projectId, userId: ctx.userId });
  const precip = await ctx.db.getSeries({ variable: 'precipitation', start: args.startDate, end: args.endDate });
  const flow = await ctx.db.getSeries({ variable: 'discharge', start: args.startDate, end: args.endDate });
  if (precip.points.length < 365) return insufficient(p, 'At least one year of precipitation is required.', args);

  const values = precip.points.map((pt) => pt.v ?? 0);
  const dates = precip.points.map((pt) => pt.t);
  const years = values.length / 365.25;
  const annual = values.reduce((a, b) => a + b, 0) / years;
  const wetDays = values.filter((v) => v >= 1).length / years;
  const maxDaily = Math.max(...values);
  const maxDate = dates[values.indexOf(maxDaily)];

  const byMonth = new Map<number, number[]>();
  for (let i = 0; i < dates.length; i++) {
    const m = Number(dates[i].slice(5, 7));
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(values[i]);
  }
  const monthlyMean = [...byMonth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, v]) => ({ month: m, mmPerMonth: (v.reduce((a, b) => a + b, 0) / years) }));

  // Lagged correlation between precipitation and discharge.
  const flowValues = flow.points.map((pt) => pt.v ?? 0);
  const lags = Array.from({ length: 11 }, (_, k) => k);
  const correlations = lags.map((lag) => {
    const x: number[] = [];
    const y: number[] = [];
    for (let i = lag; i < Math.min(values.length, flowValues.length); i++) {
      x.push(values[i - lag]);
      y.push(flowValues[i]);
    }
    const mx = mean(x);
    const my = mean(y);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    return { lagDays: lag, r: sxy / Math.sqrt(sxx * syy) };
  });
  const bestLag = correlations.reduce((a, b) => (b.r > a.r ? b : a));
  ctx.emit?.('Computed precipitation statistics and the rainfall-runoff lag', 'ok', `peak correlation at ${bestLag.lagDays} d`);

  p.source(demoSource('Basin-average precipitation and outlet discharge', ['precipitation', 'discharge'], { precipitation: 'mm', discharge: 'm3/s' }, { start: dates[0], end: dates[dates.length - 1] }, values.length, 'Potomac Demonstration Watershed'))
    .method({ name: 'Lagged Pearson correlation between precipitation and discharge', kind: 'statistic', implementation: 'apps/api/src/services/analysis/gis.ts', reference: METHOD_REFERENCES.nse, parameters: { maxLagDays: 10 } })
    .step('summarise', 'Computed annual totals, wet-day frequency and the monthly distribution.', { wetDayThresholdMm: 1 })
    .step('correlate', 'Correlated precipitation with discharge at lags of 0 to 10 days.', {})
    .coverage(dates[0], dates[dates.length - 1])
    .assume('A wet day is one with at least 1 mm of precipitation, the WMO convention.')
    .limit('Correlation between daily rainfall and daily flow is dominated by antecedent wetness; it identifies the response lag, not a causal transfer function.')
    .uncertain({ sources: ['Areal precipitation estimation error.'], qualitative: 'moderate' });

  return ok(
    `Mean annual precipitation is ${annual.toFixed(0)} mm over ${wetDays.toFixed(0)} wet days per year. The largest daily total in the record is ${maxDaily.toFixed(1)} mm on ${maxDate}. ` +
      `Discharge correlates most strongly with precipitation at a lag of ${bestLag.lagDays} day${bestLag.lagDays === 1 ? '' : 's'} (r = ${bestLag.r.toFixed(2)}).`,
    {
      data: { annualMm: annual, wetDaysPerYear: wetDays, maxDailyMm: maxDaily, maxDailyDate: maxDate, monthlyMean, correlations, bestLag },
      metrics: { annualPrecipitationMm: annual, wetDaysPerYear: wetDays, maxDailyMm: maxDaily, bestLagDays: bestLag.lagDays, bestLagR: bestLag.r },
      quantities: { annualPrecipitation: q(annual, 'mm'), maxDaily: q(maxDaily, 'mm') },
      charts: [
        lineChart({
          kind: 'bar',
          title: 'Mean monthly precipitation',
          xLabel: 'Month',
          yLabel: 'Precipitation',
          unit: 'mm',
          series: [{ key: 'mm', label: 'Mean monthly total', color: CHART_COLORS.secondary }],
          data: monthlyMean.map((m) => ({ t: new Date(Date.UTC(2020, m.month - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), mm: m.mmPerMonth })),
          caption: 'Average precipitation total in each calendar month across the record.',
        }),
        lineChart({
          kind: 'line',
          title: 'Precipitation–discharge lagged correlation',
          xLabel: 'Lag (days)',
          yLabel: 'Pearson r',
          unit: 'dimensionless',
          series: [{ key: 'r', label: 'Correlation', color: CHART_COLORS.observed }],
          data: correlations.map((c) => ({ t: String(c.lagDays), r: c.r })),
          caption: 'Correlation between daily precipitation and discharge lagged by 0 to 10 days. The peak indicates the catchment response time.',
        }),
      ],
      provenance: p.build(args),
    },
  );
}
