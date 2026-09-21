import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Test configuration is separate from the build config so that the two Vite
 * copies npm resolves (the app's and Vitest's own) never have to agree on
 * plugin types.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@hydro/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
      '@hydro/units': resolve(__dirname, '../../packages/units/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
