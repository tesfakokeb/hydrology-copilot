# Seed data

The demonstration dataset is **generated**, not stored. `apps/api/src/demo/potomac.ts` produces the
Potomac Demonstration Watershed deterministically from a fixed seed, and
`apps/api/src/scripts/seed.ts` loads it into PostgreSQL.

```bash
DATABASE_URL=postgres://hydro:hydro@localhost:5432/hydro npm run db:seed
```

Generating rather than shipping fixtures means:

- the in-memory store and the seeded database contain *identical* values, so a database-free run and
  a seeded run show the same numbers;
- the repository carries no multi-megabyte CSVs;
- regenerating with a different seed or record length is one argument, not a data-preparation task.

Every row is written with `is_synthetic = true`. Nothing here is an observation.

See `docs/scientific-methods.md` §"The demonstration dataset" for the generator's structure and the
water-balance properties it satisfies.
