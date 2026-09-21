import type { AppConfig } from '@hydro/config';
import { MemoryDataAccess } from './memory.js';
import { PostgresDataAccess } from './postgres.js';
import type { DataAccess } from './types.js';

export * from './types.js';
export { MemoryDataAccess } from './memory.js';
export { PostgresDataAccess } from './postgres.js';

export interface StoreHandle {
  db: DataAccess;
  /** Always available — the synthetic demonstration watershed. */
  demo: MemoryDataAccess;
  databaseStatus: 'online' | 'offline' | 'not_configured';
  note: string;
}

/**
 * Resolve the persistence backend.
 *
 * PostgreSQL is used when DATABASE_URL is set and the schema is reachable.
 * Otherwise the platform runs on the in-memory synthetic store — fully
 * functional, explicitly non-durable, and reported as such by /api/status so
 * that nobody mistakes a demonstration session for a persisted one.
 */
export async function createStore(config: AppConfig, log: { info: (m: string) => void; warn: (m: string) => void }): Promise<StoreHandle> {
  const demo = new MemoryDataAccess();
  await demo.init();

  if (!config.databaseUrl) {
    log.info('DATABASE_URL is not set — running on the in-memory synthetic store. Nothing will be persisted.');
    return {
      db: demo,
      demo,
      databaseStatus: 'not_configured',
      note: 'No DATABASE_URL configured. Running on the in-memory synthetic demonstration store; created entities are lost when the process exits.',
    };
  }

  const pg = new PostgresDataAccess(config.databaseUrl);
  try {
    await pg.init();
    log.info('Connected to PostgreSQL/PostGIS.');
    return { db: pg, demo, databaseStatus: 'online', note: 'PostgreSQL/PostGIS connected.' };
  } catch (err) {
    await pg.close().catch(() => undefined);
    log.warn(
      `DATABASE_URL is set but the schema could not be reached (${(err as Error).message}). ` +
        'Falling back to the in-memory synthetic store. Run `npm run db:migrate && npm run db:seed` to initialise the database.',
    );
    return {
      db: demo,
      demo,
      databaseStatus: 'offline',
      note: `PostgreSQL unreachable: ${(err as Error).message}. Serving the in-memory synthetic store instead.`,
    };
  }
}
