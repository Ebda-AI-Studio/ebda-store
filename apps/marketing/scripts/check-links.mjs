// Link check over the static export: every internal href/src resolves to a file in out/,
// every #fragment exists on its target page, and (with --external) every external
// https link answers < 400. Exit 1 on any broken link. `npm run check:links -w apps/marketing`.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const external = process.argv.includes('--external');
const walk = d =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const pages = walk(out).filter(f => f.endsWith('.html'));
const ids = new Map();
const idsOf = file => {
  if (!ids.has(file)) {
    const h = readFileSync(file, 'utf8');
    ids.set(file, new Set([...h.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])));
  }
  return ids.get(file);
};
const resolvePage = p => {
  const clean = decodeURIComponent(p.split('?')[0]);
  for (const c of [clean, path.join(clean, 'index.html'), clean + '.html'])
    if (existsSync(path.join(out, c)) && statSync(path.join(out, c)).isFile())
      return path.join(out, c);
  return null;
};

const broken = [];
const externals = new Map();
let checked = 0;
for (const file of pages) {
  if (/(^|\/)(404|_not-found)/.test(path.relative(out, file))) continue;
  const html = readFileSync(file, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    // preconnect/dns-prefetch hints name an origin, not a page
    .replace(/<link[^>]*rel="(?:preconnect|dns-prefetch)"[^>]*>/g, '');
  const pageUrl = '/' + path.relative(out, path.dirname(file)).replace(/\\/g, '/');
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (/^(mailto:|tel:|data:)/.test(raw)) continue;
    if (/^https?:\/\//.test(raw)) {
      const u = new URL(raw);
      if (u.hostname === 'ebda.app') {
        // our own absolute links (canonical, sitemap) must exist in the export
        if (!resolvePage(u.pathname)) broken.push(`${path.relative(out, file)} -> ${raw}`);
      } else externals.set(raw, path.relative(out, file));
      continue;
    }
    checked++;
    const [p, frag] = raw.split('#');
    const target =
      p === '' ? file : resolvePage(p.startsWith('/') ? p : path.posix.join(pageUrl, p));
    if (!target) broken.push(`${path.relative(out, file)} -> ${raw}`);
    else if (frag && !idsOf(target).has(frag))
      broken.push(`${path.relative(out, file)} -> ${raw} (no #${frag})`);
  }
  for (const m of html.matchAll(/\ssrcSet="([^"]+)"|\ssrcset="([^"]+)"/g))
    for (const part of (m[1] || m[2]).split(',')) {
      const u = part.trim().split(/\s+/)[0];
      checked++;
      if (u.startsWith('/') && !resolvePage(u))
        broken.push(`${path.relative(out, file)} -> ${u} (srcset)`);
    }
}
if (external) {
  for (const [u, from] of externals) {
    try {
      const r = await fetch(u, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'ebda-link-check' },
      });
      if (r.status >= 400) broken.push(`${from} -> ${u} (HTTP ${r.status})`);
    } catch (e) {
      broken.push(`${from} -> ${u} (${e.message})`);
    }
  }
}
console.log(
  `link-check: ${pages.length} pages, ${checked} internal links${external ? `, ${externals.size} external` : ''}, ${broken.length} broken`
);
for (const b of broken) console.log('  BROKEN', b);
process.exit(broken.length ? 1 : 0);
