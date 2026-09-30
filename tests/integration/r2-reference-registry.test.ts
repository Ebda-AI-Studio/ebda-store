/**
 * The shared R2 reference readers against a real Postgres.
 *
 * The unit suite proves the registry matches schema.prisma; this one proves
 * the raw SQL built from it runs against the MIGRATED database (every
 * registered table/column physically exists, `jsonb::text` search works) and
 * that the two readers agree on the P1 case from PR #1977: a PWA icon URL
 * stored only in `stores.pwa_settings` is referenced, so neither the audit's
 * `--apply` nor the per-URL cleanup may delete it.
 *
 * Retry-safe: every fixture is keyed on a per-CALL unique suffix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@force/database';
import {
  R2_REFERENCE_COLUMNS,
  collectReferencedR2Keys,
  isR2UrlReferenced,
} from '../../apps/api/src/lib/r2-references';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const PUBLIC = 'https://pub-r2refs.r2.dev';
const toKey = (url: string) => (url.startsWith(PUBLIC + '/') ? url.slice(PUBLIC.length + 1) : null);

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function makeFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: {
      email: `r2refs-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'R2',
      lastName: 'Refs',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const keys = {
    icon: `stores/${suffix}/pwa/icon192-v1.png`,
    block: `pages/${suffix}/block.webp`,
    blogInline: `pages/${suffix}/inline.jpg`,
    orphan: `misc/${suffix}/nobody.png`,
  };
  const store = await prisma.store.create({
    data: {
      name: `R2 Refs ${suffix}`,
      slug: `r2refs-${suffix}`,
      ownerId: owner.id,
      status: 'active',
      marketingPixels: {},
      pwaSettings: { appName: 'Shop', icon192: `${PUBLIC}/${keys.icon}` },
    },
  });
  created.storeIds.push(store.id);
  await prisma.storePage.create({
    data: {
      storeId: store.id,
      slug: `about-${suffix}`,
      contentBlocks: [{ type: 'image', url: `${PUBLIC}/${keys.block}` }],
    },
  });
  await prisma.blogPost.create({
    data: {
      storeId: store.id,
      slug: `post-${suffix}`,
      title: 'Post',
      content: `<p>Look <img src="${PUBLIC}/${keys.blogInline}"></p>`,
    },
  });
  return keys;
}

afterAll(async () => {
  if (!hasDb) return;
  await prisma.blogPost.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.storePage.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('R2 reference readers on a real database', () => {
  it('every registered table/column exists in the migrated schema', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ t: string; c: string }>>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = current_schema()`
    );
    const physical = new Set(rows.map(r => `${r.t}.${r.c}`));
    const missing = R2_REFERENCE_COLUMNS.map(c => `${c.table}.${c.column}`).filter(
      k => !physical.has(k)
    );
    expect(missing).toEqual([]);
  });

  it('a pwaSettings icon, a CMS image block and an inline blog image are referenced', async () => {
    const keys = await makeFixture();

    const collected = await collectReferencedR2Keys({ run: fn => fn(prisma), toKey });
    expect(collected.has(keys.icon)).toBe(true);
    expect(collected.has(keys.block)).toBe(true);
    expect(collected.has(keys.blogInline)).toBe(true);
    expect(collected.has(keys.orphan)).toBe(false);

    for (const key of [keys.icon, keys.block, keys.blogInline]) {
      expect(await isR2UrlReferenced(prisma, `${PUBLIC}/${key}`, key), key).toBe(true);
    }
    expect(await isR2UrlReferenced(prisma, `${PUBLIC}/${keys.orphan}`, keys.orphan)).toBe(false);
  });
});
