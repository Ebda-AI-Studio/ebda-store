import { describe, expect, it } from 'vitest';
import { groupFieldErrors, parseErrorTarget } from './field-errors';

const e = (path: string) => ({ path, messageEn: path, messageAr: path });
const defs = [{ id: 'headline', localized: true }, { id: 'layout' }];

describe('parseErrorTarget', () => {
  it('reads section, block and responsive setting paths', () => {
    expect(parseErrorTarget('/sections/2/settings/layout', '/sections/2')).toEqual({
      blockIndex: null,
      key: 'layout',
    });
    expect(parseErrorTarget('/sections/2/blocks/1/settings/image', '/sections/2')).toEqual({
      blockIndex: 1,
      key: 'image',
    });
    expect(
      parseErrorTarget('/sections/2/responsive/tablet/settings/paddingTop', '/sections/2')
    ).toEqual({ blockIndex: null, key: 'paddingTop' });
  });
  it('is null for another section', () => {
    expect(parseErrorTarget('/sections/3/settings/x', '/sections/2')).toBeNull();
  });
});

describe('groupFieldErrors', () => {
  it('maps a localized Arabic twin onto its definition', () => {
    const g = groupFieldErrors([e('/sections/0/settings/headlineAr')], '/sections/0', null, defs);
    expect(Object.keys(g.byDef)).toEqual(['headline']);
    expect(g.loose).toEqual([]);
  });
  it('keeps unknown keys and block issues loose on the section, and only own block issues on a block', () => {
    const list = [e('/sections/0/settings/nope'), e('/sections/0/blocks/1/settings/layout')];
    expect(groupFieldErrors(list, '/sections/0', null, defs).loose).toHaveLength(2);
    const onBlock = groupFieldErrors(list, '/sections/0', 1, defs);
    expect(Object.keys(onBlock.byDef)).toEqual(['layout']);
    expect(onBlock.loose).toEqual([]);
    expect(groupFieldErrors(list, '/sections/0', 0, defs).loose).toEqual([]);
  });
});
