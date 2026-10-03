// Automated accessibility gate: axe-core against the BUILT static output (out/).
// Fails (exit 1) on any serious/critical violation, on both locales and the legal
// pages. Chromium comes from PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers);
// never runs `playwright install`.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromiumPath } from './chromium.mjs';
import { startServer } from './serve-static.mjs';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
if (!existsSync(path.join(root, 'index.html'))) {
  console.error('out/ missing: run `npm run build -w apps/marketing` first');
  process.exit(2);
}

const PAGES = [
  '/',
  '/en/',
  '/legal/',
  '/privacy/',
  '/terms/',
  '/en/legal/',
  '/en/privacy/',
  '/en/terms/',
];
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const server = await startServer(root);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
let failures = 0;
const summary = [];
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const ctx = await browser.newContext({ viewport, reducedMotion });
      // Offline-safe: external hosts (Google Fonts) are blocked; system fonts are used.
      await ctx.route(
        u => new URL(u).hostname !== '127.0.0.1',
        r => r.abort()
      );
      for (const p of PAGES) {
        const page = await ctx.newPage();
        await page.goto(origin + p, { waitUntil: 'load' });
        await page.evaluate(axeSource);
        const results = await page.evaluate(() =>
          window.axe.run(document, {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
            },
          })
        );
        const bad = results.violations.filter(
          v => v.impact === 'serious' || v.impact === 'critical'
        );
        const minor = results.violations.filter(v => !bad.includes(v));
        summary.push(
          `${p.padEnd(14)} ${viewport.width}px motion=${reducedMotion.padEnd(13)} serious/critical=${bad.length} other=${minor.length}`
        );
        for (const v of [...bad, ...minor]) {
          console.log(
            `  [${v.impact}] ${p} ${v.id}: ${v.help} (${v.nodes.length} nodes) ${v.nodes[0]?.target}`
          );
        }
        failures += bad.length;
        await page.close();
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(summary.join('\n'));
console.log(
  failures
    ? `a11y FAILED: ${failures} serious/critical violation(s)`
    : 'a11y OK: 0 serious/critical violations'
);
process.exit(failures ? 1 : 0);
