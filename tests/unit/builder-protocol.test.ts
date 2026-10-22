/**
 * `ebda-builder:v1` is strict: every message type is a `.strict()` Zod object,
 * ids and keys are regex-bound, strings are capped, and a message is accepted
 * only from the expected origin AND window. Each new child-to-parent type gets
 * its rows here (the plan's rule: no message type without a schema + a test).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILDER_PROTOCOL,
  acceptMessage,
  childToParentSchema,
  parentToChildSchema,
} from '@ebda/shared';

const base = { protocol: BUILDER_PROTOCOL };
const child = (m: Record<string, unknown>) => childToParentSchema.safeParse({ ...base, ...m });

/** Valid example of every child -> parent type. */
const VALID: Array<Record<string, unknown>> = [
  { type: 'ready' },
  { type: 'select', sectionId: 'hero', blockId: 'slide-1' },
  { type: 'hover', sectionId: 'hero', blockId: 'slide-1' },
  { type: 'hover', sectionId: null },
  { type: 'patch-text', sectionId: 'hero', blockId: 'slide-1', key: 'headlineAr', value: 'تمور' },
  { type: 'request-media', sectionId: 'hero', blockId: 'slide-1', key: 'image' },
  { type: 'section-op', sectionId: 'hero', op: 'moveUp' },
  { type: 'section-op', sectionId: 'hero', blockId: 'slide-1', op: 'remove' },
  { type: 'move', sectionId: 'hero', toIndex: 2 },
  { type: 'move', sectionId: 'hero', blockId: 'slide-1', toIndex: 0 },
  { type: 'request-add', list: 'template', index: 3 },
];

describe('child -> parent messages', () => {
  it.each(VALID)('accepts a valid %o', m => {
    expect(child(m).success).toBe(true);
  });

  it.each(VALID)('rejects an extra key on %o (strict)', m => {
    expect(child({ ...m, extra: 1 }).success).toBe(false);
  });

  it('rejects the wrong protocol version and an unknown type', () => {
    expect(
      childToParentSchema.safeParse({ protocol: 'ebda-builder:v0', type: 'ready' }).success
    ).toBe(false);
    expect(child({ type: 'eval', code: 'x' }).success).toBe(false);
  });

  it('request-media names a target only: a url or html field is refused, keys and ids are bound', () => {
    const ok = { type: 'request-media', sectionId: 'hero', key: 'image' };
    expect(child({ ...ok, url: 'https://evil.test/x.png' }).success).toBe(false);
    expect(child({ ...ok, key: 'image/../x' }).success).toBe(false);
    expect(child({ ...ok, key: '<img>' }).success).toBe(false);
    expect(child({ ...ok, key: 'a'.repeat(42) }).success).toBe(false);
    expect(child({ ...ok, sectionId: '../etc' }).success).toBe(false);
    expect(child({ ...ok, blockId: 'x y' }).success).toBe(false);
  });

  it('patch-text caps the value at 2048 and binds the key', () => {
    const ok = { type: 'patch-text', sectionId: 'hero', key: 'headline' };
    expect(child({ ...ok, value: 'x'.repeat(2048) }).success).toBe(true);
    expect(child({ ...ok, value: 'x'.repeat(2049) }).success).toBe(false);
    expect(child({ ...ok, key: '1bad', value: 'x' }).success).toBe(false);
  });
});

describe('toolbar, drag and insert intents', () => {
  it('section-op accepts only the listed ops', () => {
    for (const op of ['moveUp', 'moveDown', 'duplicate', 'hide', 'remove'])
      expect(child({ type: 'section-op', sectionId: 'hero', op }).success).toBe(true);
    for (const op of ['delete', 'aiFill', 'eval', '', 'MOVEUP'])
      expect(child({ type: 'section-op', sectionId: 'hero', op }).success).toBe(false);
    expect(child({ type: 'section-op', sectionId: 'hero' }).success).toBe(false);
  });

  it('move bounds the index: integer, non-negative, within the limits', () => {
    const ok = { type: 'move', sectionId: 'hero' };
    expect(child({ ...ok, toIndex: 0 }).success).toBe(true);
    expect(child({ ...ok, toIndex: 50 }).success).toBe(true);
    for (const toIndex of [-1, 51, 1.5, NaN, Infinity, '2'])
      expect(child({ ...ok, toIndex }).success).toBe(false);
  });

  it('request-add takes a real group and a bounded index', () => {
    const ok = { type: 'request-add', index: 0 };
    for (const list of ['header', 'template', 'footer'])
      expect(child({ ...ok, list }).success).toBe(true);
    expect(child({ ...ok, list: 'sidebar' }).success).toBe(false);
    expect(child({ ...ok, list: 'template', index: 41 }).success).toBe(false);
    expect(child({ ...ok, list: 'template', index: -1 }).success).toBe(false);
    expect(child({ ...ok, list: 'template', index: 0.5 }).success).toBe(false);
    expect(child({ ...ok, list: 'template', sectionType: 'hero' }).success).toBe(false);
  });
});

describe('parent -> child messages', () => {
  it('rejects a child-only type and an extra key', () => {
    expect(
      parentToChildSchema.safeParse({ ...base, type: 'request-media', sectionId: 'a', key: 'b' })
        .success
    ).toBe(false);
    expect(
      parentToChildSchema.safeParse({ ...base, type: 'select', sectionId: null, extra: 1 }).success
    ).toBe(false);
    expect(
      parentToChildSchema.safeParse({
        ...base,
        type: 'select',
        sectionId: 'hero',
        blockId: 'slide-1',
      }).success
    ).toBe(true);
  });
});

describe('acceptMessage: origin AND source', () => {
  const peer = {};
  const ev = (over: Record<string, unknown>) => ({
    origin: 'https://store.test',
    source: peer,
    data: { ...base, type: 'ready' },
    ...over,
  });
  it('accepts the expected origin + window', () => {
    expect(acceptMessage(ev({}), 'https://store.test', peer, childToParentSchema)).toEqual({
      ...base,
      type: 'ready',
    });
  });
  it('drops a wrong origin, a wrong window, a missing expectation and a bad payload', () => {
    const s = childToParentSchema;
    expect(
      acceptMessage(ev({ origin: 'https://evil.test' }), 'https://store.test', peer, s)
    ).toBeNull();
    expect(acceptMessage(ev({ source: {} }), 'https://store.test', peer, s)).toBeNull();
    expect(acceptMessage(ev({}), null, peer, s)).toBeNull();
    expect(acceptMessage(ev({}), 'https://store.test', null, s)).toBeNull();
    expect(
      acceptMessage(ev({ data: { ...base, type: 'ready', x: 1 } }), 'https://store.test', peer, s)
    ).toBeNull();
  });
});
