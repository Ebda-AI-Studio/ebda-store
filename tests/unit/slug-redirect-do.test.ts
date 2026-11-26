/**
 * Slug redirects for a store on its Durable Object. SlugRedirect is a platform-D1 model; the storefront reads it through
 * `resolveSlugRedirect` (-> D1 for a DO store). The writers used to be handed the Postgres `prisma` (retired on the Worker), so a
 * rename recorded nothing and the old URL 404'd. Driver proved here: the platform D1 schema (node:sqlite behind the real D1
 * client) with the DO-store flag on and a Postgres handle that throws POSTGRES_REMOVED on any use. Not proved: real D1/workerd.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createD1Client, type D1Like } from '../../packages/repo/src/prisma-lite/d1';
import { META } from '../../packages/repo/test/diff-harness';

const SQL = ['0001_init.sql', '0002_invariants.sql']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');

const h = vi.hoisted(() => ({ client: undefined as unknown, onDo: true }));

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeWritesToDo: async () => h.onDo,
}));
vi.mock('../../apps/api/src/lib/platform-db', () => ({
  requirePlatformDb: async () => h.client,
}));

import { SlugEntityType } from '@ebda/database';
import {
  recordSlugRedirect,
  resolveSlugRedirect,
  clearSlugRedirectCache,
  resolveSlugRedirectCached,
} from '../../apps/api/src/services/slug-redirect.service';

const STORE = '11111111-1111-4111-8111-111111111111';
// what `prisma` is on a Worker without Postgres: any use throws
const removed = new Proxy(
  {},
  {
    get: () => {
      throw new Error('POSTGRES_REMOVED');
    },
  }
) as never;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SQL);
  const d1: D1Like = {
    prepare: sql => ({
      bind: (...v) => {
        const exec = async () => {
          await Promise.resolve();
          if (/^\s*select/i.test(sql))
            return { results: db.prepare(sql).all(...(v as never[])) as never[] };
          return { meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
        };
        return { all: exec as never, run: exec as never };
      },
    }),
  };
  h.client = createD1Client(META, d1);
  h.onDo = true;
  clearSlugRedirectCache();
});

describe('recordSlugRedirect on a DO store', () => {
  it('rename: the old slug resolves to the new one in the place the reader looks, never touching Postgres', async () => {
    await recordSlugRedirect(removed, STORE, SlugEntityType.PRODUCT, 'old-name', 'new-name');
    expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'old-name')).toBe('new-name');
    expect(await resolveSlugRedirectCached(STORE, SlugEntityType.PRODUCT, 'old-name')).toBe(
      'new-name'
    );
  });

  it('collapses chains and honours the reuse guard (blog and category use the same writer)', async () => {
    await recordSlugRedirect(removed, STORE, SlugEntityType.BLOG, 'a', 'b');
    await recordSlugRedirect(removed, STORE, SlugEntityType.BLOG, 'b', 'c');
    expect(await resolveSlugRedirect(STORE, SlugEntityType.BLOG, 'a')).toBe('c');
    await recordSlugRedirect(removed, STORE, SlugEntityType.BLOG, 'c', 'a'); // a is live again
    expect(await resolveSlugRedirect(STORE, SlugEntityType.BLOG, 'a')).toBeNull();
    expect(await resolveSlugRedirect(STORE, SlugEntityType.BLOG, 'c')).toBe('a');
    await recordSlugRedirect(removed, STORE, SlugEntityType.CATEGORY, 'x', 'y');
    expect(await resolveSlugRedirect(STORE, SlugEntityType.CATEGORY, 'x')).toBe('y');
  });

  it('a Postgres store still writes through the handle the caller passes', async () => {
    h.onDo = false;
    const calls: string[] = [];
    const tx = {
      slugRedirect: {
        deleteMany: async () => calls.push('deleteMany'),
        updateMany: async () => calls.push('updateMany'),
        upsert: async () => calls.push('upsert'),
      },
    } as never;
    await recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'o', 'n');
    expect(calls).toEqual(['deleteMany', 'updateMany', 'upsert']);
  });
});
