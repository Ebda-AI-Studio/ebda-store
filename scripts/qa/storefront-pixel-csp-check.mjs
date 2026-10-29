#!/usr/bin/env node
/**
 * A demo store with marketing pixels configured loads them under the nonce CSP (Ruling CSP-WEB-1).
 *
 * The REAL loader runs: the storefront's own `MarketingPixels` component renders the `next/script` tags. Only the
 * data and the vendor endpoints are stubbed:
 *  - a tiny local proxy stands in for the API (everything is forwarded to api.ebda.app, but the store payload gets
 *    `marketingPixels` + the `marketing_pixels` feature), so the build must point at it:
 *      cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:4010/api/v1 npx next build && npx next start -p 3919
 *  - Playwright answers the vendor hosts (googletagmanager.com, connect.facebook.net) with stub scripts that, like
 *    the real vendors, inject a second script at runtime. The browser still enforces the CSP before any request.
 *
 *   node scripts/qa/storefront-pixel-csp-check.mjs [--port 3919] [--store storedemo]
 * Exits 1 on a CSP violation or when a pixel script, its injected follow-up or the inline bootstrap did not run.
 */
import http from 'node:http';
import { chromium } from 'playwright';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', '3919'));
const STORE = arg('store', 'storedemo');
const PIXELS = {
  googleTagManager: { enabled: true, containerId: 'GTM-STUB123' },
  meta: { enabled: true, pixelId: '123456789012345' },
};

const patch = o => {
  if (!o || typeof o !== 'object') return o;
  if (o.data?.store && typeof o.data.store === 'object') {
    o.data.store.marketingPixels = PIXELS;
    o.data.enabledFeatures = [...new Set([...(o.data.enabledFeatures ?? []), 'marketing_pixels'])];
  }
  if (o.data && o.data.slug && 'marketingPixels' in o.data) {
    o.data.marketingPixels = PIXELS;
    o.data.enabledFeatures = [...new Set([...(o.data.enabledFeatures ?? []), 'marketing_pixels'])];
  }
  return o;
};
const proxy = http.createServer(async (req, res) => {
  const upstream = await fetch(`https://api.ebda.app${req.url}`, {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(
        ([k]) => !['host', 'connection', 'accept-encoding'].includes(k)
      )
    ),
  });
  const text = await upstream.text();
  let out = text;
  if ((upstream.headers.get('content-type') ?? '').includes('json')) {
    try {
      out = JSON.stringify(patch(JSON.parse(text)));
    } catch {}
  }
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'text/plain',
  });
  res.end(out);
});
await new Promise(r => proxy.listen(4010, '127.0.0.1', r));

const b = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${STORE}.ebda.app 127.0.0.1:${PORT}`],
});
const ctx = await b.newContext();
await ctx.addCookies([
  {
    name: 'force-cookie-consent',
    value: encodeURIComponent(JSON.stringify({ v: 1, marketing: true, analytics: true })),
    url: `http://${STORE}.ebda.app`,
  },
]);
await ctx.addInitScript(() => {
  window.__v = [];
  document.addEventListener('securitypolicyviolation', e =>
    window.__v.push(`${e.violatedDirective} ${e.blockedURI}`)
  );
});
const seen = [];
// Vendor stubs: set a flag, then (like the real vendors) inject a follow-up script at runtime.
await ctx.route('https://www.googletagmanager.com/**', r => {
  seen.push(r.request().url());
  if (r.request().url().includes('stub-follow-up'))
    return r.fulfill({ contentType: 'text/javascript', body: 'window.__followUp = true;' });
  r.fulfill({
    contentType: 'text/javascript',
    body: "window.__gtm = true; var s = document.createElement('script'); s.src = 'https://www.googletagmanager.com/stub-follow-up.js'; document.head.appendChild(s);",
  });
});
await ctx.route('https://connect.facebook.net/**', r => {
  seen.push(r.request().url());
  r.fulfill({ contentType: 'text/javascript', body: 'window.__fbevents = true;' });
});
const page = await ctx.newPage();
const consoleCsp = [];
page.on('console', m => {
  if (/content security policy|refused to (execute|load)/i.test(m.text()))
    consoleCsp.push(m.text().slice(0, 300));
});
await page.goto(`http://${STORE}.ebda.app/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const r = await page.evaluate(() => ({
  gtm: window.__gtm === true,
  followUp: window.__followUp === true,
  fb: window.__fbevents === true,
  fbq: typeof window.fbq,
  dataLayer: Array.isArray(window.dataLayer),
  v: window.__v,
  pixelScripts: [...document.scripts]
    .filter(s => /gtm|meta-pixel|fbevents/.test(s.id + s.src))
    .map(s => `${s.id || s.src} nonce=${s.nonce ? 'yes' : 'no'}`),
}));
await b.close();
proxy.close();

const problems = [];
if (!r.gtm) problems.push('GTM loader script did not run');
if (!r.followUp) problems.push('script injected by the GTM stub was blocked or never requested');
if (!r.fb)
  problems.push('Meta pixel library did not run (bootstrap inline script or fbevents blocked)');
if (r.fbq !== 'function')
  problems.push('window.fbq missing: the inline Meta bootstrap did not execute');
for (const v of r.v) problems.push(`securitypolicyviolation: ${v}`);
for (const c of consoleCsp) problems.push(`console: ${c}`);
console.log(JSON.stringify({ ...r, requested: seen }, null, 2));
console.log(problems.length ? `FAIL\n - ${problems.join('\n - ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
