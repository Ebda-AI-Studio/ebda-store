/**
 * Ruling B1-58 (supersedes the B1-27 mechanism): a merchant-coloured footer keeps every text tone
 * >= 4.5:1 on EVERY skin through ONE system, main's `footerRootPaint` (templates/shared/footer-ink.ts,
 * `[data-footer-ink]` rules in globals.css). B1's parallel ShopChrome wrapper
 * (`footerTextOverride` / `readableTextVars` / `[data-footer-surface]`) is gone: two re-scopings
 * of --foreground on nested elements meant the inner one silently won and the outer one was dead
 * weight to keep in sync. The STOP 1 defect B1-27 closed still holds: minimal's
 * `text-muted-foreground` links on a `token:primary` footer measured 2.6:1 (#5C5C5C on #141414).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as shared from '@ebda/shared';
import {
  contrastRatio,
  resolveColor,
  getTemplateTheme,
  TEMPLATE_LAYOUT_BASELINES,
  hexToHsl,
} from '@ebda/shared';
import { resolveFooterInk } from '../../apps/web/src/templates/shared/footer-ink';

const root = path.resolve(__dirname, '../..');
const SURFACES = [
  '#141414', // Atelier ink / a near-black brand
  '#0A0A0A', // minimal preset primary
  '#1F4E54', // Vitrine teal
  '#7C2D12', // burgundy
  '#D9DCEB', // Lookbook moon silver (light: black text)
  '#FF6E00', // orange, the flip-point case
  '#808080', // mid grey, the hardest surface
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('the shared footer ink keeps foreground and muted >= 4.5:1 on the B1 surfaces', () => {
  for (const bg of SURFACES)
    it(bg, () => {
      const ink = resolveFooterInk(bg)!;
      expect(ink).toBeDefined();
      expect(contrastRatio(bg, ink.fg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, ink.muted)).toBeGreaterThanOrEqual(4.5);
    });

  it('the minimal baseline footer (token:primary) on a dark brand gets a readable muted tone', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.minimal.footer?.bgColor).toBe('token:primary');
    const theme = { ...getTemplateTheme('minimal'), primaryColor: hexToHsl('#141414') };
    const bg = resolveColor('token:primary', theme)!;
    expect(contrastRatio('#141414', '#5C5C5C')).toBeLessThan(4.5);
    expect(contrastRatio(bg, resolveFooterInk(bg)!.muted)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('one footer-ink system (B1-58)', () => {
  it('the B1-27 wrapper helpers are no longer exported from @ebda/shared', () => {
    expect('footerTextOverride' in shared).toBe(false);
    expect('readableTextVars' in shared).toBe(false);
  });

  it('no storefront source sets or styles [data-footer-surface]', () => {
    const hits = walk(path.join(root, 'apps/web/src')).filter(f =>
      /data-footer-surface|footerTextOverride|--footer-on-fg|--ctl-foreground/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(hits.map(f => path.relative(root, f))).toEqual([]);
  });

  it('every skin footer still spreads footerRootPaint on its root', () => {
    for (const skin of ['minimal', 'elegant', 'modern', 'classic', 'bold', 'dahab']) {
      const src = readFileSync(
        path.join(root, `apps/web/src/templates/${skin}/Footer.tsx`),
        'utf8'
      );
      expect(src, skin).toMatch(/\{\.\.\.footerRootPaint\(bgColor\)\}/);
    }
  });
});
