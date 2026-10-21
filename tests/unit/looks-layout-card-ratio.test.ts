/**
 * Ruling LOOKS-15: on a look store the look owns the DEFAULT product-card image ratio.
 *
 * Found by the Phase S browser check: every look renders on the `minimal` skin, whose layout
 * baseline sets `cardShape: 'square'` (and `cardAspect`) on the product carousels and
 * `productCardDefaults`. `resolveLayoutSettings` merged that baseline in as if the merchant had
 * chosen it, so `cardShapeClasses('square').aspect` beat `lookImageAspectClass` on every card
 * and no look ever showed its `--image-ratio` (qamar.atelier 3/4 rendered square). The baseline
 * now contributes no product-card shape/aspect for a registered look; a merchant's saved value
 * still wins, and a legacy store resolves exactly as before.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveLayoutSettings,
  layoutToDefinition,
  publishedDocumentAgrees,
  type StoreLayoutSettings,
} from '@ebda/shared';

const ratioKeys = (l: StoreLayoutSettings) => ({
  newArrivals: [l.newArrivals.cardShape, l.newArrivals.cardAspect],
  bestSellers: [l.bestSellers.cardShape, l.bestSellers.cardAspect],
  defaults: [l.productCardDefaults?.cardShape, l.productCardDefaults?.cardAspect],
});

describe('resolveLayoutSettings with a look', () => {
  it('a look store gets no product-card shape or aspect from the skin baseline', () => {
    const l = resolveLayoutSettings({}, 'minimal', 'qamar.atelier');
    expect(ratioKeys(l)).toEqual({
      newArrivals: [undefined, undefined],
      bestSellers: [undefined, undefined],
      defaults: [undefined, undefined],
    });
  });

  it('everything else in the baseline is unchanged (categories keep their shape)', () => {
    const legacy = resolveLayoutSettings({}, 'minimal');
    const look = resolveLayoutSettings({}, 'minimal', 'qamar.atelier');
    expect(look.categories).toEqual(legacy.categories);
    expect(look.hero).toEqual(legacy.hero);
    expect(look.newArrivals.cardSize).toBe(legacy.newArrivals.cardSize);
  });

  it("the merchant's saved card shape still wins on a look store", () => {
    const l = resolveLayoutSettings(
      { newArrivals: { cardShape: 'square' }, productCardDefaults: { cardShape: 'portrait' } },
      'minimal',
      'qamar.atelier'
    );
    expect(l.newArrivals.cardShape).toBe('square');
    expect(l.productCardDefaults?.cardShape).toBe('portrait');
  });

  it('a legacy store (null or unknown look) resolves byte-identically to before', () => {
    const before = resolveLayoutSettings({}, 'minimal');
    expect(resolveLayoutSettings({}, 'minimal', null)).toEqual(before);
    expect(resolveLayoutSettings({}, 'minimal', 'qamar.removed')).toEqual(before);
    expect(before.newArrivals.cardShape).toBe('square');
  });

  it('a published look document agrees with its layout only when both sides use the look', () => {
    const layout = resolveLayoutSettings({}, 'minimal', 'qamar.atelier');
    const doc = layoutToDefinition(layout);
    expect(publishedDocumentAgrees(doc, layout, 'minimal', 'qamar.atelier')).toBe(true);
  });
});

// W2b (L-02, live 2026-10-16): a store that published its home BEFORE it took a look kept the old
// skin's baseline `cardShape: 'square'` in its document, so the PLP, search and PDP-related cards
// stayed square on every Qamar look. A look switch now drops the skin's card ratio from the
// document (reset: always; keep: only a value equal to the outgoing skin baseline).
describe('a look switch drops the old skin card ratio from the document (L-02)', async () => {
  const { applyTemplateFamily, getLook, TEMPLATE_LAYOUT_BASELINES } = await import('@ebda/shared');
  const onSkin = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
  const atelier = getLook('qamar.atelier')!;
  const ratio = (d: typeof onSkin) => ({
    defaults: [
      d.siteSettings?.productCardDefaults?.cardShape,
      d.siteSettings?.productCardDefaults?.cardAspect,
    ],
    sections: d.sections
      .filter(s => s.type === 'new-arrivals' || s.type === 'best-sellers')
      .map(s => [s.settings.cardShape, s.settings.cardAspect]),
  });
  it('precondition: the skin document carries the square baseline', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.qamar.productCardDefaults?.cardShape).toBe('square');
    expect(onSkin.siteSettings?.productCardDefaults?.cardShape).toBe('square');
  });
  it('reset: no card shape or aspect is left in the defaults or the product carousels', () => {
    const out = applyTemplateFamily(onSkin, atelier.template, atelier, {
      design: 'reset',
      fromSkin: { skin: 'qamar' },
      toSkin: { skin: 'qamar', look: atelier.id },
    });
    const r = ratio(out);
    expect(r.defaults).toEqual([undefined, undefined]);
    for (const s of r.sections) expect(s).toEqual([undefined, undefined]);
  });
  it('keep: a baseline value goes, a merchant pick stays', () => {
    const edited = {
      ...onSkin,
      siteSettings: {
        ...onSkin.siteSettings,
        productCardDefaults: { ...onSkin.siteSettings?.productCardDefaults, cardShape: 'portrait' },
      },
    } as typeof onSkin;
    const out = applyTemplateFamily(edited, atelier.template, atelier, {
      design: 'keep',
      fromSkin: { skin: 'qamar' },
      toSkin: { skin: 'qamar', look: atelier.id },
    });
    expect(out.siteSettings?.productCardDefaults?.cardShape).toBe('portrait');
    // the carousels still held the untouched skin baseline: gone
    for (const s of ratio(out).sections) expect(s).toEqual([undefined, undefined]);
  });
  it('no look: the document is untouched (a skin family switch keeps its card ratio)', () => {
    const out = applyTemplateFamily(onSkin, 'qamar', null, { design: 'reset' });
    expect(out.siteSettings?.productCardDefaults?.cardShape).toBe('square');
  });
});
