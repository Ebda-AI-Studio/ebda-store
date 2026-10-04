// Lighthouse against a built static directory, fully offline (local server; external hosts
// such as Google Fonts are blocked by Chromium flags). Thresholds are asserted; scores printed.
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { startServer } from './serve-static.mjs';
import { chromiumPath } from './chromium.mjs';

export const DEFAULT_MIN = {
  performance: 0.85,
  accessibility: 0.95,
  'best-practices': 0.9,
  seo: 0.95,
};

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string[]} opts.pages
 * @param {string} [opts.name]
 * @param {Record<string, number>} [opts.min]
 * @param {('mobile'|'desktop')[]} [opts.presets]
 */
export async function runLighthouse({
  root,
  pages,
  name = 'site',
  min = DEFAULT_MIN,
  presets = ['mobile', 'desktop'],
}) {
  const server = await startServer(root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launch({
    chromePath: chromiumPath(),
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  let failed = false;
  try {
    for (const p of pages) {
      for (const preset of presets) {
        const flags = {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: Object.keys(min),
        };
        const config =
          preset === 'desktop'
            ? (await import('lighthouse/core/config/desktop-config.js')).default
            : undefined;
        const { lhr } = await lighthouse(origin + p, flags, config);
        const row = Object.entries(min).map(([k, floor]) => {
          const s = lhr.categories[k].score ?? 0;
          if (s < floor) failed = true;
          return `${k}=${Math.round(s * 100)}`;
        });
        const m = [
          'largest-contentful-paint',
          'total-blocking-time',
          'cumulative-layout-shift',
          'first-contentful-paint',
        ]
          .map(
            a =>
              a
                .split('-')
                .map(w => w[0])
                .join('') +
              '=' +
              lhr.audits[a].displayValue
          )
          .join(' ');
        console.log(`${name} ${p.padEnd(24)} ${preset.padEnd(8)} ${row.join(' ')} ${m}`);
      }
    }
  } finally {
    await chrome.kill();
    server.close();
  }
  console.log(failed ? `lighthouse FAILED thresholds (${name})` : `lighthouse OK (${name})`);
  process.exit(failed ? 1 : 0);
}
