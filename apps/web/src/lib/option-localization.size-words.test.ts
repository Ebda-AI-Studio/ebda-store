import { describe, it, expect } from 'vitest';
import { localizeOptionName } from './option-localization';

describe('unnamed option whose values are written sizes (QA-C5)', () => {
  it('reads المقاس, never a guessed axis', () => {
    expect(localizeOptionName('Variant', null, true, ['مقاس 6', 'مقاس 7', 'مقاس 9'])).toBe(
      'المقاس'
    );
    expect(localizeOptionName('Variant', null, false, ['Size 6', 'Size 7'])).toBe('Size');
  });
  it('falls back to الخيار when nothing is derivable', () => {
    expect(localizeOptionName('Variant', null, true, ['ذهبي', 'فضي'])).toBe('الخيار');
  });
});
