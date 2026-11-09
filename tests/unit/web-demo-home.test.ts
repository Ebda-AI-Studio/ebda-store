/**
 * Ruling B1-8 / plan amendment C10: the demo showroom's ONE superset home document renders
 * through the current look's section mix, each look with its own hero (`lookTag`). Non-demo
 * stores never take this path (the same object comes back). The function is pure: the stored
 * document is never changed, so a `?look=` preview never mutates the draft (Task 2 deferred minor).
 */
import { describe, it, expect } from 'vitest';
import {
  PAGE_DEFINITION_SCHEMA_VERSION,
  pageDefinitionSchema,
  sectionFromPreset,
  type PageDefinition,
} from '@ebda/shared';
import { demoHomeDefinition } from '../../apps/web/src/lib/demo-home';

const superset = (): PageDefinition =>
  pageDefinitionSchema.parse({
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey: 'home',
    sectionGroups: { header: [], footer: [] },
    siteSettings: {},
    sections: [
      'hero',
      'category-grid',
      'shop-the-look',
      'collection-list',
      'featured-collection',
      'image-text',
      'testimonials',
    ].map(t => sectionFromPreset(t, 0, t)),
  });

/** The seed's shape: one hero per Qamar look, tagged (C10). */
const taggedHeroes = (): PageDefinition => {
  const def = superset();
  const hero = (look: string) => ({
    ...sectionFromPreset('hero', 0, `hero-${look.split('.')[1]}`),
    lookTag: look,
  });
  return {
    ...def,
    sections: [
      hero('qamar.atelier'),
      hero('qamar.lookbook'),
      hero('qamar.vitrine'),
      ...def.sections.filter(s => s.type !== 'hero'),
    ],
  } as PageDefinition;
};

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

describe('demo home renders the superset through the look mix (Ruling B1-8)', () => {
  it('Lookbook: collage hero then shop-the-look; no occasion bands', () => {
    const d = demoHomeDefinition({ isDemo: true, look: 'qamar.lookbook' }, superset())!;
    expect(d.sections.map(s => s.type).slice(0, 2)).toEqual(['hero', 'shop-the-look']);
    expect(d.sections.some(s => s.type === 'collection-list')).toBe(false);
    expect(d.sections[0].settings.presentation).toBe('collage');
  });

  it('Atelier and Vitrine follow their own mix order', () => {
    const a = demoHomeDefinition({ isDemo: true, look: 'qamar.atelier' }, superset())!;
    expect(a.sections.map(s => s.type)).toEqual([
      'hero',
      'category-grid',
      'featured-collection',
      'editorial-collage', // T7 signature
      'image-text',
      'product-carousel',
      'brand-story',
    ]);
    expect(a.sections[0].settings.presentation).toBe('full-bleed');
    const v = demoHomeDefinition({ isDemo: true, look: 'qamar.vitrine' }, superset())!;
    expect(v.sections.map(s => s.type)).toEqual([
      'hero',
      'collection-list',
      'featured-collection',
      'editorial-collage', // T7 signature
      'testimonials',
    ]);
    expect(v.sections.find(s => s.type === 'collection-list')!.settings.tileShape).toBe('band');
  });

  it("each look shows its own tagged hero, never another look's (C10)", () => {
    for (const look of ['qamar.atelier', 'qamar.lookbook', 'qamar.vitrine']) {
      const d = demoHomeDefinition({ isDemo: true, look }, taggedHeroes())!;
      const heroes = d.sections.filter(s => s.type === 'hero');
      expect(
        heroes.map(h => h.lookTag),
        look
      ).toEqual([look]);
    }
  });

  it('is pure: the stored document is not changed (a frozen document goes through)', () => {
    const def = deepFreeze(taggedHeroes());
    const before = JSON.stringify(def);
    for (const look of ['qamar.atelier', 'qamar.lookbook', 'qamar.vitrine'])
      expect(() => demoHomeDefinition({ isDemo: true, look }, def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
  });

  it('a non-demo store is returned untouched (same object)', () => {
    const def = superset();
    expect(demoHomeDefinition({ isDemo: false, look: 'qamar.lookbook' }, def)).toBe(def);
    expect(demoHomeDefinition({ look: 'qamar.lookbook' }, def)).toBe(def);
  });

  it('a demo store with no look / unknown look / a look with no mix is untouched', () => {
    const def = superset();
    expect(demoHomeDefinition({ isDemo: true, look: null }, def)).toBe(def);
    expect(demoHomeDefinition({ isDemo: true, look: 'qamar.gone' }, def)).toBe(def);
  });

  it('undefined definition stays undefined', () =>
    expect(demoHomeDefinition({ isDemo: true, look: 'qamar.atelier' }, undefined)).toBeUndefined());
});
