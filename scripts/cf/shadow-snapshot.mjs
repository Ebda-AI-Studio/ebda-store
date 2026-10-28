#!/usr/bin/env node
// Cutover shadow compare, before/after form (Ruling CUTOVER-1: the 24 h dual-read shrinks to a synthetic
// GET sweep around the flip plus 2 h of live Sentry diffs).
//   node scripts/cf/shadow-snapshot.mjs snap --api https://api.ebda.app --stores storedemo,storedemo-souq --out before/
//   (flip the backend)
//   node scripts/cf/shadow-snapshot.mjs snap --api https://api.ebda.app --stores storedemo,storedemo-souq --out after/
//   node scripts/cf/shadow-snapshot.mjs diff before/ after/        exit 0 only when every response is identical
// GET only, public endpoints only, Arabic and English. Responses are key-sorted and stripped of volatile
// fields (--ignore, default: timestamp, generatedAt, generated_at, requestId, servedBy, storage_backend) before hashing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const PATHS = [
  '/api/v1/public/stores/{slug}',
  '/api/v1/public/products?limit=100',
  '/api/v1/public/categories',
  '/api/v1/public/tags',
  '/api/v1/public/size-charts',
  '/api/v1/public/feed/products.json',
  '/api/v1/public/redirects/resolve?type=product&slug=no-such-slug',
];
const LOCALES = ['ar', 'en'];

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string' },
    stores: { type: 'string' },
    out: { type: 'string' },
    extra: { type: 'string' },
    ignore: {
      type: 'string',
      default: 'timestamp,generatedAt,generated_at,requestId,servedBy,storage_backend',
    },
  },
});
const ignore = new Set(v.ignore.split(','));

const norm = x =>
  Array.isArray(x)
    ? x.map(norm)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .filter(k => !ignore.has(k))
            .sort()
            .map(k => [k, norm(x[k])])
        )
      : x;

async function snap() {
  if (!v.api || !v.stores || !v.out) throw new Error('--api, --stores and --out are required');
  fs.mkdirSync(v.out, { recursive: true });
  const extra = v.extra ? fs.readFileSync(v.extra, 'utf8').split('\n').filter(Boolean) : [];
  let n = 0;
  let bad = 0;
  for (const slug of v.stores.split(',')) {
    for (const loc of LOCALES) {
      for (const p of [...PATHS, ...extra]) {
        const url = v.api.replace(/\/$/, '') + p.replace('{slug}', slug);
        const res = await fetch(url, {
          headers: { 'x-store-domain': `${slug}.ebda.app`, 'accept-language': loc },
        });
        const text = await res.text();
        let body;
        try {
          body = norm(JSON.parse(text));
        } catch {
          body = { nonJson: text.slice(0, 2000) };
        }
        const rec = { url: p.replace('{slug}', slug), slug, loc, status: res.status, body };
        if (res.status >= 500) bad++;
        const key = crypto
          .createHash('sha256')
          .update(`${slug}|${loc}|${p}`)
          .digest('hex')
          .slice(0, 16);
        fs.writeFileSync(path.join(v.out, `${key}.json`), JSON.stringify(rec, null, 1));
        n++;
      }
    }
  }
  console.log(`${n} responses saved to ${v.out}${bad ? `; ${bad} were 5xx` : ''}`);
  if (bad) process.exit(1);
}

function diff() {
  const [a, b] = positionals.slice(1);
  if (!a || !b) throw new Error('diff <before-dir> <after-dir>');
  const fa = fs
    .readdirSync(a)
    .filter(f => f.endsWith('.json'))
    .sort();
  const fb = fs
    .readdirSync(b)
    .filter(f => f.endsWith('.json'))
    .sort();
  let diffs = 0;
  if (fa.join() !== fb.join()) {
    console.log(`DIFF request sets differ: ${fa.length} vs ${fb.length}`);
    diffs++;
  }
  for (const f of fa.filter(x => fb.includes(x))) {
    const ra = JSON.parse(fs.readFileSync(path.join(a, f), 'utf8'));
    const rb = JSON.parse(fs.readFileSync(path.join(b, f), 'utf8'));
    if (JSON.stringify(ra) !== JSON.stringify(rb)) {
      diffs++;
      console.log(`DIFF ${ra.slug} ${ra.loc} ${ra.url}: status ${ra.status} -> ${rb.status}`);
    }
  }
  console.log(`${fa.length} responses compared, ${diffs} differ`);
  process.exit(diffs ? 1 : 0);
}

try {
  if (positionals[0] === 'snap') await snap();
  else if (positionals[0] === 'diff') diff();
  else throw new Error('usage: shadow-snapshot.mjs snap|diff ...');
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(2);
}
