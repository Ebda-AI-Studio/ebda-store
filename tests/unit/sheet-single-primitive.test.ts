/**
 * R-04 (Qamar taste audit 2026-10-15, quality-bar § 3): sheets, drawers and modal
 * panels use the ONE shared primitive, `apps/web/src/components/ui/Sheet.tsx`
 * (native <dialog>.showModal(): Escape, focus in/trap/return, scroll lock).
 *
 * The filter sheet and the tab-bar menu drawer were ad-hoc `role="dialog"` divs
 * with no Escape, no focus trap or return and a drag handle that did nothing; the
 * account tracking panel and the cookie preferences modal were the same shape.
 *
 * Gate: no `role="dialog"`, no `aria-modal="true"` and no raw `<dialog` in the
 * storefront outside Sheet.tsx, except the listed files, each with its reason.
 * The behaviour half is `apps/web/src/components/ui/Sheet.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB = join(ROOT, 'apps/web/src');
const UI = join(ROOT, 'packages/ui/src');
const SHEET = 'apps/web/src/components/ui/Sheet.tsx';

/** Not sheets: each is a deliberate, different pattern. */
const ALLOWED: Record<string, string> = {
  // Non-modal consent notice (aria-modal="false"): the page stays usable under it.
  'apps/web/src/components/CookieConsentBanner.tsx': 'role="dialog"',
  // Non-modal permission prompt pinned to a corner; dismissible, never traps focus.
  'apps/web/src/components/PushNotificationPrompt.tsx': 'role="dialog"',
  // Native <dialog> size chart (center modal, showModal + scroll lock, B0 Task 9).
  'apps/web/src/components/commerce/SizeChartDialog.tsx': '<dialog',
  // Native <dialog> full-screen photo lightbox (showModal), not a sheet.
  'apps/web/src/templates/dahab/ProductDetail.tsx': '<dialog',
  // The admin's modal. The storefront may NOT import it (checked below).
  'packages/ui/src/components/Modal.tsx': 'role="dialog"',
};
const ALLOWED_MODAL_PAIRS: Record<string, string> = {
  'packages/ui/src/components/Modal.tsx': 'aria-modal="true"',
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

const PATTERNS: Array<[string, RegExp]> = [
  ['role="dialog"', /role=["'{]+dialog/],
  ['aria-modal="true"', /aria-modal=["'{]+true/],
  ['<dialog', /<dialog[\s>]/],
];

describe('R-04: one Sheet primitive, no ad-hoc dialogs in the storefront', () => {
  const files = [...walk(WEB), ...walk(UI)].map(f => relative(ROOT, f));
  const web = files.filter(f => f.startsWith('apps/web/'));
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

  it('the primitive exists', () => {
    expect(files).toContain(SHEET);
  });

  it('nothing else opens a dialog by hand', () => {
    const hits = files
      .filter(f => f !== SHEET)
      .flatMap(f => {
        const src = readFileSync(join(ROOT, f), 'utf8');
        return PATTERNS.flatMap(([name, re]) =>
          re.test(src) && ALLOWED[f] !== name && ALLOWED_MODAL_PAIRS[f] !== name
            ? [`${f}: ${name}`]
            : []
        );
      });
    expect(hits).toEqual([]);
  });

  it('no hand-rolled drawer: a fixed panel that slides in with translate-x-full', () => {
    // The bold/modern header drawers were exactly this: no Escape, no focus trap,
    // off-screen links in the Tab order. They declared nothing a dialog grep sees.
    const hits = web.flatMap(f =>
      readFileSync(join(ROOT, f), 'utf8')
        .split('\n')
        .flatMap((l, i) =>
          /\bfixed\b/.test(l) && /-?translate-x-full/.test(l) ? [`${f}:${i + 1}`] : []
        )
    );
    expect(hits).toEqual([]);
  });

  it('the storefront never imports the @ebda/ui Modal (a second dialog implementation)', () => {
    const hits = web.filter(f =>
      /import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*'@ebda\/ui'/.test(read(f))
    );
    expect(hits).toEqual([]);
  });

  it('a collapsed in-place menu (grid-rows-[0fr]) is inert, so its links are not tabbable', () => {
    const hits = web.flatMap(f => {
      const lines = read(f).split('\n');
      return lines.flatMap((l, i) =>
        /grid-rows-\[0fr\]/.test(l) && !lines.slice(i, i + 6).some(x => /\binert\b/.test(x))
          ? [`${f}:${i + 1}`]
          : []
      );
    });
    expect(hits).toEqual([]);
  });

  it('the filter sheet, the tab-bar menu, the Dahab drawer, the tracking panel and the cookie modal use it', () => {
    for (const f of [
      'apps/web/src/app/products/ProductsFilterSidebar.tsx',
      'apps/web/src/templates/shared/BottomTabBar.tsx',
      'apps/web/src/templates/dahab/Drawer.tsx',
      'apps/web/src/app/account/orders/[id]/OrderDetailClient.tsx',
      'apps/web/src/components/CookiePreferencesModal.tsx',
      'apps/web/src/app/account/addresses/AddressesClient.tsx',
    ]) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/<Sheet\b/);
    }
  });

  it('every allowlisted file still has the pattern it is allowed (no stale entries)', () => {
    for (const [f, name] of Object.entries(ALLOWED)) {
      const re = PATTERNS.find(([n]) => n === name)![1];
      expect(re.test(readFileSync(join(ROOT, f), 'utf8')), f).toBe(true);
    }
  });
});
