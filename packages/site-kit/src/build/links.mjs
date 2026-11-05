// Build-time link check for the static sites (help, docs): every internal link in an emitted page must resolve to an
// emitted file, or the build fails (public sites audit 2026-11-03, P0-1: six help links pointed at /ar/<slug>/, which
// does not exist, and nothing noticed). Internal = a root-relative href, or an absolute one on the site's own origin.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Does a root-relative URL path (no query, no hash) resolve to a file in `outDir`? */
export function resolvesInOut(outDir, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const rel = p.replace(/^\/+/, '');
  const base = path.join(outDir, rel);
  if (p.endsWith('/') || rel === '') return existsSync(path.join(base, 'index.html'));
  return existsSync(base) && statSync(base).isFile();
}

/**
 * @param {string} outDir  the emitted site
 * @param {string} origin  the site's own origin, e.g. https://help.ebda.app
 * @returns {{page:string, href:string}[]} the broken internal links
 */
export function brokenInternalLinks(outDir, origin) {
  const bad = [];
  for (const file of walk(outDir)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<a\s[^>]*?href="([^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, '&');
      let p;
      if (href.startsWith('/') && !href.startsWith('//')) p = href;
      else if (href.startsWith(origin + '/')) p = href.slice(origin.length);
      else continue;
      p = p.split('#')[0].split('?')[0];
      if (p === '') continue;
      if (!resolvesInOut(outDir, p)) bad.push({ page: path.relative(outDir, file), href });
    }
  }
  return bad;
}

/** Fail the build (throw) when a page links to something the site does not emit. */
export function assertNoBrokenLinks(outDir, origin) {
  const bad = brokenInternalLinks(outDir, origin);
  if (bad.length) {
    const list = bad
      .slice(0, 40)
      .map(b => `  ${b.page} -> ${b.href}`)
      .join('\n');
    throw new Error(`${bad.length} internal link(s) do not resolve to an emitted page:\n${list}`);
  }
}
