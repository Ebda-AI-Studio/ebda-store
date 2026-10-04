// Automated accessibility gate: axe-core against a BUILT static directory. Fails (exit 1)
// on any serious/critical violation at every viewport. Chromium comes from
// PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers); never runs `playwright install`.
// Shared by apps/marketing, apps/docs, apps/help and apps/status (snapshot).
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumPath } from './chromium.mjs';
import { startServer } from './serve-static.mjs';

const require = createRequire(import.meta.url);

/**
 * @param {object} opts
 * @param {string} opts.root              directory to serve (contains index.html)
 * @param {string[]} opts.pages           URL paths to scan
 * @param {string} [opts.name]            label for log output
 * @param {{width:number,height:number}[]} [opts.viewports]
 * @param {string[]} [opts.reducedMotion] media-feature values to scan under
 */
export async function runA11y({
  root,
  pages,
  name = 'site',
  viewports = [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ],
  reducedMotion = ['no-preference'],
}) {
  if (!existsSync(path.join(root, 'index.html'))) {
    console.error(`${root}/index.html missing: build ${name} first`);
    process.exit(2);
  }
  const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const server = await startServer(root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  let failures = 0;
  const summary = [];
  try {
    for (const viewport of viewports) {
      for (const motion of reducedMotion) {
        const ctx = await browser.newContext({ viewport, reducedMotion: motion });
        // Offline-safe: external hosts (Google Fonts) are blocked; system fonts are used.
        await ctx.route(
          u => new URL(u).hostname !== '127.0.0.1',
          r => r.abort()
        );
        for (const p of pages) {
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
            `${p.padEnd(28)} ${viewport.width}px motion=${motion.padEnd(13)} serious/critical=${bad.length} other=${minor.length}`
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
      ? `a11y FAILED (${name}): ${failures} serious/critical violation(s)`
      : `a11y OK (${name}): 0 serious/critical violations on ${pages.length} pages x ${viewports.length} viewports`
  );
  process.exit(failures ? 1 : 0);
}
