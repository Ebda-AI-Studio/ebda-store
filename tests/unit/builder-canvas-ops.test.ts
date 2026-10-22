/**
 * Task 4: the toolbar / drag / "+" intents (parent side) and the pure canvas
 * geometry (drop target, insertion gaps, toolbar state).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILDER_PROTOCOL,
  addRequestFor,
  childToParentSchema,
  intentToAction,
  layoutToDefinition,
  reduceDocument,
  resolveLayoutSettings,
  type DocumentAction,
  type PageDefinition,
} from '@ebda/shared';
import {
  dropTargetFor,
  insertionGaps,
  toolbarStateFor,
  type SlotBox,
} from '../../apps/web/src/builder/preview/overlay-logic';

const msg = (m: Record<string, unknown>) =>
  childToParentSchema.parse({ protocol: BUILDER_PROTOCOL, ...m });

const doc = (): PageDefinition =>
  layoutToDefinition(
    resolveLayoutSettings(
      {
        hero: {
          enabled: true,
          slides: [{ image: '/a.jpg' }, { image: '/b.jpg' }, { image: '/c.jpg' }],
        },
        announcement: { enabled: true },
        header: {},
        footer: {},
      } as never,
      'modern'
    )
  );
const ids = (d: PageDefinition) => d.sections.map(n => n.id);

describe('section-op -> exactly one reducer action', () => {
  const d = doc();
  const [a, b, c] = ids(d);
  const op = (sectionId: string, o: string, blockId?: string) =>
    intentToAction(
      d,
      msg({ type: 'section-op', sectionId, op: o, ...(blockId ? { blockId } : {}) })
    );

  it('moves a section one place up or down in its own list', () => {
    expect(op(b, 'moveUp')?.action).toEqual({ type: 'moveSection', id: b, toIndex: 0 });
    expect(op(b, 'moveDown')?.action).toEqual({ type: 'moveSection', id: b, toIndex: 2 });
  });

  it('does nothing at the ends of the list (no empty history entry)', () => {
    expect(op(a, 'moveUp')).toBeNull();
    expect(op(ids(d)[ids(d).length - 1], 'moveDown')).toBeNull();
  });

  it('duplicate, hide and remove map to their actions; remove asks for confirmation', () => {
    expect(op(c, 'duplicate')?.action).toEqual({ type: 'duplicateSection', id: c });
    expect(op(c, 'hide')?.action).toEqual({ type: 'setSectionHidden', id: c, hidden: true });
    const rm = op(c, 'remove');
    expect(rm?.action).toEqual({ type: 'removeSection', id: c });
    expect(rm?.confirm).toBe('remove');
    // nothing else is destructive
    expect(op(c, 'hide')?.confirm).toBeUndefined();
    expect(op(c, 'duplicate')?.confirm).toBeUndefined();
  });

  it('blocks get the same operations on their own list', () => {
    const hero = d.sections.find(n => n.type === 'hero')!.id;
    expect(op(hero, 'moveDown', 'slide-1')?.action).toEqual({
      type: 'moveBlock',
      sectionId: hero,
      blockId: 'slide-1',
      toIndex: 1,
    });
    expect(op(hero, 'moveUp', 'slide-1')).toBeNull();
    expect(op(hero, 'moveDown', 'slide-3')).toBeNull();
    expect(op(hero, 'duplicate', 'slide-2')?.action).toEqual({
      type: 'duplicateBlock',
      sectionId: hero,
      blockId: 'slide-2',
    });
    expect(op(hero, 'hide', 'slide-2')?.action).toEqual({
      type: 'setBlockHidden',
      sectionId: hero,
      blockId: 'slide-2',
      hidden: true,
    });
    expect(op(hero, 'remove', 'slide-2')).toMatchObject({
      action: { type: 'removeBlock', sectionId: hero, blockId: 'slide-2' },
      confirm: 'remove',
    });
  });

  it('drops ids that are not in the current document', () => {
    expect(op('ghost', 'remove')).toBeNull();
    const hero = d.sections.find(n => n.type === 'hero')!.id;
    expect(op(hero, 'remove', 'slide-9')).toBeNull();
  });

  it('every produced action is accepted by the reducer', () => {
    for (const o of ['moveDown', 'hide', 'remove']) {
      const r = op(b, o)!;
      const out = reduceDocument(d, r.action as DocumentAction);
      expect(out.rejected, o).toBeUndefined();
    }
  });

  it('a fixed (one-per-page) section cannot be duplicated: the reducer refuses and the toolbar disables it', () => {
    const fixed = d.sections.find(n => n.type === 'new-arrivals')!.id;
    const r = op(fixed, 'duplicate')!;
    expect(reduceDocument(d, r.action as DocumentAction).rejected).toBe('CARDINALITY');
    expect(toolbarStateFor(d, { sectionId: fixed })?.disabled.duplicate).toBe(true);
    const many = d.sections.find(n => n.type === 'product-carousel');
    if (many) expect(toolbarStateFor(d, { sectionId: many.id })?.disabled.duplicate).toBe(false);
  });
});

describe('move', () => {
  const d = doc();
  const [a, b, c] = ids(d);
  it('maps to one moveSection / moveBlock; a drop where it already is makes no history entry', () => {
    expect(intentToAction(d, msg({ type: 'move', sectionId: c, toIndex: 0 }))?.action).toEqual({
      type: 'moveSection',
      id: c,
      toIndex: 0,
    });
    expect(intentToAction(d, msg({ type: 'move', sectionId: b, toIndex: 1 }))).toBeNull();
    // an index past the end is clamped to the last place
    expect(intentToAction(d, msg({ type: 'move', sectionId: a, toIndex: 50 }))?.action).toEqual({
      type: 'moveSection',
      id: a,
      toIndex: d.sections.length - 1,
    });
    expect(intentToAction(d, msg({ type: 'move', sectionId: 'ghost', toIndex: 0 }))).toBeNull();
  });
});

describe('request-add', () => {
  const d = doc();
  it('accepts a real list and an index inside it (the end included)', () => {
    expect(addRequestFor(d, msg({ type: 'request-add', list: 'template', index: 2 }))).toEqual({
      list: 'template',
      index: 2,
    });
    const end = d.sections.length;
    expect(
      addRequestFor(d, msg({ type: 'request-add', list: 'template', index: end }))?.index
    ).toBe(end);
  });
  it('drops an index past the end of that list and every other message', () => {
    expect(
      addRequestFor(d, msg({ type: 'request-add', list: 'template', index: d.sections.length + 1 }))
    ).toBeNull();
    expect(addRequestFor(d, msg({ type: 'request-add', list: 'footer', index: 9 }))).toBeNull();
    expect(addRequestFor(d, msg({ type: 'ready' }))).toBeNull();
  });
  it('the reducer inserts at that index', () => {
    const r = reduceDocument(d, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 1,
    });
    expect(r.rejected).toBeUndefined();
    expect(r.doc.sections[1].id).toBe(r.createdId);
  });
});

describe('canvas geometry', () => {
  // three visible sections with a hidden one (doc index 2) between B and C
  const slots: SlotBox[] = [
    { id: 'a', index: 0, top: 0, bottom: 100 },
    { id: 'b', index: 1, top: 100, bottom: 250 },
    { id: 'c', index: 3, top: 250, bottom: 400 },
  ];

  it('insertion gaps: before the first, between neighbours, after the last', () => {
    expect(insertionGaps(slots)).toEqual([
      { index: 0, y: 0 },
      { index: 1, y: 100 },
      { index: 2, y: 250 }, // right after B: the hidden section stays behind it
      { index: 4, y: 400 },
    ]);
    expect(insertionGaps([])).toEqual([]);
  });

  it('dropping C above A lands at index 0; below B is a no-op; dragging A to the end', () => {
    expect(dropTargetFor(slots, 'c', 10)).toMatchObject({ toIndex: 0, noop: false });
    // C dropped right after B goes ahead of the hidden section between them (doc index 2)
    expect(dropTargetFor(slots, 'c', 248)).toMatchObject({ toIndex: 2, noop: false });
    expect(dropTargetFor(slots, 'c', 399)).toMatchObject({ toIndex: 3, noop: true });
    // A dropped on the last gap: final index = last doc index
    expect(dropTargetFor(slots, 'a', 399)).toMatchObject({ toIndex: 3, noop: false });
    // A dropped just below itself is where it already is
    expect(dropTargetFor(slots, 'a', 105)).toMatchObject({ toIndex: 0, noop: true });
    expect(dropTargetFor(slots, 'ghost', 10)).toBeNull();
  });

  it('toolbar state: ends disable the arrows, blocks are not draggable, chrome has none', () => {
    const d = doc();
    const first = d.sections[0].id;
    const last = d.sections[d.sections.length - 1].id;
    expect(toolbarStateFor(d, { sectionId: first })?.disabled.moveUp).toBe(true);
    expect(toolbarStateFor(d, { sectionId: last })?.disabled.moveDown).toBe(true);
    expect(toolbarStateFor(d, { sectionId: first })?.draggable).toBe(true);
    const hero = d.sections.find(n => n.type === 'hero')!.id;
    const blockState = toolbarStateFor(d, { sectionId: hero, blockId: 'slide-1' });
    expect(blockState?.draggable).toBe(false);
    expect(blockState?.disabled.moveUp).toBe(true);
    const header = d.sectionGroups.header.find(n => n.type === 'header')!.id;
    expect(toolbarStateFor(d, { sectionId: header })).toBeNull();
    expect(toolbarStateFor(d, { sectionId: 'ghost' })).toBeNull();
  });
});
