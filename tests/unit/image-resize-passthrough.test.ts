/**
 * Ruling FU46-8: the upload resizer no longer uses `sharp` (it cannot load on workerd, where
 * production runs and where both functions already returned the original). One behaviour on
 * every runtime: the original bytes are stored; resizing belongs to delivery (not wired yet).
 */
import { describe, it, expect } from 'vitest';
import { enforceMaxDimensions, resizeToAspect } from '@api/services/image-resize.service';
import { fakePng } from '../helpers/png-fixtures';

describe('image-resize is a pass-through on every runtime', () => {
  it('returns the very same buffer for an oversized image and any aspect', async () => {
    const big = fakePng(6000, 4000);
    expect(await enforceMaxDimensions(big)).toBe(big);
    expect(await resizeToAspect(big, '1:1')).toBe(big);
    expect(await resizeToAspect(big, undefined)).toBe(big);
  });
});
