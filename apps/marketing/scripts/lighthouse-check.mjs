// Lighthouse against the built static output, fully offline (local server, external
// hosts such as Google Fonts are blocked by Chromium flags). Thresholds are asserted;
// scores are printed. Requires out/ (npm run build -w apps/marketing).
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve-static.mjs';
import { chromiumPath } from './chromium.mjs';

const MIN = { performance: 0.85, accessibility: 0.95, 'best-practices': 0.9, seo: 0.95 };
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
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
  for (const p of ['/', '/en/']) {
    for (const preset of ['mobile', 'desktop']) {
      const flags = {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: Object.keys(MIN),
      };
      const config =
        preset === 'desktop'
          ? (await import('lighthouse/core/config/desktop-config.js')).default
          : undefined;
      const { lhr } = await lighthouse(origin + p, flags, config);
      const row = Object.entries(MIN).map(([k, min]) => {
        const s = lhr.categories[k].score ?? 0;
        if (s < min) failed = true;
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
      console.log(`${p.padEnd(5)} ${preset.padEnd(8)} ${row.join(' ')} ${m}`);
    }
  }
} finally {
  await chrome.kill();
  server.close();
}
console.log(failed ? 'lighthouse FAILED thresholds' : 'lighthouse OK');
process.exit(failed ? 1 : 0);
