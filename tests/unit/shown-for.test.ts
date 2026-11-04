/**
 * Ruling EP-1: whether an editor control is shown is a declared rule. The pure function, the
 * registry's own rules, and the inverse guarantee that matters most: no rule hides a control from
 * a look whose own section mix uses it.
 */
import { describe, it, expect } from 'vitest';
import {
  LOOKS,
  SECTION_REGISTRY,
  getSectionDefinition,
  isShown,
  type ShownFor,
} from '@ebda/shared';

const variantOf = (values: Record<string, unknown>) => (key: string) =>
  key in values ? [values[key]] : [];

describe('isShown', () => {
  it('shows a control with no rule everywhere, even for an unknown template', () => {
    expect(isShown({})).toBe(true);
    expect(isShown({}, { template: 'a-template-from-2031', look: null })).toBe(true);
  });

  it('narrows by template, and a legacy store (no look) never matches a look rule', () => {
    const onlyQamar: ShownFor = { templates: ['qamar'] };
    expect(isShown({ shownFor: onlyQamar }, { template: 'qamar' })).toBe(true);
    expect(isShown({ shownFor: onlyQamar }, { template: 'souq' })).toBe(false);
    expect(isShown({ shownFor: onlyQamar }, { template: null })).toBe(false);
    const aLook: ShownFor = { looks: ['lamma.market'] };
    expect(isShown({ shownFor: aLook }, { template: 'lamma', look: 'lamma.market' })).toBe(true);
    expect(isShown({ shownFor: aLook }, { template: 'lamma', look: 'lamma.table' })).toBe(false);
    expect(isShown({ shownFor: aLook }, { template: 'lamma', look: null })).toBe(false);
  });

  it('needs every variant key of one rule (AND) and any rule of a list (OR)', () => {
    const rule: ShownFor = { templates: ['souq'], variants: { layout: ['grid'], tone: ['a'] } };
    expect(
      isShown({ shownFor: rule }, { template: 'souq', variant: variantOf({ layout: 'grid' }) })
    ).toBe(false);
    expect(
      isShown(
        { shownFor: rule },
        { template: 'souq', variant: variantOf({ layout: 'grid', tone: 'a' }) }
      )
    ).toBe(true);
    const either: ShownFor = [{ variants: { layout: ['horizontal'] } }, { templates: ['souq'] }];
    expect(
      isShown({ shownFor: either }, { template: 'qamar', variant: variantOf({ layout: 'grid' }) })
    ).toBe(false);
    expect(
      isShown(
        { shownFor: either },
        { template: 'qamar', variant: variantOf({ layout: 'horizontal' }) }
      )
    ).toBe(true);
    expect(isShown({ shownFor: either }, { template: 'souq' })).toBe(true);
  });

  it('takes a variant rule as satisfied when the caller has no section in hand', () => {
    expect(isShown({ shownFor: { variants: { layout: ['menu'] } } }, { template: 'qamar' })).toBe(
      true
    );
  });
});

describe('the registry rules', () => {
  const setting = (type: string, id: string) =>
    getSectionDefinition(type)!.settings.find(s => s.id === id)!;

  it('shows the category card controls only where a renderer reads them', () => {
    const aspect = setting('category-grid', 'cardAspect');
    expect(isShown(aspect, { template: 'qamar', variant: variantOf({ layout: 'grid' }) })).toBe(
      false
    );
    expect(
      isShown(aspect, { template: 'qamar', variant: variantOf({ layout: 'horizontal' }) })
    ).toBe(true);
    expect(isShown(aspect, { template: 'souq', variant: variantOf({ layout: 'grid' }) })).toBe(
      false
    );
  });

  it('shows the tile tint only to a look that defines aisle colours', () => {
    const tint = setting('category-grid', 'tint');
    const tiles = variantOf({ layout: 'tiles' });
    expect(isShown(tint, { template: 'lamma', look: 'lamma.market', variant: tiles })).toBe(true);
    expect(isShown(tint, { template: 'lamma', look: 'lamma.table', variant: tiles })).toBe(false);
    expect(isShown(tint, { template: 'qamar', look: 'qamar.atelier', variant: tiles })).toBe(false);
  });

  it('shows the menu tabs only for the menu layout', () => {
    const tabs = setting('featured-collection', 'tabs');
    expect(isShown(tabs, { variant: variantOf({ layout: 'menu' }) })).toBe(true);
    expect(isShown(tabs, { variant: variantOf({ layout: 'grid' }) })).toBe(false);
  });

  it('retires the keys no skin reads, and keeps them out of the controls', () => {
    const hero = getSectionDefinition('hero')!;
    // Ruling SP-3: the hero is aspect-driven, so it retires only Width; its Top / Bottom spacing is an outer margin.
    expect(hero.retired).toEqual(['maxWidth']);
    expect(hero.settings.map(s => s.id)).not.toContain('maxWidth');
    for (const t of ['new-arrivals', 'best-sellers', 'product-carousel', 'testimonials'])
      expect(getSectionDefinition(t)!.retired).toEqual(['maxWidth']);
  });
});

describe('no rule hides a control from a look that uses it', () => {
  it('every design / preset key of every look mix stays shown for that look', () => {
    const hidden: string[] = [];
    for (const look of LOOKS)
      for (const spec of look.sections ?? []) {
        const d = SECTION_REGISTRY.find(x => x.type === spec.type);
        if (!d) continue;
        const values: Record<string, unknown> = { ...spec.preset, ...spec.design };
        for (const key of Object.keys(values)) {
          const s = d.settings.find(x => x.id === key || `${x.id}Ar` === key);
          if (!s) continue;
          const ok = isShown(s, {
            template: look.skin,
            look: look.id,
            variant: k => [values[k]],
          });
          if (!ok) hidden.push(`${look.id} ${spec.type} ${key}`);
        }
      }
    expect(hidden).toEqual([]);
  });
});
