/**
 * Load the synthetic Potomac Demonstration Watershed into PostgreSQL/PostGIS.
 *
 *   npm run db:seed
 *
 * The same generator that backs the in-memory store produces the rows, so a
 * seeded database and a database-free run show identical numbers. Every row is
 * written with is_synthetic = true.
 *
 * The seed is idempotent: it upserts on the natural keys and can be re-run.
 */

import bcrypt from 'bcryptjs';
import { DEMO_USER } from '@hydro/config';
import pg from 'pg';
import { buildDemoWatershed, DEMO_IDS } from '../demo/potomac.js';

const BATCH = 2000;

function polygonWkt(ring: [number, number][]): string {
  const coords = ring.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
  return `MULTIPOLYGON(((${coords})))`;
}

function lineWkt(line: [number, number][]): string {
  const coords = line.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
  return `MULTILINESTRING((${coords}))`;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Run `npm run db:migrate` against a database first.');
    process.exit(1);
  }

  const demo = buildDemoWatershed(30);
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('SET search_path TO hydro, public');

  const t0 = Date.now();
  try {
    await client.query('BEGIN');

    // ---- User and project -------------------------------------------------
    await client.query(
      `INSERT INTO users (id, email, full_name, organization, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,'admin')
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [DEMO_IDS.user, DEMO_USER.email, DEMO_USER.fullName, DEMO_USER.organization, bcrypt.hashSync(DEMO_USER.password, 10)],
    );

    await client.query(
      `INSERT INTO projects (id, name, description, agency, unit_system, created_by)
       VALUES ($1,$2,$3,$4,'SI',$5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
      [
        DEMO_IDS.project,
        'Potomac Demonstration Project',
        'Pre-loaded demonstration project exercising every analytical module against synthetic data.',
        'Hydrology Copilot Demo',
        DEMO_IDS.user,
      ],
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`,
      [DEMO_IDS.project, DEMO_IDS.user],
    );

    // ---- Watershed, subbasins, reaches ------------------------------------
    const w = demo.watershed;
    await client.query(
      `INSERT INTO watersheds (id, project_id, name, huc, area_km2, description, is_demo, geom, outlet_point)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE, ST_GeomFromText($7, 4326), ST_SetSRID(ST_MakePoint($8,$9), 4326))
       ON CONFLICT (id) DO UPDATE SET geom = EXCLUDED.geom, area_km2 = EXCLUDED.area_km2`,
      [w.id, DEMO_IDS.project, w.name, w.huc, w.areaKm2, w.description, polygonWkt(w.polygon), w.outlet.lon, w.outlet.lat],
    );
    await client.query('UPDATE projects SET default_watershed_id = $1 WHERE id = $2', [w.id, DEMO_IDS.project]);

    for (const s of demo.subbasins) {
      await client.query(
        `INSERT INTO subbasins (id, watershed_id, name, area_km2, mean_elevation_m, mean_slope_pct, curve_number, dominant_land_cover, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ST_GeomFromText($9, 4326))
         ON CONFLICT (id) DO UPDATE SET geom = EXCLUDED.geom`,
        [s.id, w.id, s.name, s.areaKm2, s.meanElevationM, s.meanSlopePct, s.curveNumber, s.dominantLandCover, polygonWkt(s.polygon)],
      );
    }

    for (const r of demo.reaches) {
      await client.query(
        `INSERT INTO reaches (id, watershed_id, name, stream_order, length_km, geom)
         VALUES ($1,$2,$3,$4,$5, ST_GeomFromText($6, 4326))
         ON CONFLICT (id) DO UPDATE SET geom = EXCLUDED.geom`,
        [r.id, w.id, r.name, r.streamOrder, r.lengthKm, lineWkt(r.line)],
      );
    }

    // ---- Stations ---------------------------------------------------------
    for (const s of demo.stations) {
      await client.query(
        `INSERT INTO stations (id, watershed_id, subbasin_id, code, name, type, operator, elevation_m, drainage_area_km2, is_synthetic, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE, ST_SetSRID(ST_MakePoint($10,$11), 4326))
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
        [s.id, w.id, s.subbasinId, s.code, s.name, s.type, s.operator, s.elevationM, s.drainageAreaKm2, s.lon, s.lat],
      );
    }
    console.log(`✓ watershed, ${demo.subbasins.length} subbasins, ${demo.reaches.length} reaches, ${demo.stations.length} stations`);

    // ---- Time series ------------------------------------------------------
    const gauges = demo.stations.filter((s) => s.type === 'streamgage');
    const daily = demo.daily;

    for (const gauge of gauges) {
      const values = daily.byGage[gauge.code] ?? daily.dischargeM3s;
      await copyRows(
        client,
        'streamflow (station_id, ts, discharge, stage, unit, stage_unit, quality_flag)',
        daily.dates.map((d, i) => [gauge.id, d, values[i], gauge.code === gauges[0].code ? daily.stageM[i] : null, 'm3/s', 'm', 'approved']),
      );
    }
    console.log(`✓ ${daily.dates.length * gauges.length} streamflow rows`);

    const precipStation = demo.stations.find((s) => s.type === 'precipitation')!;
    await copyRows(
      client,
      'precipitation (station_id, ts, depth, unit, accumulation_hours, quality_flag)',
      daily.dates.map((d, i) => [precipStation.id, d, daily.precipMm[i], 'mm', 24, 'approved']),
    );
    console.log(`✓ ${daily.dates.length} precipitation rows`);

    const weather = demo.stations.find((s) => s.type === 'weather')!;
    await copyRows(
      client,
      'climate (station_id, ts, temperature_mean, temperature_min, temperature_max, et_reference, et_actual, soil_moisture, temperature_unit, et_unit, quality_flag)',
      daily.dates.map((d, i) => [
        weather.id, d, daily.tmeanC[i], daily.tminC[i], daily.tmaxC[i],
        daily.petMm[i], daily.aetMm[i], daily.soilMoistureMm[i], 'degC', 'mm', 'approved',
      ]),
    );
    console.log(`✓ ${daily.dates.length} climate rows`);

    // ---- Water quality ----------------------------------------------------
    const stationByCode = new Map(demo.stations.map((s) => [s.code, s]));
    await copyRows(
      client,
      'water_quality (station_id, ts, parameter, value, unit, quality_flag)',
      demo.waterQuality
        .filter((r) => stationByCode.has(r.stationCode))
        .map((r) => [stationByCode.get(r.stationCode)!.id, r.t, r.parameter, r.value, r.unit, 'approved']),
      'ON CONFLICT (station_id, ts, parameter) DO NOTHING',
    );
    console.log(`✓ ${demo.waterQuality.length} water-quality rows`);

    // ---- Reservoir --------------------------------------------------------
    const res = demo.reservoir;
    await client.query(
      `INSERT INTO reservoirs (id, watershed_id, name, capacity_mcm, dead_storage_mcm, conservation_pool_mcm, flood_pool_mcm, purpose, is_synthetic, geom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE, ST_SetSRID(ST_MakePoint($9,$10), 4326))
       ON CONFLICT (id) DO UPDATE SET capacity_mcm = EXCLUDED.capacity_mcm`,
      [res.id, w.id, res.name, res.capacityMcm, res.deadStorageMcm, res.conservationPoolMcm, res.floodPoolMcm, res.purpose, res.lon, res.lat],
    );
    await copyRows(
      client,
      'reservoir_observations (reservoir_id, ts, storage_mcm, elevation_m, inflow_m3s, release_m3s, spill_m3s, evaporation_mcm, quality_flag)',
      res.monthly.map((m) => [res.id, m.t, m.storageMcm, m.elevationM, m.inflowM3s, m.releaseM3s, m.spillM3s, m.evaporationMcm, 'approved']),
    );
    console.log(`✓ reservoir and ${res.monthly.length} monthly observations`);

    // ---- Demand and supply ------------------------------------------------
    await copyRows(
      client,
      'water_demand (project_id, watershed_id, ts, sector, demand, unit, population, is_synthetic)',
      demo.demand.map((d) => [DEMO_IDS.project, w.id, d.t, d.sector, d.demandMcm, 'MCM', d.population, true]),
      'ON CONFLICT (project_id, ts, sector) DO NOTHING',
    );
    console.log(`✓ ${demo.demand.length} demand rows`);

    // ---- Groundwater ------------------------------------------------------
    const gw = demo.stations.find((s) => s.type === 'groundwater');
    if (gw) {
      await copyRows(
        client,
        'groundwater (station_id, ts, depth_to_water_m, quality_flag)',
        demo.groundwater.map((g) => [gw.id, g.t, g.depthToWaterM, 'approved']),
      );
      console.log(`✓ ${demo.groundwater.length} groundwater rows`);
    }

    // ---- Dataset catalogue ------------------------------------------------
    const datasets = [
      ['Daily streamflow — Potomac demo network', 'csv', 'Daily mean discharge at three synthetic gauges.'],
      ['Daily precipitation — basin average', 'csv', 'Basin-average daily precipitation depth.'],
      ['Daily climate — temperature and ET', 'csv', 'Tmax/Tmin/Tmean, Hargreaves reference ET and modelled actual ET.'],
      ['Water quality — 3 stations, 13 parameters', 'csv', 'Monthly synthetic water-quality samples.'],
      ['Reservoir operations — Catoctin demo', 'csv', 'Monthly storage, inflow, release, spill and evaporation.'],
      ['Water demand — municipal, agricultural, industrial', 'csv', 'Monthly sectoral demand.'],
    ];
    for (const [name, format, description] of datasets) {
      await client.query(
        `INSERT INTO datasets (project_id, name, description, format, source, version, storage_uri, size_bytes, is_synthetic, uploaded_by)
         VALUES ($1,$2,$3,$4,'Hydrology Copilot synthetic generator v1.0.0','1.0.0',$5,0,TRUE,$6)
         ON CONFLICT DO NOTHING`,
        [DEMO_IDS.project, name, description, format, `synthetic://${name}`, DEMO_IDS.user],
      );
    }

    await client.query('COMMIT');
    console.log(`\nSeed complete in ${((Date.now() - t0) / 1000).toFixed(1)} s. Every row is flagged synthetic.`);
    console.log(`Sign in as ${DEMO_USER.email} / ${DEMO_USER.password}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`\nSeed failed and was rolled back:\n${(err as Error).message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

/** Batched multi-row INSERT. Fast enough for a demo seed without COPY. */
async function copyRows(client: pg.Client, target: string, rows: unknown[][], onConflict = 'ON CONFLICT DO NOTHING'): Promise<void> {
  if (rows.length === 0) return;
  const cols = rows[0].length;
  for (let start = 0; start < rows.length; start += BATCH) {
    const chunk = rows.slice(start, start + BATCH);
    const params: unknown[] = [];
    const tuples = chunk.map((row, i) => {
      params.push(...row);
      return `(${Array.from({ length: cols }, (_, c) => `$${i * cols + c + 1}`).join(',')})`;
    });
    await client.query(`INSERT INTO ${target} VALUES ${tuples.join(',')} ${onConflict}`, params);
  }
}

void main();
