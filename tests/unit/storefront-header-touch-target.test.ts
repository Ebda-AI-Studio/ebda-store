/**
 * Storefront shell tap targets (UI audit P2 #8: the header brand link measured 135x25 on touch).
 * Every storefront header's home/wordmark link must be at least 44px tall and wide (`min-h-11 min-w-11`, WCAG 2.5.8 and the store's own bar).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = join(__dirname, '../../apps/web/src/templates');

/** True when an href expression is the store home route: `/`, the language-prefix root, or a variable holding one. */
export function isHomeHref(expr: string): boolean {
  const e = expr
    .trim()
    .replace(/^\{|\}$/g, '')
    .trim();
  return (
    /^['"`]\/['"`]$/.test(e) ||
    /^(?:homeHref|homeUrl|home|rootHref|urlPrefix)$/.test(e) ||
    /^urlPrefix\s*(?:\|\||\?\?)\s*['"`]\/['"`]$/.test(e) ||
    /^`\$\{urlPrefix\}\/?`$/.test(e)
  );
}

/** The JSX opening tag starting at `i` and the raw value of its `href` (brace-balanced, so `${}` in a template literal is fine). */
function tagAndHref(src: string, i: number): { tag: string; href: string } {
  let depth = 0;
  let end = src.length - 1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[j - 1] !== '=') {
      end = j;
      break;
    }
  }
  const tag = src.slice(i, end + 1);
  const at = tag.search(/\shref=/);
  if (at < 0) return { tag, href: '' };
  const v = at + 6;
  if (tag[v] !== '{') return { tag, href: tag.slice(v).match(/^("[^"]*"|'[^']*')/)?.[1] ?? '' };
  let d = 0;
  for (let j = v; j < tag.length; j++) {
    if (tag[j] === '{') d++;
    else if (tag[j] === '}' && --d === 0) return { tag, href: tag.slice(v, j + 1) };
  }
  return { tag, href: '' };
}

/** Opening tags of `<Link|a href=<home route> ...>` in a header source, whatever the spelling of the route. */
export function homeLinkTags(src: string): string[] {
  const out: string[] = [];
  const re = /<(?:Link|a)(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const { tag, href } = tagAndHref(src, m.index);
    if (
      href &&
      isHomeHref(
        href
          .replace(/^(["'])(.*)\1$/, '$2')
          .replace(/^(.*)$/, x => (/^\{/.test(href) ? href : `'${x}'`))
      )
    )
      out.push(tag);
  }
  return out;
}

describe('storefront header home link is a 44px target', () => {
  it('self-test: finds the link and flags a short one', () => {
    const bad = `<Link href={homeHref} className="flex items-center" aria-label={n}>`;
    for (const spelling of ["{urlPrefix || '/'}", '"/"', '{`${urlPrefix}/`}', '{urlPrefix ?? "/"}'])
      expect(homeLinkTags(`<Link href=${spelling} className="x">`), spelling).toHaveLength(1);
    expect(homeLinkTags('<Link href={`${urlPrefix}/cart`} className="x">')).toHaveLength(0);
    expect(homeLinkTags('<Link href="/cart" className="x">')).toHaveLength(0);
    const good = `<Link href={homeHref} className="flex min-h-11 min-w-11 items-center">`;
    expect(homeLinkTags(bad)).toHaveLength(1);
    expect(/min-h-11/.test(homeLinkTags(bad)[0]!)).toBe(false);
    expect(/min-h-11 min-w-11/.test(homeLinkTags(good)[0]!)).toBe(true);
  });
  it('every Header*.tsx in any template that renders its own home link sizes it to 44px', () => {
    const checked: string[] = [];
    for (const dir of readdirSync(TEMPLATES)) {
      const d = join(TEMPLATES, dir);
      if (!statSync(d).isDirectory()) continue;
      for (const name of readdirSync(d).filter(n => /^Header\w*\.tsx$/.test(n))) {
        for (const tag of homeLinkTags(readFileSync(join(d, name), 'utf8'))) {
          checked.push(dir);
          expect(tag, `${dir}/${name} home link`).toMatch(/min-h-11/);
          expect(tag, `${dir}/${name} home link`).toMatch(/min-w-11/);
        }
      }
    }
    expect(checked).toEqual(expect.arrayContaining(['base', 'dahab']));
  });
});
