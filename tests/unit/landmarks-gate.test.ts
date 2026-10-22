/**
 * a11y P2-1 (independent a11y audit, 2026-10-16): one top-level banner, every
 * navigation landmark named, and the announcement bar inside a landmark.
 * axe flagged landmark-no-duplicate-banner, banner-is-top-level,
 * landmark-unique and region on every page with a header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '../../apps/web/src');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

describe('storefront landmarks', () => {
  it('ShopChrome does not wrap the skin header in a second banner', () => {
    const src = read('components/ShopChrome.tsx');
    expect(src).not.toMatch(/role="banner"/);
    expect(src).not.toMatch(/<header\b/);
  });

  it('the announcement bar sits in a named complementary landmark', () => {
    const src = read('components/ShopChrome.tsx');
    expect(src).toMatch(/<aside\s+data-zone="beforeHeader"[^>]*aria-label=/);
  });

  it('every skin header names each of its navs', () => {
    const skins = readdirSync(join(WEB, 'templates')).filter(d =>
      existsSync(join(WEB, 'templates', d, 'Header.tsx'))
    );
    const bare: string[] = [];
    for (const s of skins) {
      const src = read(`templates/${s}/Header.tsx`);
      for (const m of src.matchAll(/<nav\b([^>]*)>/g)) {
        if (!/aria-label=/.test(m[1])) bare.push(`${s}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
