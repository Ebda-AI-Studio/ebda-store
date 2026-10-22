/**
 * Task 1 of the visual editor: what a click on the canvas selects, and the
 * name chip's label (`targetOf` / `labelFor`), plus the protocol's `hover`.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILDER_PROTOCOL,
  childToParentSchema,
  layoutToDefinition,
  resolveLayoutSettings,
  type PageDefinition,
} from '@ebda/shared';
import {
  labelFor,
  targetOf,
  type ElementLike,
} from '../../apps/web/src/builder/preview/overlay-logic';

/** A tiny DOM: each node has attributes and a parent; `closest` honours `[a]` and `[a="v"]`. */
function node(attrs: Record<string, string>, parent?: ElementLike): ElementLike {
  const self: ElementLike = {
    textContent: '',
    getAttribute: n => attrs[n] ?? null,
    closest: sel => {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (!m) return null;
      const has = m[1] in attrs && (m[2] === undefined || attrs[m[1]] === m[2]);
      if (has) return self;
      return parent ? parent.closest(sel) : null;
    },
  };
  return self;
}

const doc = (): PageDefinition =>
  layoutToDefinition(
    resolveLayoutSettings(
      {
        hero: { enabled: true, slides: [{ image: '/a.jpg' }, { image: '/b.jpg' }] },
        announcement: { enabled: true },
        header: {},
        footer: {},
      } as never,
      'modern'
    )
  );

describe('targetOf', () => {
  it('a click inside a hero slide resolves the section AND the block', () => {
    const d = doc();
    const hero = d.sections.find(n => n.type === 'hero')!;
    const section = node({ 'data-builder-id': hero.id });
    const slide = node({ 'data-builder-block': 'slide-2' }, section);
    const inner = node({}, slide);
    expect(targetOf(inner, d)).toEqual({ sectionId: hero.id, blockId: 'slide-2' });
    expect(targetOf(node({}, section), d)).toEqual({ sectionId: hero.id });
  });

  it('a block marker outside its own section does not count', () => {
    const d = doc();
    const stray = node({ 'data-builder-block': 'slide-1' });
    const section = node({ 'data-builder-id': 'categories' }, stray);
    expect(targetOf(node({}, section), d)).toEqual({ sectionId: 'categories' });
  });

  it('the header, announcement bar and footer resolve to the document sections', () => {
    const d = doc();
    const header = d.sectionGroups.header.find(n => n.type === 'header')!;
    const announcement = d.sectionGroups.header.find(n => n.type === 'announcement')!;
    const footer = d.sectionGroups.footer.find(n => n.type === 'footer')!;
    expect(targetOf(node({}, node({ 'data-zone': 'header' })), d)).toEqual({
      sectionId: header.id,
    });
    expect(targetOf(node({}, node({ 'data-zone': 'beforeHeader' })), d)).toEqual({
      sectionId: announcement.id,
    });
    expect(targetOf(node({}, node({ 'data-zone': 'footer' })), d)).toEqual({
      sectionId: footer.id,
    });
  });

  it('typography zones and unmarked areas select nothing', () => {
    const d = doc();
    expect(targetOf(node({}, node({ 'data-zone': 'heading' })), d)).toBeNull();
    expect(targetOf(node({}), d)).toBeNull();
    expect(targetOf(null, d)).toBeNull();
    // without a document the chrome cannot be resolved
    expect(targetOf(node({}, node({ 'data-zone': 'header' })))).toBeNull();
  });
});

describe('labelFor', () => {
  it('uses the Arabic registry label in ar and the English one in en', () => {
    const d = doc();
    const hero = d.sections.find(n => n.type === 'hero')!;
    expect(labelFor(d, { sectionId: hero.id }, 'ar')).toBe('البانر الرئيسي');
    expect(labelFor(d, { sectionId: hero.id }, 'en')).toBe('Hero banner');
    expect(labelFor(d, { sectionId: hero.id, blockId: 'slide-2' }, 'ar')).toBe('شريحة 2');
    expect(labelFor(d, { sectionId: hero.id, blockId: 'slide-2' }, 'en')).toBe('Slide 2');
    expect(labelFor(d, { sectionId: 'nope' }, 'ar')).toBeNull();
  });
});

describe('protocol: hover carries an optional block id', () => {
  const base = { protocol: BUILDER_PROTOCOL, type: 'hover' as const };
  it('accepts a block id, still strict', () => {
    expect(
      childToParentSchema.safeParse({ ...base, sectionId: 'hero', blockId: 'slide-1' }).success
    ).toBe(true);
    expect(childToParentSchema.safeParse({ ...base, sectionId: null }).success).toBe(true);
    expect(childToParentSchema.safeParse({ ...base, sectionId: 'hero', extra: 1 }).success).toBe(
      false
    );
    expect(
      childToParentSchema.safeParse({ ...base, sectionId: 'hero', blockId: '<x>' }).success
    ).toBe(false);
  });
});
