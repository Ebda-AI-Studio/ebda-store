/**
 * Storefront shell tap targets (UI audit P2 #8: the header brand link measured 135x25 on touch).
 * Every storefront header's home/wordmark link must be at least 44px tall and wide (`min-h-11 min-w-11`, WCAG 2.5.8 and the store's own bar).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = join(__dirname, '../../apps/web/src/templates');

/** The opening tags of `<Link href={homeHref | urlPrefix || '/'} ...>` in a header source. */
export function homeLinkTags(src: string): string[] {
  const out: string[] = [];
  const re = /<Link\s+href=\{(?:homeHref|urlPrefix \|\| '\/')\}[\s\S]*?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[0]);
  return out;
}

describe('storefront header home link is a 44px target', () => {
  it('self-test: finds the link and flags a short one', () => {
    const bad = `<Link href={homeHref} className="flex items-center" aria-label={n}>`;
    const good = `<Link href={homeHref} className="flex min-h-11 min-w-11 items-center">`;
    expect(homeLinkTags(bad)).toHaveLength(1);
    expect(/min-h-11/.test(homeLinkTags(bad)[0]!)).toBe(false);
    expect(/min-h-11 min-w-11/.test(homeLinkTags(good)[0]!)).toBe(true);
  });
  it('every template Header that renders its own home link sizes it to 44px', () => {
    const checked: string[] = [];
    for (const dir of readdirSync(TEMPLATES)) {
      const f = join(TEMPLATES, dir, 'Header.tsx');
      if (!existsSync(f)) continue;
      for (const tag of homeLinkTags(readFileSync(f, 'utf8'))) {
        checked.push(dir);
        expect(tag, `${dir}/Header.tsx home link`).toMatch(/min-h-11/);
        expect(tag, `${dir}/Header.tsx home link`).toMatch(/min-w-11/);
      }
    }
    expect(checked).toEqual(expect.arrayContaining(['base', 'dahab']));
  });
});
