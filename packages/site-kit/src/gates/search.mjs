// Search smoke gate: loads the built search page in Chromium, runs real queries through the
// shipped MiniSearch index + client script, and asserts the expected article is among the hits.
import { chromium } from 'playwright-core';
import { chromiumPath } from './chromium.mjs';
import { startServer } from './serve-static.mjs';

/**
 * @param {{root:string, name?:string, cases:{page:string, q:string, expect:string}[]}} opts
 */
export async function runSearchCheck({ root, name = 'site', cases }) {
  const server = await startServer(root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  let failed = 0;
  try {
    for (const c of cases) {
      const page = await browser.newPage();
      await page.goto(`${origin}${c.page}?q=${encodeURIComponent(c.q)}`);
      await page.waitForSelector('#results li', { timeout: 5000 }).catch(() => {});
      const hrefs = await page.$$eval('#results li a', as => as.map(a => a.getAttribute('href')));
      const ok = hrefs.includes(c.expect);
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.page} q=${c.q} -> ${hrefs.slice(0, 3).join(' ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `search FAILED (${name})` : `search OK (${name}): ${cases.length} queries`);
  process.exit(failed ? 1 : 0);
}
