/**
 * The custom product-badge mutex — the one place that decides whether the
 * merchant's free-text chip and the computed discount chip may both render.
 *
 * Every one of the nine surfaces (eight product-card render paths + the PDP)
 * calls `resolveCardBadges` and renders from its answer, so these assertions
 * are the contract for all of them at once. A second copy of this logic
 * anywhere is the bug this file exists to prevent.
 *
 * Imported from SOURCE (`apps/web/src/templates/shared/custom-badge`), never
 * through a package entry point — `@force/shared` resolves to
 * packages/shared/DIST, so a test written against it passes on the last build
 * instead of on the code under review.
 */
import { describe, it, expect } from 'vitest';
import {
  CUSTOM_BADGE_DEFAULT_POSITION,
  getCustomBadgeColor,
  getCustomBadgePosition,
  getCustomBadgeText,
  resolveCardBadges,
} from '../../apps/web/src/templates/shared/custom-badge';
import {
  DISCOUNT_BADGE_DEFAULT_POSITION,
  getDiscountBadgePosition,
} from '../../apps/web/src/templates/shared/discount-badge';

const OFFER = { badgeLabel: 'Offer', badgeLabelAr: 'عرض' };
const NO_LABEL = {};

describe('getCustomBadgeText — locale + trimming', () => {
  it('renders the English label on an LTR storefront', () => {
    expect(getCustomBadgeText(OFFER, false)).toBe('Offer');
  });

  it('renders the ARABIC label on an RTL storefront (the merchant’s "عرض")', () => {
    expect(getCustomBadgeText(OFFER, true)).toBe('عرض');
  });

  it('falls back to the other language rather than vanishing', () => {
    // A merchant who filled only one box must still get a badge in both
    // storefront languages — a chip that silently disappears in Arabic is
    // exactly the bilingual defect this platform exists to avoid.
    expect(getCustomBadgeText({ badgeLabel: 'Offer' }, true)).toBe('Offer');
    expect(getCustomBadgeText({ badgeLabelAr: 'عرض' }, false)).toBe('عرض');
  });

  it('returns null when the merchant set nothing', () => {
    expect(getCustomBadgeText(NO_LABEL, false)).toBeNull();
    expect(getCustomBadgeText(NO_LABEL, true)).toBeNull();
  });

  it('treats null / empty / whitespace-only as no badge', () => {
    // A legacy row or a direct DB edit must not be able to render an empty
    // coloured pill on every card.
    expect(getCustomBadgeText({ badgeLabel: null, badgeLabelAr: null }, false)).toBeNull();
    expect(getCustomBadgeText({ badgeLabel: '' }, false)).toBeNull();
    expect(getCustomBadgeText({ badgeLabel: '   ' }, false)).toBeNull();
    expect(getCustomBadgeText({ badgeLabelAr: '\t\n ' }, true)).toBeNull();
  });

  it('trims a padded label instead of rejecting it', () => {
    expect(getCustomBadgeText({ badgeLabel: '  Offer  ' }, false)).toBe('Offer');
  });
});

describe('getCustomBadgePosition — PHYSICAL corners, never RTL-mirrored', () => {
  it('defaults to the bottom-right corner', () => {
    expect(getCustomBadgePosition(undefined)).toBe('bottom-3 right-3');
    expect(CUSTOM_BADGE_DEFAULT_POSITION).toBe('bottom-right');
  });

  it.each(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)(
    '%s renders the same physical classes in LTR and RTL',
    position => {
      // The badge TEXT follows the locale; its PLACEMENT does not. A merchant
      // who put the chip in a corner of the photo chose a spot in the photo.
      expect(getCustomBadgePosition(position, true)).toBe(getCustomBadgePosition(position, false));
    }
  );

  it('maps each corner to physical left/right classes, not logical start/end', () => {
    expect(getCustomBadgePosition('top-left')).toBe('top-3 left-3');
    expect(getCustomBadgePosition('top-right')).toBe('top-3 right-3');
    expect(getCustomBadgePosition('bottom-left')).toBe('bottom-3 left-3');
    expect(getCustomBadgePosition('bottom-right')).toBe('bottom-3 right-3');
    const all = (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map(p =>
      getCustomBadgePosition(p)
    );
    expect(all.join(' ')).not.toMatch(/\b(start|end)-/);
  });

  it('agrees with the discount badge on what each named corner means', () => {
    // The two are sibling systems: "top-left" must not mean two different
    // places depending on which chip you asked.
    for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      expect(getCustomBadgePosition(position)).toBe(getDiscountBadgePosition(position));
    }
  });

  it('defaults to a DIFFERENT corner than the discount badge', () => {
    // Otherwise a store that configured neither would immediately hit the
    // mutex and lose its discount badge for no reason the merchant can see.
    expect(CUSTOM_BADGE_DEFAULT_POSITION).not.toBe(DISCOUNT_BADGE_DEFAULT_POSITION);
    expect(getCustomBadgePosition(undefined)).not.toBe(getDiscountBadgePosition(undefined));
  });
});

describe('getCustomBadgeColor', () => {
  it('falls back to the platform primary token when unset', () => {
    expect(getCustomBadgeColor(undefined, undefined)).toBe('hsl(var(--primary))');
  });

  it('falls back when a color is set but no theme is available to resolve it', () => {
    expect(getCustomBadgeColor('token:accent', undefined)).toBe('hsl(var(--primary))');
  });

  it('passes a raw hex through', () => {
    expect(getCustomBadgeColor('#ff6e01', {} as never)).toBe('#ff6e01');
  });

  it('resolves a token:* against the theme', () => {
    expect(getCustomBadgeColor('token:accent', { accent: '#123456' } as never)).toBe('#123456');
  });

  it('falls back to hsl(var(--<key>)) for a token the theme does not define', () => {
    // CLAUDE.md rule 15 — an unresolved token must never render unstyled.
    expect(getCustomBadgeColor('token:accent', {} as never)).toBe('hsl(var(--accent))');
  });
});

describe('resolveCardBadges — rule 1: no label = byte-identical to today', () => {
  it('renders no custom badge and leaves the discount badge alone', () => {
    const r = resolveCardBadges({ product: NO_LABEL, isRtl: false, orderable: true });
    expect(r.customBadgeText).toBeNull();
    expect(r.discountBadgeAllowed).toBe(true);
  });

  it('leaves the discount badge alone even when both would share a corner', () => {
    // The corner arm must be gated on there BEING a custom badge — otherwise
    // every store on the planet loses its discount chip the moment the two
    // positions happen to match.
    const r = resolveCardBadges({
      product: NO_LABEL,
      isRtl: false,
      orderable: true,
      customPosition: 'bottom-left',
      discountPosition: 'bottom-left',
    });
    expect(r.discountBadgeAllowed).toBe(true);
  });

  it('leaves the discount badge alone when out of stock with no label', () => {
    const r = resolveCardBadges({ product: NO_LABEL, isRtl: false, orderable: false });
    expect(r).toEqual({
      customBadgeText: null,
      discountBadgeAllowed: true,
      customBadgePositionCls: 'bottom-3 right-3',
    });
  });

  it('is unaffected by a whitespace-only label', () => {
    const r = resolveCardBadges({
      product: { badgeLabel: '   ', badgeLabelAr: '  ' },
      isRtl: false,
      orderable: true,
      customPosition: 'bottom-left',
      discountPosition: 'bottom-left',
    });
    expect(r).toEqual({
      customBadgeText: null,
      discountBadgeAllowed: true,
      customBadgePositionCls: 'bottom-3 left-3',
    });
  });
});

describe('resolveCardBadges — rule 2: out of stock suppresses the custom badge', () => {
  it('hides the label on a product nobody can buy', () => {
    const r = resolveCardBadges({ product: OFFER, isRtl: false, orderable: false });
    expect(r.customBadgeText).toBeNull();
  });

  it('keeps the discount badge visible when out of stock (unchanged behaviour)', () => {
    // The sale chip has shown in BOTH stock states since the "BUG 2" fix.
    // Suppressing it here would be a regression dressed up as a rule.
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: false,
      customPosition: 'bottom-left',
      discountPosition: 'bottom-left',
    });
    expect(r.discountBadgeAllowed).toBe(true);
  });

  it('shows the label again as soon as the product is orderable', () => {
    expect(
      resolveCardBadges({ product: OFFER, isRtl: false, orderable: true }).customBadgeText
    ).toBe('Offer');
  });

  it('shows the label on a backorderable out-of-stock product (orderable stays true)', () => {
    // Cards compute `orderable = inStock || acceptsBackorder`. A pre-order
    // product is still purchasable, so the promotion is still honest.
    const r = resolveCardBadges({ product: OFFER, isRtl: true, orderable: true });
    expect(r.customBadgeText).toBe('عرض');
  });
});

describe('resolveCardBadges — rule 3: same corner, custom badge wins', () => {
  it('suppresses the discount badge when both land on the same explicit corner', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'top-right',
      discountPosition: 'top-right',
    });
    expect(r.customBadgeText).toBe('Offer');
    expect(r.discountBadgeAllowed).toBe(false);
  });

  it('lets BOTH render when the corners differ', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'top-right',
      discountPosition: 'bottom-left',
    });
    expect(r.customBadgeText).toBe('Offer');
    expect(r.discountBadgeAllowed).toBe(true);
  });

  it('lets both render on the out-of-the-box defaults (bottom-right vs bottom-left)', () => {
    const r = resolveCardBadges({ product: OFFER, isRtl: false, orderable: true });
    expect(r.customBadgeText).toBe('Offer');
    expect(r.discountBadgeAllowed).toBe(true);
  });

  it('compares RESOLVED corners: an unset position collides with its explicit twin', () => {
    // Unset custom = 'bottom-right'. A merchant who explicitly moved the
    // DISCOUNT badge to bottom-right must not get two chips stacked there
    // just because the custom position was never saved.
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      discountPosition: 'bottom-right',
    });
    expect(r.discountBadgeAllowed).toBe(false);
  });

  it('compares RESOLVED corners in the other direction too', () => {
    // Unset discount = 'bottom-left'; custom explicitly moved onto it.
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'bottom-left',
    });
    expect(r.discountBadgeAllowed).toBe(false);
  });

  it('never suppresses the discount badge on a surface with no corners', () => {
    // `minimal` renders its discount as inline text under the price, and the
    // PDP renders both as inline <Badge>s in a flex row. Neither can collide,
    // so the corner arm must not fire and steal the discount indicator.
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'bottom-left',
      discountPosition: 'bottom-left',
      discountOccupiesCorner: false,
    });
    expect(r.customBadgeText).toBe('Offer');
    expect(r.discountBadgeAllowed).toBe(true);
  });
});

describe('resolveCardBadges — the three-way combination', () => {
  it('label + discount + out of stock collapses to exactly today’s rendering', () => {
    // Rule 2 removes the custom badge, so what is left is "discount badge on
    // an out-of-stock product" — which is what the storefront rendered before
    // this feature existed, on every corner configuration.
    for (const customPosition of [
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ] as const) {
      for (const discountPosition of [
        undefined,
        'top-left',
        'top-right',
        'bottom-left',
        'bottom-right',
      ] as const) {
        const r = resolveCardBadges({
          product: OFFER,
          isRtl: false,
          orderable: false,
          customPosition,
          discountPosition,
        });
        expect(r.customBadgeText).toBeNull();
        expect(r.discountBadgeAllowed).toBe(true);
        // Rule 4 never fires without a label: there is no chip to lift.
        expect(r.customBadgePositionCls).not.toContain('-12');
      }
    }
  });

  it('never permits two chips on one corner for any reachable combination', () => {
    // The single invariant the whole mutex exists for, asserted exhaustively
    // over every corner pair × stock state × locale.
    const corners = [undefined, 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
    for (const customPosition of corners) {
      for (const discountPosition of corners) {
        for (const orderable of [true, false]) {
          for (const isRtl of [true, false]) {
            const r = resolveCardBadges({
              product: OFFER,
              isRtl,
              orderable,
              customPosition,
              discountPosition,
            });
            const bothVisible = r.customBadgeText !== null && r.discountBadgeAllowed;
            const sameCorner =
              getCustomBadgePosition(customPosition) === getDiscountBadgePosition(discountPosition);
            expect(bothVisible && sameCorner).toBe(false);
          }
        }
      }
    }
  });
});
