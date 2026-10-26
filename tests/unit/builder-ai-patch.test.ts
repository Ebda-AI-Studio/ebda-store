/**
 * Builder Phase 5: AI patch editing. The model proposes a STRUCTURED patch (never code); the patch
 * is Zod-validated, applied through the editor's own reducer, and the result must still validate.
 */
import { describe, it, expect } from 'vitest';
import {
  aiPatchSchema,
  applyAiPatch,
  describeAiPatchContext,
  layoutToDefinition,
  resolveLayoutSettings,
  validateDefinitionSync,
  type PageDefinition,
} from '@ebda/shared';
import { loadLayoutFixture } from '../fixtures/builder/homepage-data';

const base = (): PageDefinition =>
  layoutToDefinition(resolveLayoutSettings(loadLayoutFixture('default-flow'), 'modern'));

describe('aiPatchSchema', () => {
  it('accepts the allowed ops', () => {
    const p = aiPatchSchema.safeParse({
      summaryEn: 'x',
      summaryAr: 'س',
      ops: [{ op: 'setSectionSetting', id: 'hero', key: 'title', value: 'Hi' }],
    });
    expect(p.success).toBe(true);
  });
  it('rejects unknown ops, free code, object values and too many ops', () => {
    const bad = (ops: unknown[]) =>
      aiPatchSchema.safeParse({ summaryEn: 'x', summaryAr: 'x', ops }).success;
    expect(bad([{ op: 'eval', code: 'alert(1)' }])).toBe(false);
    expect(bad([{ op: 'setSectionSetting', id: 'a', key: 'k', value: { nested: 1 } }])).toBe(false);
    expect(bad(Array.from({ length: 13 }, () => ({ op: 'removeSection', id: 'a' })))).toBe(false);
    expect(bad([{ op: 'setSectionSetting', id: 'a', key: '__proto__', value: 'x' }])).toBe(false);
  });
});

describe('applyAiPatch', () => {
  it('sets a declared setting and reports before/after', () => {
    const doc = base();
    const hero = doc.sections.find(s => s.type === 'hero')!;
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: hero.id, key: 'autoplayMs', value: 8000 },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({
      op: 'setSectionSetting',
      id: hero.id,
      key: 'autoplayMs',
      after: 8000,
    });
    expect(r.doc.sections.find(s => s.id === hero.id)!.settings.autoplayMs).toBe(8000);
    expect(validateDefinitionSync(r.doc).errors).toEqual([]);
  });
  it('rejects a key the section type does not declare, leaving the doc unchanged', () => {
    const doc = base();
    const hero = doc.sections.find(s => s.type === 'hero')!;
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: hero.id, key: 'dangerousHtml', value: '<script>' },
    ]);
    expect(r.changes).toEqual([]);
    expect(r.rejected[0]).toMatchObject({ index: 0, reason: 'UNKNOWN_SETTING' });
    expect(r.doc).toBe(doc);
  });
  it('rejects an out-of-range or wrong-typed value', () => {
    const doc = base();
    const hero = doc.sections.find(s => s.type === 'hero')!;
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: hero.id, key: 'autoplayMs', value: 99999999 },
      { op: 'setSectionSetting', id: hero.id, key: 'mode', value: 'spin' },
    ]);
    expect(r.changes).toEqual([]);
    expect(r.rejected.map(x => x.reason)).toEqual(['BAD_VALUE', 'BAD_VALUE']);
  });
  it('drops an op that changes nothing (already hidden, same value), so the diff never lies', () => {
    const doc = base();
    const hero = doc.sections.find(s => s.type === 'hero')!;
    const same = hero.settings.autoplayMs;
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: hero.id, key: 'autoplayMs', value: same as number },
      { op: 'setSectionHidden', id: hero.id, hidden: !!hero.hidden },
    ]);
    expect(r.changes).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.doc).toBe(doc);
  });
  it('reports the real before value for hide/show', () => {
    const doc = base();
    const sec = doc.sections.find(s => s.type === 'testimonials')!;
    const r = applyAiPatch(doc, [{ op: 'setSectionHidden', id: sec.id, hidden: true }]);
    expect(r.changes[0]).toMatchObject({ op: 'setSectionHidden', before: false, after: true });
  });
  it('rejects a section id that does not exist', () => {
    const r = applyAiPatch(base(), [{ op: 'setSectionHidden', id: 'nope', hidden: true }]);
    expect(r.rejected[0].reason).toBe('NOT_FOUND');
  });
  it('adds a section from a preset', () => {
    const doc = base();
    const r = applyAiPatch(doc, [{ op: 'addSection', sectionType: 'newsletter', presetIndex: 0 }]);
    expect(r.rejected).toEqual([]);
    expect(r.doc.sections.length).toBe(doc.sections.length + 1);
  });
  it('puts a theme change in the draft theme patch only for editable keys', () => {
    const doc = base();
    const ok = applyAiPatch(doc, [{ op: 'setTheme', key: 'primaryColor', value: '#112233' }]);
    expect(ok.rejected).toEqual([]);
    expect(ok.doc.theme?.primaryColor).toBe('#112233');
    const bad = applyAiPatch(doc, [{ op: 'setTheme', key: 'notAThemeKey', value: 'x' }]);
    expect(bad.rejected[0].reason).toBe('UNKNOWN_THEME_KEY');
  });
  it('does not mutate its input', () => {
    const doc = base();
    const snap = JSON.stringify(doc);
    applyAiPatch(doc, [{ op: 'setTheme', key: 'primaryColor', value: '#112233' }]);
    expect(JSON.stringify(doc)).toBe(snap);
  });
});

describe('describeAiPatchContext', () => {
  it('lists sections with their declared setting keys and no raw urls of customers', () => {
    const ctx = describeAiPatchContext(base());
    expect(ctx.sections.length).toBeGreaterThan(0);
    expect(ctx.sections[0]).toHaveProperty('settingKeys');
    expect(ctx.addableTypes.length).toBeGreaterThan(0);
    expect(ctx.themeKeys).toContain('primaryColor');
  });
});
