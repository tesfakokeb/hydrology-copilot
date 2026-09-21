/**
 * Copy @fastify/swagger-ui's static assets next to the bundle.
 *
 * The plugin resolves its assets relative to its own package directory, which
 * esbuild's bundle does not preserve. Rather than marking the plugin external
 * (which would drag node_modules into the runtime image), its ~20 static files
 * are copied into dist/static, where the bundled plugin looks for them.
 *
 * Run automatically by `npm run build`.
 */

import { cp, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

async function main() {
  let source;
  try {
    // Resolve through the package's own entry point so workspace hoisting,
    // pnpm layouts and plain installs all work.
    source = join(dirname(require.resolve('@fastify/swagger-ui')), 'static');
  } catch {
    console.warn('@fastify/swagger-ui is not installed; skipping static asset copy.');
    return;
  }

  const target = join(dist, 'static');
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  const files = await readdir(target);
  console.log(`Copied ${files.length} Swagger UI assets to dist/static.`);
}

await main();
