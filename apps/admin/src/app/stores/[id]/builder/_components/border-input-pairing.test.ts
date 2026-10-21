import { describe, expect, it } from 'vitest';
import { borderEditPatch } from './border-input-pairing';

describe('borderEditPatch (B1-43 follow-up)', () => {
  it('a Borders edit moves an input colour that was paired with the border', () => {
    expect(
      borderEditPatch({ borderColor: '1 1% 1%', inputColor: '1 1% 1%' }, 'borderColor', '2 2% 2%')
    ).toEqual({ borderColor: '2 2% 2%', inputColor: '2 2% 2%' });
  });
  it('an input colour that differs (a look muted input, an explicit pick) stays', () => {
    expect(
      borderEditPatch({ borderColor: '1 1% 1%', inputColor: '9 9% 9%' }, 'borderColor', '2 2% 2%')
    ).toEqual({ borderColor: '2 2% 2%' });
  });
  it('no stored input colour: only the border (compose pairs it for a store with no look)', () => {
    expect(borderEditPatch({ borderColor: '1 1% 1%' }, 'borderColor', '2 2% 2%')).toEqual({
      borderColor: '2 2% 2%',
    });
  });
  it('any other key is untouched', () => {
    expect(
      borderEditPatch({ borderColor: 'x', inputColor: 'x' }, 'primaryColor', '3 3% 3%')
    ).toEqual({ primaryColor: '3 3% 3%' });
  });
});
