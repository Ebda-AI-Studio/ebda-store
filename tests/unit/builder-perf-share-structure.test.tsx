// @vitest-environment jsdom
/**
 * Task 13 performance: a `render` message carries a freshly parsed document, so object identity is
 * lost at the postMessage boundary. `shareStructure` gives every unchanged section back its old
 * object, and `DocumentSectionBody` (memoized by that identity) then re-renders ONE section for a
 * text edit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { shareStructure, layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const base = () => {
  let d = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
  return d;
};

describe('shareStructure', () => {
  it('returns the previous document itself when nothing changed', () => {
    const prev = base();
    expect(shareStructure(prev, clone(prev))).toBe(prev);
  });

  it('keeps the identity of every unchanged node and replaces only the edited one', () => {
    const prev = base();
    const next = clone(prev);
    const edited = next.sections[1];
    edited.settings = { ...edited.settings, heading: 'changed' };
    const out = shareStructure(prev, next);
    expect(out).not.toBe(prev);
    out.sections.forEach((n, i) => {
      if (i === 1) expect(n).toBe(next.sections[1]);
      else expect(n).toBe(prev.sections[i]);
    });
    expect(out.sectionGroups.header[0]).toBe(prev.sectionGroups.header[0]);
    expect(out.sectionGroups.footer[0]).toBe(prev.sectionGroups.footer[0]);
  });

  it('a reordered list keeps each moved node by id, a new node is taken as is', () => {
    const prev = base();
    const next = clone(prev);
    next.sections.reverse();
    const out = shareStructure(prev, next);
    for (const n of out.sections) expect(n).toBe(prev.sections.find(p => p.id === n.id));
    const added = clone(prev);
    added.sections.push({ ...clone(prev.sections[0]), id: 'brand-new-1' });
    const out2 = shareStructure(prev, added);
    expect(out2.sections.at(-1)).toBe(added.sections.at(-1));
  });

  it('is safe with no previous document', () => {
    const next = base();
    expect(shareStructure(null, next)).toBe(next);
  });
});

describe('DocumentSectionBody memoization', () => {
  afterEach(cleanup);

  it('a text edit re-renders one section body, not the page', async () => {
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock('../../apps/web/src/builder/sections/ImageTextSection', () => ({
      ImageTextSection: ({ settings }: { settings: { heading?: string } }) => {
        calls.push(settings.heading ?? '');
        return <p>{settings.heading}</p>;
      },
    }));
    vi.doMock('../../apps/web/src/contexts/StoreContext', () => ({
      useStore: () => ({ store: { look: undefined, theme: {} } }),
    }));
    const { DocumentSectionBody } = await import('../../apps/web/src/builder/render/PageRenderer');
    const { sectionToLegacy } = await import('@ebda/shared');
    const mk = (id: string, heading: string) =>
      ({ id, type: 'image-text', settings: { heading }, blocks: [] }) as never;
    const a = mk('image-text-1', 'A');
    const b = mk('image-text-2', 'B');
    void sectionToLegacy;
    const props = {
      newArrivals: [],
      bestSellers: [],
      featured: [],
      extra: [],
      categories: [],
      templateId: 'modern' as never,
      editorMode: true,
      showPrice: true,
      layout: {} as never,
      stagePriority: false,
      onAddToCart: async () => {},
    };
    const Page = ({ s }: { s: unknown[] }) => (
      <>
        {s.map((x: any) => (
          <DocumentSectionBody key={x.id} section={x} {...props} />
        ))}
      </>
    );
    const { rerender } = render(<Page s={[a, b]} />);
    expect(calls.length).toBe(2);
    calls.length = 0;
    rerender(<Page s={[mk('image-text-1', 'A!'), b]} />);
    expect(calls.length).toBe(1);
    calls.length = 0;
    rerender(<Page s={[mk('image-text-1', 'A!'), b]} />); // new object for A again, same value
    expect(calls.length).toBe(1);
  });
});
