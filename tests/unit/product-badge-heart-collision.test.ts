/**
 * `resolveCardBadges` collision avoidance — issues #1609 (carousel quick-add
 * vs. the default custom-badge corner), #1611 (mobile CTA band vs. the same
 * default) and #548 (collision guard reserving the wrong side). Ahmad's
 * decision: the wishlist heart STAYS where each theme renders it; every
 * badge moves off whichever corner an action button (heart / compare /
 * remove-from-wishlist) or a quick-add/CTA overlay occupies.
 *
 * Every case below is checked in BOTH reading directions — the production
 * bug this fixes (pecannbee.com.kw, Arabic, the "عرض" custom badge under the
 * heart) only reproduced in RTL, because the badge system is PHYSICAL
 * (non-mirroring) while the heart/compare/quick-add system is LOGICAL
 * (start/end, mirrors with direction) — so a corner that's safe in LTR can
 * collide in RTL and vice versa.
 */
import { describe, it, expect } from 'vitest';
import { resolveCardBadges } from '../../apps/web/src/templates/shared/custom-badge';

const OFFER = { badgeLabel: 'Offer', badgeLabelAr: 'عرض' };

describe('resolveCardBadges — heart/compare avoidance (issue #548 class)', () => {
  it.each([false, true])(
    'no reserved corner (isRtl=%s) → the merchant-chosen top corner is untouched',
    isRtl => {
      const r = resolveCardBadges({
        product: OFFER,
        isRtl,
        orderable: true,
        customPosition: 'top-right',
      });
      expect(r.customBadgePositionCls).toBe('top-3 right-3');
    }
  );

  it('LTR: heart at top-end (physical right) pushes a top-right custom badge to top-left', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'top-right',
      topEndReserved: true,
    });
    expect(r.customBadgePositionCls).toBe('top-3 left-3');
  });

  it('RTL: the SAME logical reservation now guards physical LEFT, so top-LEFT is what moves', () => {
    // This is the exact production defect: a badge system that ignores
    // direction while the heart mirrors with it. topEndReserved=true means
    // "the heart is at physical LEFT" in RTL (end mirrors), so a badge
    // explicitly placed at top-left — safe in LTR — must move in RTL.
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: true,
      orderable: true,
      customPosition: 'top-left',
      topEndReserved: true,
    });
    expect(r.customBadgePositionCls).toBe('top-3 right-3');
  });

  it('the pecannbee live bug: heart at top-start collides with an explicit top-right badge in RTL', () => {
    // PecannbeeProductCard's heart is logical top-start — physical top-RIGHT
    // in RTL. A merchant who placed the custom badge at "top-right" (a
    // perfectly normal choice, safe in LTR) got it hidden under the heart
    // on the Arabic storefront. topStartReserved mirrors PecannbeeProductCard.
    const beforeFixWouldCollide = resolveCardBadges({
      product: OFFER,
      isRtl: true,
      orderable: true,
      customPosition: 'top-right',
      // topStartReserved omitted entirely = the pre-fix behaviour: no
      // avoidance ever applied, so the badge stays exactly where named.
    });
    expect(beforeFixWouldCollide.customBadgePositionCls).toBe('top-3 right-3');

    const afterFix = resolveCardBadges({
      product: OFFER,
      isRtl: true,
      orderable: true,
      customPosition: 'top-right',
      topStartReserved: true,
    });
    // Physical top-right === logical top-start in RTL, so the badge must
    // move off it.
    expect(afterFix.customBadgePositionCls).toBe('top-3 left-3');
  });

  it('both top corners reserved (compare + heart both showing) → drops to the bottom, same side', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'top-left',
      topStartReserved: true,
      topEndReserved: true,
    });
    expect(r.customBadgePositionCls).toBe('bottom-3 left-3');
  });

  it('the DEFAULT bottom-right corner never needs avoidance — heart is always on the top edge', () => {
    for (const isRtl of [false, true]) {
      const r = resolveCardBadges({
        product: OFFER,
        isRtl,
        orderable: true,
        topStartReserved: true,
        topEndReserved: true,
      });
      expect(r.customBadgePositionCls).toBe('bottom-3 right-3');
    }
  });

  it('the discount badge gets the SAME avoidance as the custom badge', () => {
    const r = resolveCardBadges({
      product: {},
      isRtl: false,
      orderable: true,
      discountPosition: 'top-left',
      topStartReserved: true,
    });
    expect(r.discountBadgePositionCls).toBe('top-3 right-3');
  });
});

describe('resolveCardBadges — quick-add / CTA-band avoidance (issues #1609/#1611)', () => {
  it('no overlay → the default bottom-right corner is untouched', () => {
    const r = resolveCardBadges({ product: OFFER, isRtl: false, orderable: true });
    expect(r.customBadgePositionCls).toBe('bottom-3 right-3');
  });

  it("issue #1611 — a full-width CTA band ('both') lifts the DEFAULT corner in LTR", () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      bottomOverlay: 'both',
    });
    expect(r.customBadgePositionCls).toBe('bottom-24 right-3');
  });

  it("a full-width CTA band ('both') lifts the DEFAULT corner in RTL too", () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: true,
      orderable: true,
      bottomOverlay: 'both',
    });
    expect(r.customBadgePositionCls).toBe('bottom-24 right-3');
  });

  it("issue #1609 — a corner-only quick-add ('end') only lifts a badge on quick-add's OWN side", () => {
    // Quick-add renders at logical bottom-end = physical bottom-RIGHT in
    // LTR — the exact same corner as the custom badge's default. The
    // default must lift.
    const ltr = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      bottomOverlay: 'end',
    });
    expect(ltr.customBadgePositionCls).toBe('bottom-24 right-3');

    // A badge explicitly placed on the OTHER bottom corner never shares
    // quick-add's footprint, so it must NOT lift.
    const ltrOtherCorner = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'bottom-left',
      bottomOverlay: 'end',
    });
    expect(ltrOtherCorner.customBadgePositionCls).toBe('bottom-3 left-3');
  });

  it("issue #1609 in RTL — quick-add's logical bottom-end is now physical bottom-LEFT", () => {
    // Same production-defect shape as the heart case: a corner-only overlay
    // defined logically must be re-evaluated per direction, not assumed to
    // always guard the physical right.
    const rtlDefaultCorner = resolveCardBadges({
      product: OFFER,
      isRtl: true,
      orderable: true,
      bottomOverlay: 'end',
    });
    // The DEFAULT custom corner (bottom-right, physical, non-mirroring)
    // does NOT share quick-add's RTL corner (bottom-left), so it must stay put.
    expect(rtlDefaultCorner.customBadgePositionCls).toBe('bottom-3 right-3');

    const rtlLeftCorner = resolveCardBadges({
      product: OFFER,
      isRtl: true,
      orderable: true,
      customPosition: 'bottom-left',
      bottomOverlay: 'end',
    });
    expect(rtlLeftCorner.customBadgePositionCls).toBe('bottom-24 left-3');
  });

  it('stacking (rule 4) AND overlay-lift compose to the highest tier', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      discountVisible: true,
      bottomOverlay: 'both',
    });
    // Default corners differ (custom bottom-right, discount bottom-left),
    // so this is the "both render, same edge" stack case, PLUS the overlay.
    expect(r.customBadgePositionCls).toBe('bottom-36 right-3');
    // The discount chip never stacks (rule 4 only ever lifts the custom
    // chip) but still clears the overlay on its own row.
    expect(r.discountBadgePositionCls).toBe('bottom-24 left-3');
  });

  it('a heart-forced bottom corner also respects the overlay lift', () => {
    // Both top corners reserved forces the badge to bottom-left; a
    // full-width CTA band also covers that corner, so it must lift too.
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'top-left',
      topStartReserved: true,
      topEndReserved: true,
      bottomOverlay: 'both',
    });
    expect(r.customBadgePositionCls).toBe('bottom-24 left-3');
  });
});

describe('resolveCardBadges — collision avoidance never reopens the mutex or rule-2 gates', () => {
  it('out of stock still suppresses the custom badge regardless of reservations', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: false,
      topStartReserved: true,
      topEndReserved: true,
      bottomOverlay: 'both',
    });
    expect(r.customBadgeText).toBeNull();
  });

  it('same-corner mutex (rule 3) still suppresses the discount badge with avoidance active', () => {
    const r = resolveCardBadges({
      product: OFFER,
      isRtl: false,
      orderable: true,
      customPosition: 'top-right',
      discountPosition: 'top-right',
      topEndReserved: true,
    });
    expect(r.discountBadgeAllowed).toBe(false);
  });
});
