// Search smoke gate: loads the built search page in Chromium, runs real queries through the
// shipped MiniSearch index + client script, and asserts the expected article is among the hits.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { chromiumPath } from './chromium.mjs';
import { startServer } from './serve-static.mjs';

const require = createRequire(import.meta.url);

/**
 * `typeahead` cases type into the HEADER box (no submit) and expect the dropdown to list `expect`,
 * with the combobox ARIA wired and ArrowDown moving aria-activedescendant to the first option.
 * @param {{root:string, name?:string, cases:{page:string, q:string, expect:string}[], typeahead?:{page:string, q:string, expect:string}[]}} opts
 */
export async function runSearchCheck({ root, name = 'site', cases, typeahead = [] }) {
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
    for (const c of typeahead) {
      const page = await browser.newPage();
      const resp = await page.goto(`${origin}${c.page}`);
      // A `status` on the case asserts the HTTP status (the 404 pages must stay a real 404).
      if (c.status && resp?.status() !== c.status) {
        failed++;
        console.log(`FAIL ${c.page} status ${resp?.status()} (want ${c.status})`);
      }
      await page.focus(c.input ?? '#q');
      await page.keyboard.type(c.q);
      // Results refresh while typing: wait for the expected article (or time out and report what is there).
      await page
        .waitForFunction(
          href =>
            [...document.querySelectorAll('.ta-list [role=option]')].some(
              a => a.getAttribute('href') === href
            ),
          c.expect,
          { timeout: 5000 }
        )
        .catch(() => {});
      const hrefs = await page.$$eval('.ta-list [role=option]', as =>
        as.map(a => a.getAttribute('href'))
      );
      const expanded = await page.getAttribute(c.input ?? '#q', 'aria-expanded');
      await page.keyboard.press('ArrowDown');
      const active = await page.getAttribute(c.input ?? '#q', 'aria-activedescendant');
      const firstId = await page.$eval('.ta-list [role=option]', o => o.id).catch(() => null);
      // axe on the OPEN dropdown (the static a11y gate only sees the closed page).
      await page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
      const axe = await page.evaluate(() =>
        window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        })
      );
      const bad = axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
      for (const v of bad) console.log('   axe', v.id, v.nodes[0]?.html?.slice(0, 120));
      const ok =
        hrefs.includes(c.expect) &&
        expanded === 'true' &&
        !!active &&
        active === firstId &&
        !bad.length;
      if (!ok) failed++;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} typeahead ${c.page} q=${c.q} -> ${hrefs.slice(0, 3).join(' ')} expanded=${expanded} active=${active}`
      );
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(
    failed
      ? `search FAILED (${name})`
      : `search OK (${name}): ${cases.length + typeahead.length} queries`
  );
  process.exit(failed ? 1 : 0);
}
