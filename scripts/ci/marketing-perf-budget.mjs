#!/usr/bin/env node
// Marketing performance budget (marketing-levelup P2): fails the PR lane when a page gets heavier than the budget.
//   node scripts/ci/marketing-perf-budget.mjs [--out apps/marketing/out] [--record file.json] [--lcp]
// 1) JS BUDGET (always, deterministic, no browser): the gzip size of every script the page's HTML loads up front
//    (<script src>, modulepreload/preload as=script) must stay under `jsGzipKb` ("JS < 200KB before 3D": the 3D viewer
//    and model files are lazy chunks the HTML never lists, so they are outside this number by construction; a chunk
//    that creeps into the up-front list is exactly what this catches).
// 2) CSS and HTML are budgeted the same way (`cssGzipKb`, `htmlGzipKb`), and no page may ship more than `maxScripts` scripts.
// 3) --lcp (needs Chromium: CHROME_PATH or playwright's): Lighthouse mobile, median of 3, LCP target `lcpMs` (2500) is reported; the PR fails only above `lcpGateMs` (see the _lcp note in the json).
//    Shared CI runners are noisy, so the LCP assertion uses the median and is OFF unless asked for.
// Budget numbers live in scripts/ci/marketing-perf-budget.json so a deliberate increase is a reviewed diff.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const root = path.resolve(opt('--out', 'apps/marketing/out'));
const budget = JSON.parse(
  readFileSync(new URL('./marketing-perf-budget.json', import.meta.url), 'utf8')
);

const gz = f => gzipSync(readFileSync(f)).length;
const kb = n => Math.round((n / 1024) * 10) / 10;

function pages(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '_next' || e.name.startsWith('__next')) continue;
      pages(p, out);
    } else if (e.name === 'index.html') out.push(p);
  }
  return out;
}

/** The scripts and styles an HTML file loads up front, as absolute files under `root`. */
export function assets(html) {
  const scripts = new Set();
  const styles = new Set();
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) scripts.add(m[1]);
  for (const m of html.matchAll(
    /<link[^>]*rel="(?:modulepreload|preload)"[^>]*as="script"[^>]*href="([^"]+)"/g
  ))
    scripts.add(m[1]);
  for (const m of html.matchAll(/<link[^>]*href="([^"]+)"[^>]*rel="(?:modulepreload)"/g))
    scripts.add(m[1]);
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) styles.add(m[1]);
  for (const m of html.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*rel="stylesheet"/g))
    styles.add(m[1]);
  const abs = u => (u.startsWith('/') ? path.join(root, u.split('?')[0]) : null);
  return {
    scripts: [...scripts].map(abs).filter(Boolean),
    styles: [...styles].map(abs).filter(Boolean),
  };
}

export function measure(file) {
  const html = readFileSync(file, 'utf8');
  const { scripts, styles } = assets(html);
  const exists = f => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  return {
    page: '/' + path.relative(root, path.dirname(file)).replace(/\\/g, '/'),
    scripts: scripts.length,
    jsGzip: scripts.filter(exists).reduce((n, f) => n + gz(f), 0),
    cssGzip: styles.filter(exists).reduce((n, f) => n + gz(f), 0),
    htmlGzip: gz(file),
  };
}

const rows = pages(root)
  .map(measure)
  .sort((a, b) => a.page.localeCompare(b.page));
if (rows.length === 0) throw new Error(`no pages under ${root}: build apps/marketing first`);
let failed = false;
for (const r of rows) {
  const lim = { ...budget.default, ...(budget.pages?.[r.page] ?? {}) };
  const over = [];
  if (r.jsGzip > lim.jsGzipKb * 1024) over.push(`js ${kb(r.jsGzip)}KB > ${lim.jsGzipKb}KB`);
  if (r.cssGzip > lim.cssGzipKb * 1024) over.push(`css ${kb(r.cssGzip)}KB > ${lim.cssGzipKb}KB`);
  if (r.htmlGzip > lim.htmlGzipKb * 1024)
    over.push(`html ${kb(r.htmlGzip)}KB > ${lim.htmlGzipKb}KB`);
  if (r.scripts > lim.maxScripts) over.push(`${r.scripts} scripts > ${lim.maxScripts}`);
  if (over.length) failed = true;
  console.log(
    `${over.length ? 'OVER' : 'ok  '} ${r.page.padEnd(34)} js=${kb(r.jsGzip)}KB css=${kb(r.cssGzip)}KB html=${kb(r.htmlGzip)}KB scripts=${r.scripts} ${over.join('; ')}`
  );
}
if (opt('--record')) writeFileSync(opt('--record'), JSON.stringify(rows, null, 2) + '\n');

if (args.includes('--lcp')) {
  const { launch } = await import('chrome-launcher');
  const { default: lighthouse } = await import('lighthouse');
  const { startServer } = await import('../../packages/site-kit/src/gates/serve-static.mjs');
  const server = await startServer(root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromePath =
    process.env.CHROME_PATH || (await import('@playwright/test')).chromium.executablePath();
  const chrome = await launch({
    chromePath,
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  try {
    for (const p of budget.lcpPages) {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const { lhr } = await lighthouse(origin + p, {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance'],
        });
        samples.push(lhr.audits['largest-contentful-paint'].numericValue);
      }
      samples.sort((a, b) => a - b);
      const med = Math.round(samples[1]);
      const bad = med >= budget.lcpGateMs;
      if (bad) failed = true;
      const status = bad ? 'OVER' : med >= budget.lcpMs ? 'warn' : 'ok  ';
      console.log(
        `${status} LCP ${p.padEnd(10)} median ${med}ms (target ${budget.lcpMs}ms, gate ${budget.lcpGateMs}ms) samples ${samples.map(Math.round).join(', ')}`
      );
    }
  } finally {
    await chrome.kill();
    server.close();
  }
}
console.log(failed ? 'marketing performance budget FAILED' : 'marketing performance budget OK');
process.exit(failed ? 1 : 0);
