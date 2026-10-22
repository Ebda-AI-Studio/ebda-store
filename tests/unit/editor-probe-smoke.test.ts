import { describe, it, expect } from 'vitest';
import { probeSetting } from '../../scripts/editor-audit/probe';

describe('flip probe (smoke)', () => {
  it('a wired control differs, a made-up one does not', () => {
    const wired = probeSetting('qamar', 'category-grid', 'layout', ['grid', 'chips']);
    expect(wired.error).toBeUndefined();
    expect(wired.differs).toBe(true);
    expect(probeSetting('qamar', 'category-grid', 'zzNotARealKey', ['a', 'b']).differs).toBe(false);
  });
});
