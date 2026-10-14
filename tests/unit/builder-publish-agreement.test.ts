/**
 * Ruling BUILDER-PUBLISH-1 — a published builder document must be the page
 * the storefront renders.
 *
 * Publish back-writes `definitionToLayout(doc)` into `stores.layout_settings`;
 * the public layout route resolves that row against the store's TEMPLATE
 * baseline and serves the published document only when the two agree. The
 * guard used to compare the template-less projection, so every template
 * family (Souq/Dahab/Qamar/Lamma/Jasmine) and every removed section looked
 * like drift and the storefront fell back to the layout-derived page.
 *
 * This simulates the exact publish -> public read path for every template ×
 * (no edit, each family, each editor action) and requires agreement; it also
 * requires a real out-of-band write to still be detected.
 */
import { describe, it, expect } from 'vitest';
import {
  applyTemplateFamily,
  definitionToLayout,
  layoutToDefinition,
  publishedDocumentAgrees,
  reduceDocument,
  resolveLayoutSettings,
  sectionFromPreset,
  TEMPLATE_FAMILIES,
  type PageDefinition,
  type TemplateId,
} from '@ebda/shared';

const TEMPLATES: TemplateId[] = ['modern', 'classic', 'minimal', 'bold', 'elegant'];

/** What the public route serves after `doc` is published on a `t` store. */
function servedAfterPublish(doc: PageDefinition, t: TemplateId) {
  const row: unknown = JSON.parse(JSON.stringify(definitionToLayout(doc))); // JSONB write
  return resolveLayoutSettings(row, t); // public-store-layout.routes.ts
}

function editorVariants(base: PageDefinition): Array<[string, PageDefinition]> {
  const out: Array<[string, PageDefinition]> = [['no edit', base]];
  for (const f of TEMPLATE_FAMILIES) out.push([`family ${f.id}`, applyTemplateFamily(base, f.id)]);
  for (const s of [...base.sectionGroups.header, ...base.sections, ...base.sectionGroups.footer]) {
    const removed = reduceDocument(base, { type: 'removeSection', id: s.id });
    if (!removed.rejected) out.push([`remove ${s.id}`, removed.doc]);
    const hidden = reduceDocument(base, { type: 'setSectionHidden', id: s.id, hidden: true });
    if (!hidden.rejected) out.push([`hide ${s.id}`, hidden.doc]);
  }
  const first = base.sections[0];
  if (first) {
    const moved = reduceDocument(base, {
      type: 'moveSection',
      id: first.id,
      toIndex: base.sections.length - 1,
    });
    if (!moved.rejected) out.push(['move first to last', moved.doc]);
  }
  out.push([
    'add image-text',
    { ...base, sections: [...base.sections, sectionFromPreset('image-text', 0, 'image-text-1')] },
  ]);
  return out;
}

describe('published document agrees with the layout row it back-wrote', () => {
  for (const t of TEMPLATES) {
    for (const raw of [{}, { newArrivals: { enabled: false, limit: 4 } }]) {
      const base = layoutToDefinition(resolveLayoutSettings(raw, t));
      for (const [name, doc] of editorVariants(base)) {
        it(`${t} ${JSON.stringify(raw)} ${name}`, () => {
          expect(publishedDocumentAgrees(doc, servedAfterPublish(doc, t), t)).toBe(true);
        });
      }
    }
  }

  it('a template family changes the page (the case the old guard always rejected)', () => {
    const base = layoutToDefinition(resolveLayoutSettings({}, 'elegant'));
    const dahab = applyTemplateFamily(base, 'dahab');
    expect(dahab.sections.map(s => s.type)).not.toEqual(base.sections.map(s => s.type));
    expect(publishedDocumentAgrees(dahab, servedAfterPublish(dahab, 'elegant'), 'elegant')).toBe(
      true
    );
  });

  it('an out-of-band write to layout_settings is still detected', () => {
    for (const t of TEMPLATES) {
      const doc = applyTemplateFamily(layoutToDefinition(resolveLayoutSettings({}, t)), 'souq');
      const row = JSON.parse(JSON.stringify(definitionToLayout(doc)));
      row.hero = { ...row.hero, enabled: !row.hero.enabled };
      expect(publishedDocumentAgrees(doc, resolveLayoutSettings(row, t), t)).toBe(false);
    }
  });

  it('the template matters: resolving against the wrong baseline is drift', () => {
    const doc = applyTemplateFamily(layoutToDefinition(resolveLayoutSettings({}, 'bold')), 'qamar');
    expect(publishedDocumentAgrees(doc, servedAfterPublish(doc, 'bold'), 'elegant')).toBe(false);
  });
});
