import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@hydro/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
      '@hydro/units': resolve(__dirname, '../../packages/units/src/index.ts'),
      '@hydro/hydrology-core': resolve(__dirname, '../../packages/hydrology-core/src/index.ts'),
      '@hydro/config': resolve(__dirname, '../../packages/config/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // The API is stateful within a run (in-memory store), so tests share one
    // server instance and must not run concurrently against it.
    fileParallelism: false,
  },
});
