import { describe, it, expect } from 'vitest';
import {
  createOptionSchema,
  createOptionValueSchema,
  updateOptionValueSchema,
} from '../../apps/api/src/routes/variant.routes';

// Dropping `.merge(optionValueSwatchSchema)` from any route schema must turn this red.
describe('variant route schemas carry the swatch contract', () => {
  const bad = { swatchHex: 'red' };
  it('createOptionSchema rejects a bad hex and keeps a good one', () => {
    const base = { name: 'Color', values: [{ value: 'Teal' }] };
    expect(
      createOptionSchema.safeParse({ ...base, values: [{ value: 'T', ...bad }] }).success
    ).toBe(false);
    const ok = createOptionSchema.parse({
      ...base,
      values: [{ value: 'T', swatchHex: '#1F4E54' }],
    });
    expect(ok.values[0].swatchHex).toBe('#1F4E54');
  });
  it('createOptionValueSchema rejects a bad hex and keeps null', () => {
    expect(createOptionValueSchema.safeParse({ value: 'T', ...bad }).success).toBe(false);
    expect(createOptionValueSchema.parse({ value: 'T', swatchHex: null }).swatchHex).toBeNull();
  });
  it('updateOptionValueSchema rejects a bad hex / http image and keeps null', () => {
    expect(updateOptionValueSchema.safeParse(bad).success).toBe(false);
    expect(
      updateOptionValueSchema.safeParse({ swatchImageUrl: 'http://x.com/a.png' }).success
    ).toBe(false);
    expect(updateOptionValueSchema.parse({ swatchHex: null, swatchImageUrl: null })).toEqual({
      swatchHex: null,
      swatchImageUrl: null,
    });
  });
});
