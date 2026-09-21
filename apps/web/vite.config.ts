import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@hydro/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
      '@hydro/units': resolve(__dirname, '../../packages/units/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // The browser never talks to the API's origin directly in development,
      // so there is no CORS surface and no token in a query string.
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          map: ['maplibre-gl'],
        },
      },
    },
  },
});
