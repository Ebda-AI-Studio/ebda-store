import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A row of category or tag links is one link per category, and every one points at the same page
 * with a different query string (`/products?category=…`). Left to its default, `next/link` prefetches
 * each of them as soon as the row is near the screen: two requests to the storefront Worker per
 * link, none of them cacheable, all answering with the same loading shell. The demo home fired 13 of
 * those on a phone before the visitor touched anything (pre-QA sweep finding 12, Ruling PERF-PREFETCH-1).
 *
 * So a link that is rendered once per category or per tag sets `prefetch={false}`, as the product
 * cards and the category strip already do. This walks the storefront source for them.
 */

const ROOT = join(__dirname, '..', '..');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');

/** An href that fans out: one link per category or per tag, built from the item being mapped. */
const FAN_OUT_HREF = /\/products\?(category|tag)=\$\{/;

/**
 * Single links, not rows: one prefetch each, so the default stays.
 */
const SINGLE_LINKS: { file: string; marker: string; why: string }[] = [
  {
    file: 'app/products/[slug]/ProductDetailClient.tsx',
    marker: 'cat0.category.slug',
    why: "the product page's one link back to its own category",
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== '__tests__') sourceFiles(path, out);
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/** The opening tag that starts at `start`, up to its closing `>` (skipping `>` inside `{…}`). */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

type Found = { where: string; file: string; tag: string };

function fanOutLinks(): Found[] {
  const found: Found[] = [];
  for (const path of sourceFiles(WEB_SRC)) {
    const src = readFileSync(path, 'utf8');
    const file = relative(WEB_SRC, path);
    const re = /<(Link|StoreLink|NextLink)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = openingTag(src, m.index);
      if (!FAN_OUT_HREF.test(tag)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      found.push({ where: `${file}:${line}`, file, tag });
    }
  }
  return found;
}

describe('rows of category and tag links do not prefetch one page per item', () => {
  const all = fanOutLinks();
  const rows = all.filter(
    l => !SINGLE_LINKS.some(s => s.file === l.file && l.tag.includes(s.marker))
  );

  it('finds the rows it is meant to guard', () => {
    // A walk that finds nothing passes the assertion below.
    const files = new Set(rows.map(l => l.file));
    expect(files.has('templates/shared/CategoryChips.tsx')).toBe(true);
    expect(files.has('templates/shared/TagChips.tsx')).toBe(true);
    expect(files.has('templates/shared/CategoryRail.tsx')).toBe(true);
    expect(files.has('templates/shared/CategoryTiles.tsx')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it('every link rendered once per category or per tag sets prefetch={false}', () => {
    const prefetching = rows.filter(l => !/\bprefetch=\{false\}/.test(l.tag)).map(l => l.where);
    expect(prefetching).toEqual([]);
  });

  it('every single-link exemption still points at a real link', () => {
    for (const s of SINGLE_LINKS) {
      expect(
        all.some(l => l.file === s.file && l.tag.includes(s.marker)),
        `${s.file}: ${s.marker} (${s.why})`
      ).toBe(true);
    }
  });
});
