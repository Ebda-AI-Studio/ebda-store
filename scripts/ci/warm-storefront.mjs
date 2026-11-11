// Ruling WEB-COLD-1 (+ WEB-COLD-2 widening): after a storefront deploy, GET the pages shoppers actually open on every
// demo store, in BOTH languages: home, the product listing and one product page. Each GET that answers 5xx or fails at
// the network is retried ONCE and both attempts are logged, so a cold-render 500 (dahab, 2026-11-10 01:54Z) is warmed
// AND visible in the step log. Best effort: never exits non-zero (the deploy is already verified).
//
// Hosts come from apps/web/src/lib/demo-hosts.ts, so a new demo store is covered with no edit here.
// Footprint per deploy: hosts x 2 languages x 3 pages GETs (+ <= that again in retries) + one API read per host.
//
// Run from the repo root:  node scripts/ci/warm-storefront.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LANGS = ['ar', 'en'];
export const TIMEOUT_MS = 20_000;
/** Pages per language (home, listing, product) and attempts per page (first + one retry): the step cap is pinned on these. */
export const PAGES_PER_LANG = 3;
export const ATTEMPTS = 2;
const API = 'https://api.ebda.app/api/v1';
const APEX = 'ebda.app';

/** Demo host labels, read from the one map the app uses (demo-hosts.ts). */
export function demoLabels(source) {
  return [...new Set([...source.matchAll(/'(storedemo[a-z-]*)'/g)].map(m => m[1]))];
}

/** The storefront paths to warm for one language: home, listing, and the product page when a slug is known. */
export function pathsFor(lang, productSlug) {
  const paths = [`/${lang}`, `/${lang}/products`];
  if (productSlug) paths.push(`/${lang}/products/${encodeURIComponent(productSlug)}`);
  return paths;
}

/** One timed GET: { status, ms } where status is the HTTP code or 'failed'. TTFB = time until the headers arrived. */
async function timedGet(url, fetchImpl, now) {
  const t0 = now();
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    const ms = now() - t0;
    await res.arrayBuffer().catch(() => {});
    return { status: res.status, ms };
  } catch {
    return { status: 'failed', ms: now() - t0 };
  }
}

const retryable = status => status === 'failed' || status >= 500;

/** GET `url`, retrying once on a 5xx or a network failure. Returns every attempt. */
export async function warmOne(url, { fetchImpl = fetch, now = Date.now } = {}) {
  const first = await timedGet(url, fetchImpl, now);
  if (!retryable(first.status)) return [first];
  return [first, await timedGet(url, fetchImpl, now)];
}

/** A product slug of the demo store, or null (then only home + listing are warmed). */
export async function firstProductSlug(label, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${API}/public/products?limit=1`, {
      headers: { 'x-store-domain': `${label}.${APEX}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const slug = json?.data?.products?.[0]?.slug;
    return typeof slug === 'string' && slug ? slug : null;
  } catch {
    return null;
  }
}

export function formatLine(url, attempts) {
  const parts = attempts.map(
    (a, i) => `${i === 0 ? '' : 'retry '}${a.status} ttfb=${(a.ms / 1000).toFixed(2)}s`
  );
  return `warm ${url}: ${parts.join(' -> ')}`;
}

/** Warm every demo store; returns the logged lines (also printed through `log`). */
export async function warmAll(
  labels,
  { fetchImpl = fetch, now = Date.now, log = console.log } = {}
) {
  const lines = [];
  for (const label of labels) {
    const slug = await firstProductSlug(label, { fetchImpl });
    if (!slug) log(`warm ${label}: no product slug from the API, product page skipped`);
    for (const lang of LANGS) {
      for (const p of pathsFor(lang, slug)) {
        const url = `https://${label}.${APEX}${p}`;
        const line = formatLine(url, await warmOne(url, { fetchImpl, now }));
        lines.push(line);
        log(line);
      }
    }
  }
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const labels = demoLabels(
    readFileSync(path.join(root, 'apps/web/src/lib/demo-hosts.ts'), 'utf8')
  );
  await warmAll(labels).catch(e => console.log(`warm: aborted (ignored): ${e?.message ?? e}`));
}
