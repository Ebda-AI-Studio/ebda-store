// T7: the five signature sections are registered editor sections (add / remove / reorder through the
// registry), bilingual, AI-fillable, part of every look's default mix (Lookbook aside: its hero IS the
// collage), and their presets never invent a claim about a merchant's products.
import { describe, it, expect } from 'vitest';
import {
  AI_FILL_SECTIONS,
  LOOKS,
  SECTION_REGISTRY,
  SIGNATURE_SECTION_TYPES,
  TEMPLATE_FAMILIES,
  getSectionDefinition,
  sectionFromPreset,
  validatePublishReadiness,
  layoutToDefinition,
  resolveLayoutSettings,
  type TemplateId,
} from '@ebda/shared';
import { translations } from '../../apps/web/src/contexts/LanguageContext';

const BY_TEMPLATE: Record<string, string> = {
  qamar: 'editorial-collage',
  souq: 'spec-sheet',
  jasmine: 'key-ingredients',
  lamma: 'kitchen-days',
  dahab: 'piece-window',
};

describe('signature sections in the editor registry', () => {
  it('there are exactly five, one per template', () => {
    expect([...SIGNATURE_SECTION_TYPES].sort()).toEqual(Object.values(BY_TEMPLATE).sort());
  });

  it.each(Object.values(BY_TEMPLATE))(
    '%s is a movable, removable template section with a preset',
    type => {
      const d = getSectionDefinition(type)!;
      expect(d).toBeDefined();
      expect(d.group).toBe('template');
      expect(d.pinned).toBe(false);
      expect(d.legacyKey).toBeNull();
      expect(d.pages).toEqual(['home']);
      expect(d.presets.length).toBeGreaterThan(0);
      expect(d.labelAr.length).toBeGreaterThan(0);
      // the preset is a valid section (settings + blocks pass the save schema)
      const node = sectionFromPreset(type, 0, `sig-${type}`);
      expect(d.propsSchema.safeParse(node.settings).success).toBe(true);
      for (const blk of node.blocks ?? []) {
        const bd = d.blocks.find(x => x.type === blk.type)!;
        expect(bd.propsSchema!.safeParse(blk.settings).success).toBe(true);
        expect(node.blocks!.length).toBeLessThanOrEqual(bd.maxCount);
      }
    }
  );

  it('every text setting is bilingual except the spec figure and links', () => {
    for (const type of SIGNATURE_SECTION_TYPES) {
      const d = getSectionDefinition(type)!;
      const all = [...d.settings, ...d.blocks.flatMap(bl => bl.settings)];
      for (const s of all) {
        expect(s.labelAr, `${type}.${s.id}`).toBeTruthy();
        if ((s.type === 'text' || s.type === 'textarea') && s.id !== 'value')
          expect(s.localized, `${type}.${s.id} must be bilingual`).toBe(true);
      }
    }
  });

  it('the AI button fills their kicker and subtitle', () => {
    for (const type of SIGNATURE_SECTION_TYPES) {
      expect(AI_FILL_SECTIONS[type]).toBe('signature');
      const ids = getSectionDefinition(type)!.settings.map(s => s.id);
      expect(ids).toEqual(expect.arrayContaining(['kicker', 'subtitle', 'title']));
    }
  });

  it('the registry still has one entry per type', () => {
    const types = SECTION_REGISTRY.map(d => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('part of each look default, never pushed onto an existing store', () => {
  it('every look but Lookbook names its template signature exactly once', () => {
    for (const look of LOOKS) {
      const sig = BY_TEMPLATE[look.template];
      const n = (look.sections ?? []).filter(s => s.type === sig).length;
      expect(n, look.id).toBe(look.id === 'qamar.lookbook' ? 0 : 1);
    }
  });
  it('each template family lists its signature among its section types', () => {
    for (const f of TEMPLATE_FAMILIES)
      if (BY_TEMPLATE[f.id]) expect(f.sectionTypes, f.id).toContain(BY_TEMPLATE[f.id]);
  });
  it('a store home built from its saved layout has none (existing stores are not changed)', () => {
    for (const skin of Object.keys(BY_TEMPLATE) as TemplateId[]) {
      const doc = layoutToDefinition(resolveLayoutSettings({}, skin));
      expect(
        doc.sections.some(s => SIGNATURE_SECTION_TYPES.includes(s.type)),
        skin
      ).toBe(false);
    }
  });
  it('a fresh-store page holding every preset passes the publish gate (no placeholder copy)', () => {
    const doc = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
    const withSigs = {
      ...doc,
      sections: [
        ...doc.sections,
        ...SIGNATURE_SECTION_TYPES.map(t => sectionFromPreset(t, 0, `sig-${t}`)),
      ],
    };
    const errs = validatePublishReadiness(withSigs as never).filter(e =>
      String((e as { path?: string }).path ?? '').includes('sig-')
    );
    expect(errs).toEqual([]);
  });
});

describe('i18n parity', () => {
  it('every storefront string the sections add has an Arabic translation', () => {
    for (const key of [
      'Add photos or a title and your collage will appear here.',
      'Add a photo or a title and your window will appear here.',
      'Add at least two figures and your spec sheet will appear here.',
      'Add at least two ingredients and they will appear here.',
      'Add a dish to at least two days and your kitchen days will appear here.',
      'Kitchen days',
    ] as const) {
      const ar = (translations as Record<string, string>)[key];
      expect(ar, key).toMatch(/[؀-ۿ]/);
    }
  });
});
