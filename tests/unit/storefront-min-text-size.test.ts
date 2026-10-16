/**
 * R-03 (Qamar taste audit 2026-10-15, quality-bar § 3): no visible storefront text
 * under 12px. Arabic at 9-11px loses its dots on mid-range Android (PRODUCT.md
 * floor); the audit counted 34 `text-[9|10|11px]` hits, including the bottom tab
 * labels, the announcement bar, the desktop nav and a 9px cart count floating off
 * its icon. `commerce-no-arbitrary-text.test.ts` already bans arbitrary text
 * sizes inside components/commerce; this gate holds the 12px floor for the whole
 * storefront (apps/web/src), in Tailwind classes, inline styles and CSS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB = join(ROOT, 'apps/web/src');
// The shared UI package renders on the storefront too (ProductBadge on every modern card).
const UI = join(ROOT, 'packages/ui/src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|ts|css)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

/** Sizes under 12px: text-[9px]..text-[11.5px], text-[0.7rem], font-size: 10px, fontSize: '11px'. */
const UNDER_12 = [
  /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/,
  /text-\[0?\.(?:[0-6]\d*|7[0-4]\d*)r?em\]/,
  /font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/,
  /fontSize:\s*['"`]?(?:[0-9]|1[01])(?:\.\d+)?(?:px)?['"`]?\s*[,}]/,
];

const files = [...walk(WEB), ...walk(UI)];

describe('R-03: storefront text is never under 12px', () => {
  it('scans the storefront and packages/ui', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some(f => f.includes('packages/ui/src/components/ProductBadge.tsx'))).toBe(true);
  });

  it('no class, inline style or CSS rule sets text under 12px', () => {
    const hits = files.flatMap(f =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((l, i) =>
          UNDER_12.some(r => r.test(l)) ? [`${relative(ROOT, f)}:${i + 1}: ${l.trim()}`] : []
        )
    );
    expect(hits).toEqual([]);
  });

  it('the matcher catches the old shapes and spares 12px+ (self-test)', () => {
    const t = (l: string) => UNDER_12.some(r => r.test(l));
    expect(t('className="text-[9px] font-light"')).toBe(true);
    expect(t("'text-[10px] font-bold'")).toBe(true);
    expect(t('text-[11px] tracking-[0.18em]')).toBe(true);
    expect(t('text-[0.65rem]')).toBe(true);
    expect(t('  font-size: 10px;')).toBe(true);
    expect(t("style={{ fontSize: '11px' }}")).toBe(true);
    expect(t('text-xs')).toBe(false);
    expect(t('text-[12px]')).toBe(false);
    expect(t('text-[13px]')).toBe(false);
    expect(t('text-[0.75rem]')).toBe(false);
    expect(t('font-size: 15.2px;')).toBe(false);
    expect(t("fontSize: '20px'")).toBe(false);
    expect(t('h-[18px] min-w-[18px]')).toBe(false);
  });
});
