/**
 * Integration test for Task 2: recordSlugRedirect capture helper.
 *
 * Exercises the real helper against the real DB (no mocked prisma) — reuse
 * guard, chain-collapse, and upsert-overwrite semantics on the SlugRedirect
 * table introduced in Task 1.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, SlugEntityType } from '@force/database';
import {
  recordSlugRedirect,
  resolveSlugRedirect,
} from '../../apps/api/src/services/slug-redirect.service';

const EMAIL = `slug-redirect-test-${Date.now()}@example.test`;
let STORE = '';
let userId = '';

describe('recordSlugRedirect', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: 'hashed',
        firstName: 'Slug',
        lastName: 'Redirect',
        role: 'store_admin',
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Slug Redirect Test Store',
        slug: 'slug-redirect-test-store',
        ownerId: user.id,
      },
    });
    STORE = store.id;
  });

  afterAll(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
    await prisma.store.deleteMany({ where: { id: STORE } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
  });

  it('no-op when slug unchanged', async () => {
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'a', 'a')
    );
    expect(await prisma.slugRedirect.count({ where: { storeId: STORE } })).toBe(0);
  });

  it('records old -> new on change', async () => {
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new')
    );
    const row = await prisma.slugRedirect.findFirst({
      where: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'old' },
    });
    expect(row?.toSlug).toBe('new');
  });

  it('reuse guard: recording X->Y deletes any existing fromSlug=Y', async () => {
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'y', 'z')
    ); // y->z exists
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'x', 'y')
    ); // y now live again
    expect(
      await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'y' } })
    ).toBeNull();
    expect(
      (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'x' } }))?.toSlug
    ).toBe('y');
  });

  it('chain-collapse: A->B then B->C rewrites A->C', async () => {
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'a', 'b')
    );
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'b', 'c')
    );
    expect(
      (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'a' } }))?.toSlug
    ).toBe('c');
    expect(
      (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'b' } }))?.toSlug
    ).toBe('c');
  });

  it('upsert overwrites an existing fromSlug target', async () => {
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new1')
    );
    await prisma.$transaction(tx =>
      recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new2')
    );
    expect(
      (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'old' } }))?.toSlug
    ).toBe('new2');
  });

  describe('resolveSlugRedirect', () => {
    it('resolve returns final toSlug on hit', async () => {
      await prisma.$transaction(tx =>
        recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new')
      );
      expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'old')).toBe('new');
    });

    it('resolve returns null on miss', async () => {
      expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'nope')).toBeNull();
    });

    it('resolve backstops a legacy 2-hop row', async () => {
      // Simulate a legacy multi-hop the collapse would normally prevent.
      await prisma.slugRedirect.create({
        data: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'a', toSlug: 'b' },
      });
      await prisma.slugRedirect.create({
        data: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'b', toSlug: 'c' },
      });
      expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'a')).toBe('c');
    });
  });
});
