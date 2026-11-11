/** #620 / NEVER-OVERWRITE-1: category + image AI writes are one atomic conditional write per field. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ updateMany: vi.fn() }));
vi.mock('@api/lib/repo-factory', async orig => ({
  ...((await orig()) as object),
  storeWriter: async () => ({
    category: { updateMany: h.updateMany },
    productImage: { updateMany: h.updateMany },
  }),
}));

import { writeBulkRowFields } from '@api/services/ai-autofill.service';

describe('writeBulkRowFields', () => {
  beforeEach(() => h.updateMany.mockReset());

  it('a blank field is written only while it is STILL blank (merchant edit during the AI wait wins: count 0)', async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    const w = await writeBulkRowFields(
      's',
      'category',
      'c1',
      { metaTitle: null },
      { metaTitle: 'AI' }
    );
    expect(w).toEqual([]);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', storeId: 's', OR: [{ metaTitle: null }, { metaTitle: '' }] },
      data: { metaTitle: 'AI' },
    });
  });

  it('a filled field is never offered without overwrite; under force it matches only the value read', async () => {
    expect(
      await writeBulkRowFields('s', 'category', 'c1', { metaTitle: 'mine' }, { metaTitle: 'AI' })
    ).toEqual([]);
    expect(h.updateMany).not.toHaveBeenCalled();
    h.updateMany.mockResolvedValue({ count: 1 });
    const w = await writeBulkRowFields(
      's',
      'category',
      'c1',
      { metaTitle: 'old' },
      { metaTitle: 'AI' },
      { overwrite: true }
    );
    expect(w).toEqual(['metaTitle']);
    expect(h.updateMany.mock.calls[0][0].where).toEqual({
      id: 'c1',
      storeId: 's',
      metaTitle: 'old',
    });
  });
});
