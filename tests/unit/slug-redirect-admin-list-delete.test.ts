/**
 * #903: SlugRedirect had no admin UI surface — a merchant could not see or
 * remove a spuriously-captured bulk-import alias, or a stale redirect
 * blocking an old slug being re-purposed. This covers the two functions the
 * new admin list+delete route (apps/api/src/routes/slug-redirects.routes.ts)
 * is built on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    slugRedirect: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@ebda/database', () => ({ prisma: mockPrisma }));

import {
  listSlugRedirects,
  deleteSlugRedirect,
} from '../../apps/api/src/services/slug-redirect.service';
import { AppError } from '../../apps/api/src/middleware/error-handler';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listSlugRedirects', () => {
  it('scopes the query to the given store and orders newest-first', async () => {
    mockPrisma.slugRedirect.findMany.mockResolvedValue([]);
    mockPrisma.slugRedirect.count.mockResolvedValue(0);
    await listSlugRedirects('store-1');
    expect(mockPrisma.slugRedirect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: 'store-1' },
        // `id` breaks createdAt ties so a bulk import pages stably (issue 2255);
        // one row past the page tells whether another page exists.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 201,
      })
    );
  });

  it('caps the take at 500 even if a larger limit is requested', async () => {
    mockPrisma.slugRedirect.findMany.mockResolvedValue([]);
    mockPrisma.slugRedirect.count.mockResolvedValue(0);
    await listSlugRedirects('store-1', { limit: 10_000 });
    expect(mockPrisma.slugRedirect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 501 })
    );
  });

  it('returns the TOTAL alongside the capped page, so the cap is never silent', async () => {
    // Scoped audit, PR 1978: a bulk import writes hundreds of rows; the list
    // returned the newest 200 with no signal that anything was withheld.
    const rows = Array.from({ length: 201 }, (_, i) => ({ id: `r${i}` }));
    mockPrisma.slugRedirect.findMany.mockResolvedValue(rows);
    mockPrisma.slugRedirect.count.mockResolvedValue(731);
    const result = await listSlugRedirects('store-1');
    // The 201st row is only the "more exists" probe; its predecessor is the cursor.
    expect(result).toEqual({
      rows: rows.slice(0, 200),
      total: 731,
      limit: 200,
      nextCursor: 'r199',
    });
    expect(mockPrisma.slugRedirect.count).toHaveBeenCalledWith({ where: { storeId: 'store-1' } });
  });

  it('filters by either slug, case-insensitively, and counts the SAME filter', async () => {
    mockPrisma.slugRedirect.findMany.mockResolvedValue([]);
    mockPrisma.slugRedirect.count.mockResolvedValue(0);
    await listSlugRedirects('store-1', { q: '  Old-Shirt ' });
    const where = {
      storeId: 'store-1',
      OR: [
        { fromSlug: { contains: 'Old-Shirt', mode: 'insensitive' } },
        { toSlug: { contains: 'Old-Shirt', mode: 'insensitive' } },
      ],
    };
    expect(mockPrisma.slugRedirect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where })
    );
    expect(mockPrisma.slugRedirect.count).toHaveBeenCalledWith({ where });
  });

  it('treats a blank search as no filter', async () => {
    mockPrisma.slugRedirect.findMany.mockResolvedValue([]);
    mockPrisma.slugRedirect.count.mockResolvedValue(0);
    await listSlugRedirects('store-1', { q: '   ' });
    expect(mockPrisma.slugRedirect.count).toHaveBeenCalledWith({ where: { storeId: 'store-1' } });
  });
});

describe('deleteSlugRedirect', () => {
  it('deletes scoped by BOTH id and storeId — a merchant cannot delete another tenant’s row by guessing an id', async () => {
    mockPrisma.slugRedirect.deleteMany.mockResolvedValue({ count: 1 });
    await deleteSlugRedirect('store-1', 'redir-1');
    expect(mockPrisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { id: 'redir-1', storeId: 'store-1' },
    });
  });

  it('throws a 404 AppError when nothing matched (wrong store, or already deleted)', async () => {
    mockPrisma.slugRedirect.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteSlugRedirect('store-1', 'redir-1')).rejects.toThrow(AppError);
    await expect(deleteSlugRedirect('store-1', 'redir-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});
