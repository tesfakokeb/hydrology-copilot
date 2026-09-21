/**
 * Capture screenshots of the running application for visual verification.
 *
 *   node scripts/screenshot.mjs [outputDir]
 *
 * Requires the API (port 4000) and the web dev server (port 5173) to be
 * running. Signs in with the demonstration account, walks the main routes and
 * writes a PNG per route. Console errors are reported so a page that renders
 * but throws does not pass silently.
 */

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/hydro-shots';
const BASE = process.env.WEB_URL ?? 'http://localhost:5173';

const ROUTES = [
  ['dashboard', '/', 4000],
  ['copilot', '/copilot', 2500],
  ['streamflow', '/streamflow', 5000],
  ['drought', '/drought', 6000],
  ['water-quality', '/water-quality', 5000],
  ['watershed-modeling', '/watershed-modeling', 5000],
  ['flood-risk', '/flood-risk', 6000],
  ['flood-forecasting', '/flood-forecasting', 6000],
  ['water-supply', '/water-supply', 5000],
  ['water-demand', '/water-demand', 5000],
  ['gis', '/gis', 5000],
  ['data-explorer', '/data-explorer', 3000],
  ['forecasts', '/forecasts', 8000],
  ['model-runs', '/model-runs', 2500],
  ['reports', '/reports', 2500],
  ['projects', '/projects', 2000],
  ['settings', '/settings', 2500],
];

await mkdir(OUT, { recursive: true });

// Resolve the bundled Chromium: the container pins it under /opt/pw-browsers.
const candidates = [
  process.env.CHROMIUM_PATH,
  ...(await import('node:fs')).globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome') ?? [],
].filter(Boolean);
const executablePath = candidates[0];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
const page = await context.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`${page.url()} :: ${msg.text().slice(0, 300)}`);
});
page.on('pageerror', (err) => errors.push(`${page.url()} :: ${err.message.slice(0, 300)}`));

// ---- Sign in --------------------------------------------------------------
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/00-login.png`, fullPage: false });

await page.getByRole('button', { name: /demonstration account/i }).click();
await page.waitForSelector('nav[aria-label="Primary"]', { timeout: 30_000 });

// ---- Walk the routes ------------------------------------------------------
let i = 1;
for (const [name, route, wait] of ROUTES) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  const file = `${OUT}/${String(i).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`captured ${file}`);
  i += 1;
}

// ---- Exercise the Copilot end to end --------------------------------------
await page.goto(`${BASE}/copilot`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const prompt = page.getByRole('button', { name: 'Assess drought conditions' });
if (await prompt.count()) {
  await prompt.first().click();
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}-copilot-answer.png`, fullPage: true });
  console.log(`captured ${OUT}/${String(i).padStart(2, '0')}-copilot-answer.png`);
}

await browser.close();

if (errors.length > 0) {
  console.error(`\n${errors.length} console errors:`);
  for (const e of [...new Set(errors)].slice(0, 25)) console.error('  ' + e);
  process.exitCode = 1;
} else {
  console.log('\nNo console errors.');
}
