/**
 * listSlugRedirects against real Postgres (scoped audit, PR 1978): the admin
 * list used to return the newest 200 rows with no total and no way to reach
 * an older one. It now returns `{ rows, total, limit }` and filters by either
 * slug, case-insensitively — `mode: 'insensitive'` is a Postgres ILIKE that a
 * mocked Prisma cannot prove, hence this file. Per-call unique store: retry-safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, SlugEntityType } from '@ebda/database';
import { listSlugRedirects } from '../../apps/api/src/services/slug-redirect.service';

const OWNER_ID = '00000000-0000-0000-0000-000000000903';
let storeId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: `slug-list-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Slug',
      lastName: 'List',
    },
  });
  const slug = `slug-list-${randomUUID().slice(0, 8)}`;
  storeId = (await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } })).id;
  await prisma.slugRedirect.createMany({
    data: Array.from({ length: 7 }, (_, i) => ({
      storeId,
      entityType: SlugEntityType.PRODUCT,
      fromSlug: i === 0 ? 'Old-Linen-Shirt' : `old-${i}`,
      toSlug: `new-${i}`,
      createdAt: new Date(Date.now() - (7 - i) * 60_000),
    })),
  });
});

afterAll(async () => {
  await prisma.slugRedirect.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('listSlugRedirects (real Postgres)', () => {
  it('returns the capped page newest-first WITH the full total', async () => {
    const r = await listSlugRedirects(storeId, { limit: 3 });
    expect(r.limit).toBe(3);
    expect(r.total).toBe(7);
    expect(r.rows.map(x => x.fromSlug)).toEqual(['old-6', 'old-5', 'old-4']);
  });

  it('finds a row past the cap by a case-insensitive fragment of either slug', async () => {
    const byFrom = await listSlugRedirects(storeId, { q: 'linen', limit: 3 });
    expect(byFrom.total).toBe(1);
    expect(byFrom.rows[0].fromSlug).toBe('Old-Linen-Shirt');

    const byTo = await listSlugRedirects(storeId, { q: 'NEW-0' });
    expect(byTo.rows.map(x => x.toSlug)).toEqual(['new-0']);
  });

  // Issue 2255: every row is reachable by BROWSING — the cursor walks the
  // whole set, newest first, with no gap and no duplicate.
  it('pages through every row with nextCursor, then reports the end', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await listSlugRedirects(storeId, { limit: 3, cursor });
      seen.push(...r.rows.map(x => x.fromSlug));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(['old-6', 'old-5', 'old-4', 'old-3', 'old-2', 'old-1', 'Old-Linen-Shirt']);
  });
});
