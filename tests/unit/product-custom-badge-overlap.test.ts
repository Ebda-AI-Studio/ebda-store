import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCardBadges } from '../../apps/web/src/templates/shared/custom-badge';

/**
 * Rule 4 — two chips on the same edge must stack, not collide.
 *
 * Rule 3 only suppresses the discount badge when the two corners are EQUAL.
 * That left the DEFAULT configuration — discount bottom-left, custom
 * bottom-right — rendering both chips into one horizontal band and trusting
 * the card to be wide enough. It is not.
 *
 * Measured in a real browser on a 5-across grid (product image ~134px wide),
 * both chips being `absolute z-10`:
 *   - label "OFFER" (5 chars)              -> 6px overlap
 *   - label "LIMITED TIME OFFER" (18 chars)-> 55x24px overlap, i.e. the
 *     discount chip was covered COMPLETELY and the shopper never saw -25%.
 * The column allows 32 characters, so this is ordinary merchant input, not an
 * abusive one. No unit test could see it: every one of them asserted the
 * decision, and the decision was "render both", which is correct — the bug was
 * in the pixels.
 */

const base = {
  product: { badgeLabel: 'OFFER' },
  isRtl: false,
  orderable: true,
};

describe('rule 4 — same edge, different corners', () => {
  it('lifts the custom chip out of the discount chip row (the default setup)', () => {
    const r = resolveCardBadges({ ...base, discountVisible: true });

    // Both still render — suppressing either one was never the fix.
    expect(r.customBadgeText).toBe('OFFER');
    expect(r.discountBadgeAllowed).toBe(true);
    // ...but the custom chip moves up a row so they cannot share pixels.
    expect(r.customBadgePositionCls).toBe('bottom-12 right-3');
  });

  it('leaves the badge in the merchant-chosen corner when there is no sale', () => {
    const r = resolveCardBadges({ ...base, discountVisible: false });
    expect(r.customBadgePositionCls).toBe('bottom-3 right-3');
  });

  it('does not stack when the two chips are on opposite edges', () => {
    const r = resolveCardBadges({
      ...base,
      discountVisible: true,
      customPosition: 'top-right',
      discountPosition: 'bottom-left',
    });
    expect(r.customBadgePositionCls).toBe('top-3 right-3');
  });

  it('does not stack when rule 3 already removed the discount chip', () => {
    const r = resolveCardBadges({
      ...base,
      discountVisible: true,
      customPosition: 'bottom-left',
      discountPosition: 'bottom-left',
    });
    expect(r.discountBadgeAllowed).toBe(false);
    expect(r.customBadgePositionCls).toBe('bottom-3 left-3');
  });

  it('does not stack on surfaces whose discount is not a corner chip', () => {
    // `minimal` renders its discount as inline text; the PDP uses a flex row.
    const r = resolveCardBadges({ ...base, discountVisible: true, discountOccupiesCorner: false });
    expect(r.customBadgePositionCls).toBe('bottom-3 right-3');
  });

  it('does not stack against a chip an out-of-stock product never shows', () => {
    const r = resolveCardBadges({ ...base, orderable: false, discountVisible: true });
    expect(r.customBadgeText).toBeNull();
    expect(r.customBadgePositionCls).toBe('bottom-3 right-3');
  });

  it('spells every class out in the source, so Tailwind can see it', () => {
    // Tailwind scans source TEXT. A composed `top-${inset}` returns the right
    // string at runtime — so every assertion above would still pass — while
    // generating no CSS at all, leaving the chip in static flow mid-card. Only
    // reading the file can catch that, so read the file.
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/web/src/templates/shared/custom-badge.ts'),
      'utf-8'
    );
    for (const cls of [
      'top-3 left-3',
      'top-3 right-3',
      'bottom-3 left-3',
      'bottom-3 right-3',
      'top-12 left-3',
      'top-12 right-3',
      'bottom-12 left-3',
      'bottom-12 right-3',
    ]) {
      expect(src).toContain(`'${cls}'`);
    }
  });

  it('emits only known class pairs', () => {
    const allowed = new Set([
      'top-3 left-3',
      'top-3 right-3',
      'bottom-3 left-3',
      'bottom-3 right-3',
      'top-12 left-3',
      'top-12 right-3',
      'bottom-12 left-3',
      'bottom-12 right-3',
    ]);
    const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
    for (const c of corners) {
      for (const d of corners) {
        for (const visible of [true, false]) {
          const r = resolveCardBadges({
            ...base,
            customPosition: c,
            discountPosition: d,
            discountVisible: visible,
          });
          expect(allowed.has(r.customBadgePositionCls)).toBe(true);
        }
      }
    }
  });
});

describe('no card may compute its own badge corner', () => {
  // The offset is only knowable where BOTH corners are in scope. A card that
  // calls getCustomBadgePosition itself gets the un-stacked class and silently
  // reintroduces the overlap on that one surface.
  const CARD_FILES = [
    'apps/web/src/templates/modern/ProductCard.tsx',
    'apps/web/src/templates/classic/ProductCard.tsx',
    'apps/web/src/templates/bold/ProductCard.tsx',
    'apps/web/src/templates/elegant/ProductCard.tsx',
    'apps/web/src/templates/minimal/ProductCard.tsx',
    'apps/web/src/app/products/ProductListItem.tsx',
    'apps/web/src/templates/shared/StorefrontProductCard.tsx',
    'apps/web/src/templates/shared/ProductCarousel.tsx',
  ];

  it.each(CARD_FILES)('%s takes its corner from resolveCardBadges', file => {
    const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8');
    expect(src).not.toContain('getCustomBadgePosition');
    // 2026-09-25 (issues #1609/#1611/#548): the discount chip's corner moved
    // into the same single owner, for the same reason — its collision
    // avoidance needs both badges' reserved/overlay context in scope.
    expect(src).not.toContain('getDiscountBadgePosition');
    expect(src).toContain('customBadgePositionCls');
    expect(src).toContain('discountVisible:');
  });

  // `minimal` is the one surface whose discount indicator is inline text,
  // not a corner chip (`discountOccupiesCorner: false`) — it has no use for
  // `discountBadgePositionCls`. Every OTHER card file renders the discount
  // chip as a corner overlay and must take that corner from the same single
  // owner as the custom chip.
  const CARD_FILES_WITH_DISCOUNT_CORNER = CARD_FILES.filter(
    f => !f.includes('/minimal/ProductCard.tsx')
  );

  it.each(CARD_FILES_WITH_DISCOUNT_CORNER)(
    '%s takes its discount corner from resolveCardBadges',
    file => {
      const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8');
      expect(src).toContain('discountBadgePositionCls');
    }
  );

  // `discountVisible` must be the SAME expression the surface renders the chip
  // on. Several cards gate it on their own hasSale/onSale as well as on the
  // badge text; passing only the text there lifts the custom chip clear of a
  // discount chip that never renders, leaving a gap with nothing in it.
  it.each(CARD_FILES)('%s passes the condition it actually renders on', file => {
    const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8');
    const visible = src.match(/discountVisible: ([^\n]*),/)?.[1] ?? '';
    const renderGate = src.match(/\{[^\n]*discountBadgeAllowed && discountBadgeText/)?.[0] ?? '';
    for (const token of ['hasSale', 'onSale']) {
      if (renderGate.includes(token)) expect(visible).toContain(token);
    }
  });
});
