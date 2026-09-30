/**
 * Issue #1998 (owner decisions 2026-10-01 / 2026-09-30) — the DEFAULT sale
 * badge is pinned to the image's top corner, reading-START side (top-left LTR,
 * top-right RTL), on every store EXCEPT one that keeps
 * `StoreTheme.saleBadgeLegacyCorner` (per-store data), which stays exactly as
 * before. Surfaces pass `saleBadgeTopCorner: theme.saleBadgeLegacyCorner !== true`.
 *
 * Before: the unset default was the physical bottom-left, lifted ~96px on the
 * five theme cards to clear the mobile add-to-cart band. On desktop that band
 * is `lg:opacity-0` until hover, so at rest the chip floated mid-image on every
 * store that never picked a corner. The band only ever covers the bottom edge,
 * so a chip on the top edge can never be covered by it.
 *
 * These tests pin the rule for every top-edge occupant a surface declares, and
 * prove the chip NEVER lands on the bottom edge (so it can never be lifted into
 * mid-image again) unless the merchant explicitly chose a bottom corner.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  pinDefaultDiscountBadge,
  resolveCardBadges,
} from '../../apps/web/src/templates/shared/custom-badge';

const NO_LABEL = {};
const base = {
  product: NO_LABEL,
  orderable: true,
  discountVisible: true,
  saleBadgeTopCorner: true,
};

describe('default sale badge — top corner, reading-start side', () => {
  it('sits top-left on an LTR store and mirrors to top-right on an RTL store', () => {
    expect(resolveCardBadges({ ...base, isRtl: false }).discountBadgePositionCls).toBe(
      'top-3 left-3'
    );
    expect(resolveCardBadges({ ...base, isRtl: true }).discountBadgePositionCls).toBe(
      'top-3 right-3'
    );
  });

  it('is NOT lifted by the full-width add-to-cart band — the band is bottom-only', () => {
    for (const isRtl of [false, true]) {
      for (const bottomOverlay of ['none', 'end', 'both'] as const) {
        const cls = resolveCardBadges({ ...base, isRtl, bottomOverlay }).discountBadgePositionCls;
        expect(cls).toMatch(/^top-/);
        expect(cls).not.toMatch(/bottom-/);
      }
    }
  });

  it('moves to the free reading-end corner when a NEW pill holds the start corner', () => {
    const r = resolveCardBadges({ ...base, isRtl: false, newOrBrandBadgeReserved: true });
    expect(r.discountBadgePositionCls).toBe('top-3 right-3');
    const rtl = resolveCardBadges({ ...base, isRtl: true, newOrBrandBadgeReserved: true });
    expect(rtl.discountBadgePositionCls).toBe('top-3 left-3');
  });

  it('stacks one row under the NEW pill when the end corner has a heart (modern/elegant)', () => {
    const r = resolveCardBadges({
      ...base,
      isRtl: false,
      newOrBrandBadgeReserved: true,
      topEndReserved: true,
      bottomOverlay: 'both',
    });
    expect(r.discountBadgePositionCls).toBe('top-12 left-3');
  });

  it('takes the top-end corner on the Pecannbee card, whose heart holds top-start', () => {
    const r = resolveCardBadges({ ...base, isRtl: false, topStartReserved: true });
    expect(r.discountBadgePositionCls).toBe('top-3 right-3');
    const rtl = resolveCardBadges({ ...base, isRtl: true, topStartReserved: true });
    expect(rtl.discountBadgePositionCls).toBe('top-3 left-3');
  });

  it('out of stock: clears the corner ribbon (start) — end corner, or below the heart', () => {
    expect(
      resolveCardBadges({ ...base, isRtl: false, orderable: false }).discountBadgePositionCls
    ).toBe('top-3 right-3');
    // Heart at the end too: the heart (a button) is shallower than the 88px
    // ribbon box, so the chip sits one button-row under the heart.
    expect(
      resolveCardBadges({ ...base, isRtl: false, orderable: false, topEndReserved: true })
        .discountBadgePositionCls
    ).toBe('top-16 right-3');
  });

  it('never lands on the bottom edge for ANY combination of top occupants', () => {
    const b = [false, true];
    for (const isRtl of b)
      for (const orderable of b)
        for (const topStartReserved of b)
          for (const topEndReserved of b)
            for (const newOrBrandBadgeReserved of b) {
              const { corner, cls } = pinDefaultDiscountBadge({
                isRtl,
                orderable,
                topStartReserved,
                topEndReserved,
                newOrBrandBadgeReserved,
              });
              expect(corner.startsWith('top-')).toBe(true);
              expect(cls).toMatch(/^top-/);
              // Physical side agrees with the corner it reports.
              expect(cls.endsWith(corner.endsWith('left') ? 'left-3' : 'right-3')).toBe(true);
              // A chip that shares a corner with an occupant sits BELOW it.
              if (cls.startsWith('top-3')) {
                const startIsLeft = !isRtl;
                const onStart = corner.endsWith('left') === startIsLeft;
                const startBusy = !orderable || topStartReserved || newOrBrandBadgeReserved;
                expect(onStart ? startBusy : topEndReserved).toBe(false);
              }
            }
  });

  it('keeps honouring a corner the merchant explicitly chose (physical, lifted when needed)', () => {
    const r = resolveCardBadges({
      ...base,
      isRtl: true,
      discountPosition: 'bottom-left',
      bottomOverlay: 'both',
    });
    // Explicit picks are physical — bottom-left stays bottom-left on RTL — and
    // still clear the mobile band exactly as before this change.
    expect(r.discountBadgePositionCls).toBe('bottom-[min(6rem,calc(100%-2.25rem))] left-3');
  });
});

describe('legacy corner (theme.saleBadgeLegacyCorner) — byte-identical to before #1998', () => {
  it('with the flag passed false, every input resolves exactly as when it is omitted', () => {
    const b = [false, true];
    const overlays = ['none', 'end', 'both'] as const;
    const corners = [undefined, 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
    for (const isRtl of b)
      for (const orderable of b)
        for (const topStartReserved of b)
          for (const topEndReserved of b)
            for (const newOrBrandBadgeReserved of b)
              for (const bottomOverlay of overlays)
                for (const discountPosition of corners)
                  for (const product of [NO_LABEL, { badgeLabel: 'Offer' }]) {
                    const input = {
                      product,
                      isRtl,
                      orderable,
                      discountVisible: true,
                      topStartReserved,
                      topEndReserved,
                      newOrBrandBadgeReserved,
                      bottomOverlay,
                      discountPosition,
                    };
                    expect(resolveCardBadges({ ...input, saleBadgeTopCorner: false })).toEqual(
                      resolveCardBadges(input)
                    );
                  }
  });

  it('the unset badge stays bottom-left (lifted over the band) when the store keeps the legacy corner', () => {
    const r = resolveCardBadges({
      ...base,
      isRtl: true,
      saleBadgeTopCorner: false,
      bottomOverlay: 'both',
    });
    expect(r.discountBadgePositionCls).toBe('bottom-[min(6rem,calc(100%-2.25rem))] left-3');
  });
});

describe('every corner-chip render path derives the placement from the per-store flag', () => {
  const ROOT = resolve(__dirname, '../..');
  const PATHS = [
    'apps/web/src/templates/shared/PecannbeeProductCard.tsx',
    'apps/web/src/templates/modern/ProductCard.tsx',
    'apps/web/src/templates/elegant/ProductCard.tsx',
    'apps/web/src/templates/classic/ProductCard.tsx',
    'apps/web/src/templates/minimal/ProductCard.tsx',
    'apps/web/src/templates/bold/ProductCard.tsx',
    'apps/web/src/templates/shared/ProductCarousel.tsx',
    'apps/web/src/app/products/ProductListItem.tsx',
  ];
  for (const rel of PATHS) {
    it(`${rel} passes saleBadgeTopCorner from theme.saleBadgeLegacyCorner, never a slug`, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(src).toContain('saleBadgeTopCorner: store.theme?.saleBadgeLegacyCorner !== true');
      expect(src).not.toMatch(/slug\s*===\s*['"]pecannbee['"]/);
    });
  }
});
