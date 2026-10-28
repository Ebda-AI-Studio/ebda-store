import { describe, expect, it } from 'vitest';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import { fieldDefId, parseDeepLink, resolveDeepLink } from './deeplink';

const base = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
// The default home has no header section or slides: add one of each so every lookup path is real.
const doc = {
  ...base,
  sectionGroups: {
    ...base.sectionGroups,
    header: [{ id: 'hdr-1', type: 'header', settings: {} }],
  },
  sections: base.sections.map(n =>
    n.type === 'hero' ? { ...n, blocks: [{ id: 'slide-1', type: 'slide', settings: {} }] } : n
  ),
} as typeof base;
const q = (s: string) => new URLSearchParams(s);

describe('builder deep link', () => {
  const grid = doc.sections.find(n => n.type === 'category-grid')!;
  const hero = doc.sections.find(n => n.type === 'hero')!;

  it('selects by section id', () => {
    expect(resolveDeepLink(doc, { select: grid.id }).selection).toEqual({ sectionId: grid.id });
  });
  it('selects the first section of a type', () => {
    expect(resolveDeepLink(doc, { select: 'category-grid' }).selection?.sectionId).toBe(grid.id);
  });
  it('finds a header or footer section by type', () => {
    const header = doc.sectionGroups.header[0];
    expect(resolveDeepLink(doc, { select: header.type }).selection?.sectionId).toBe(header.id);
  });
  it('selects a block by type and keeps the field', () => {
    const slide = hero.blocks?.[0];
    expect(slide).toBeTruthy();
    const r = resolveDeepLink(doc, { select: 'hero', block: slide!.type, field: 'video' });
    expect(r).toEqual({
      selection: { sectionId: hero.id, blockId: slide!.id },
      field: 'video',
    });
  });
  it('ignores an unknown section, an unknown block and never throws', () => {
    expect(resolveDeepLink(doc, { select: 'no-such-section' }).selection).toBeUndefined();
    expect(resolveDeepLink(doc, { select: 'hero', block: 'nope' }).selection).toEqual({
      sectionId: hero.id,
    });
    expect(() => resolveDeepLink(null, { select: 'hero' })).not.toThrow();
    expect(() => resolveDeepLink({} as never, { select: 'hero' })).not.toThrow();
  });
  it('opens the theme and history tabs, theme only where the page has one', () => {
    expect(resolveDeepLink(doc, { select: 'theme', field: 'builder.header-logo' })).toEqual({
      tab: 'theme',
      field: 'builder.header-logo',
    });
    expect(resolveDeepLink(doc, { select: 'history' }).tab).toBe('history');
    expect(resolveDeepLink(doc, { select: 'theme' }, { canOpenTheme: false }).tab).toBeUndefined();
  });
  it('Object.prototype names are not tabs or aliases', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const r = resolveDeepLink(doc, { select: name, field: name }, { canOpenTheme: true });
      expect(r.tab).toBeUndefined();
      expect(r.selection).toBeUndefined();
      expect(fieldDefId(name)).toBe(name);
    }
  });
  it('drops values that are not plain tokens', () => {
    expect(parseDeepLink(q('select=<script>&field=a b&block=../x'))).toEqual({});
    expect(parseDeepLink(q('select=' + 'a'.repeat(200)))).toEqual({});
    expect(parseDeepLink(q('select=hero&field=builder.header-logo'))).toEqual({
      select: 'hero',
      field: 'builder.header-logo',
    });
    expect(parseDeepLink(null)).toEqual({});
  });
});
