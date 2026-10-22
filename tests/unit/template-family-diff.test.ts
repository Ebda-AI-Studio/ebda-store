/**
 * The look-switch change report (Task 9, Ruling EP-3): a pure comparison, and the claim it makes to the
 * merchant ("your content stays, only the design changes") is checked against the real
 * `applyTemplateFamily`, not against a hand-made document.
 */
import { describe, it, expect } from 'vitest';
import {
  applyTemplateFamily,
  diffTemplateFamily,
  getLook,
  layoutToDefinition,
  resolveLayoutSettings,
  type PageDefinition,
} from '@ebda/shared';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** A Qamar store with content the merchant wrote. */
function storeDoc(): PageDefinition {
  const layout = resolveLayoutSettings(
    {
      hero: {
        enabled: true,
        mode: 'slider',
        slides: [
          { image: 'https://m.ebda.app/a.jpg', headline: 'Fresh dates', headlineAr: 'تمور طازجة' },
          { image: 'https://m.ebda.app/b.jpg', headline: 'Gift boxes', headlineAr: 'علب هدايا' },
        ],
      },
    },
    'qamar',
    'qamar.atelier'
  );
  return layoutToDefinition(layout);
}

const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id);

describe('diffTemplateFamily', () => {
  const before = storeDoc();
  const look = getLook('qamar.vitrine');
  const after = applyTemplateFamily(before, 'qamar', look, {
    from: getLook('qamar.atelier'),
    design: 'reset',
    fromSkin: { skin: 'qamar', look: 'qamar.atelier' },
    toSkin: { skin: 'qamar', look: 'qamar.vitrine' },
  });

  it('is pure: the inputs may be frozen and are not changed', () => {
    const b = deepFreeze(structuredClone(before));
    const a = deepFreeze(structuredClone(after));
    expect(() => diffTemplateFamily(b, a, ['primaryColor'])).not.toThrow();
  });

  it("the merchant's hero slides are kept and no content setting changes", () => {
    const r = diffTemplateFamily(before, after);
    const hero = before.sections.find(s => s.type === 'hero')!;
    expect(ids(r.keptContent)).toContain(hero.id);
    // the content of a kept section is never touched by a look
    expect(r.contentChanged).toEqual([]);
    const keptHero = after.sections.find(s => s.id === hero.id)!;
    expect(keptHero.blocks?.map(b => b.settings.headline)).toEqual(['Fresh dates', 'Gift boxes']);
  });

  it('lists exactly the sections that appear and leave, by id', () => {
    const r = diffTemplateFamily(before, after);
    const beforeIds = new Set(ids(before.sections));
    const afterIds = new Set(ids(after.sections));
    expect(ids(r.added).sort()).toEqual([...afterIds].filter(i => !beforeIds.has(i)).sort());
    expect(ids(r.droppedFromDraft).sort()).toEqual(
      [...beforeIds].filter(i => !afterIds.has(i)).sort()
    );
    expect(ids(r.keptContent).sort()).toEqual([...afterIds].filter(i => beforeIds.has(i)).sort());
  });

  it('names a changed design field, and a changed content field is reported as content', () => {
    const a: PageDefinition = {
      ...before,
      sections: before.sections.map(s =>
        s.type === 'category-grid'
          ? { ...s, settings: { ...s.settings, layout: 'chips', title: 'Our range' } }
          : s
      ),
    };
    const r = diffTemplateFamily(before, a);
    const cat = before.sections.find(s => s.type === 'category-grid')!;
    expect(r.designChanged).toEqual([
      { section: { id: cat.id, type: 'category-grid' }, fields: ['layout'] },
    ]);
    expect(r.contentChanged).toEqual([
      { section: { id: cat.id, type: 'category-grid' }, fields: ['title'] },
    ]);
  });

  it('identical documents report nothing but kept content; reset theme keys are passed through', () => {
    const r = diffTemplateFamily(before, before, ['primaryColor', 'fontHeading']);
    expect(r.added).toEqual([]);
    expect(r.droppedFromDraft).toEqual([]);
    expect(r.designChanged).toEqual([]);
    expect(r.themeKeysReset).toEqual(['primaryColor', 'fontHeading']);
    expect(r.keptContent).toHaveLength(before.sections.length);
  });
});
