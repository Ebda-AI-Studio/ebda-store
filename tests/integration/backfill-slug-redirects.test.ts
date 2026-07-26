/**
 * Integration test for the one-time SKU-joined SlugRedirect backfill script
 * (scripts/backfill-slug-redirects.ts).
 *
 * Exercises the real pure candidate-computation + CSV parsing against real
 * data shapes, and the real `--apply` write path (recordSlugRedirect) against
 * the real DB — no mocked prisma.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { prisma, SlugEntityType, withTenantContext } from '@force/database';
import { recordSlugRedirect } from '../../apps/api/src/services/slug-redirect.service';
import { parseImportCsv, computeCandidates } from '../../scripts/backfill-slug-redirects';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/backfill-slug-redirects.ts');

const EMAIL = `backfill-slug-redirects-test-${Date.now()}@example.test`;
let STORE = '';
let userId = '';

const CSV = [
  'name,slug,sku',
  'Raw Pecan,raw-pecan-2636297,PEC116',
  'Raw Mix,raw-mix-nuts-2636301,MIX9',
  'No Sku Item,no-sku-item-handle,',
].join('\n');

describe('backfill-slug-redirects module import side effect', () => {
  it('does not run main() (no "Aborting" / missing-store output) merely by importing the module', async () => {
    // This is the real regression: the test file above imports
    // parseImportCsv/computeCandidates from the script module. Before the
    // `process.argv[1] === fileURLToPath(import.meta.url)` guard, main() ran
    // as a side effect of that import — no --store arg, so it printed the
    // "missing --store ... Aborting — nothing done." line, set
    // process.exitCode = 1, and disconnected the shared prisma singleton out
    // from under every other test in the suite.
    const { stdout, stderr } = await execFileAsync('npx', [
      'tsx',
      '-e',
      `import('${SCRIPT_PATH}').then(() => console.log('IMPORTED_CLEAN'))`,
    ]);
    expect(stdout).toContain('IMPORTED_CLEAN');
    expect(stdout).not.toMatch(/missing --store/);
    expect(stdout).not.toMatch(/Aborting — nothing done/);
    expect(stderr).not.toMatch(/missing --store/);
    expect(stderr).not.toMatch(/Aborting — nothing done/);
  });
});

describe('backfill-slug-redirects', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: 'hashed',
        firstName: 'Backfill',
        lastName: 'SlugRedirect',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Backfill Slug Redirect Test Store',
        slug: `backfill-slug-redirect-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    STORE = store.id;

    await prisma.bulkImportJob.create({
      data: {
        storeId: STORE,
        userId,
        status: 'completed',
        csvData: CSV,
        total: 3,
        processed: 3,
        created: 3,
      },
    });

    await prisma.product.create({
      data: {
        storeId: STORE,
        name: 'Raw Pecan',
        slug: 'raw-pecan',
        price: 1000,
        sku: 'PEC116',
      },
    });
    await prisma.product.create({
      data: {
        storeId: STORE,
        name: 'Raw Mix',
        slug: 'raw-mix-nuts',
        price: 1200,
        sku: 'MIX9',
      },
    });
  });

  afterAll(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
    await prisma.product.deleteMany({ where: { storeId: STORE } });
    await prisma.bulkImportJob.deleteMany({ where: { storeId: STORE } });
    await prisma.store.deleteMany({ where: { id: STORE } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
  });

  describe('parseImportCsv', () => {
    it('parses slug + sku columns and reports sku-less rows without a sku', () => {
      const { rows, unusable } = parseImportCsv(CSV);
      expect(unusable).toBe(false);
      expect(rows).toHaveLength(3);
      expect(rows.find(r => r.slug === 'raw-pecan-2636297')?.sku).toBe('PEC116');
      expect(rows.find(r => r.slug === 'raw-mix-nuts-2636301')?.sku).toBe('MIX9');
      expect(rows.find(r => r.slug === 'no-sku-item-handle')?.sku).toBeUndefined();
    });

    it('flags a CSV missing the slug or sku column as unusable', () => {
      const noSkuColumn = 'name,slug\nRaw Pecan,raw-pecan-2636297';
      expect(parseImportCsv(noSkuColumn).unusable).toBe(true);

      const noSlugColumn = 'name,sku\nRaw Pecan,PEC116';
      expect(parseImportCsv(noSlugColumn).unusable).toBe(true);
    });
  });

  describe('computeCandidates', () => {
    it('joins by sku and yields old -> current-live candidates', () => {
      const { rows } = parseImportCsv(CSV);
      const oldHandlesBySku = new Map<string, Set<string>>();
      let skuLessRows = 0;
      for (const row of rows) {
        if (!row.sku) {
          skuLessRows++;
          continue;
        }
        const set = oldHandlesBySku.get(row.sku) ?? new Set<string>();
        set.add(row.slug);
        oldHandlesBySku.set(row.sku, set);
      }

      expect(skuLessRows).toBe(1); // the no-sku row is counted, not backfilled

      const currentBySku = new Map([
        ['PEC116', 'raw-pecan'],
        ['MIX9', 'raw-mix-nuts'],
      ]);
      const liveSlugs = new Set(['raw-pecan', 'raw-mix-nuts']);

      const { candidates, conflicts } = computeCandidates({
        oldHandlesBySku,
        currentBySku,
        liveSlugs,
      });

      expect(conflicts).toHaveLength(0);
      expect(candidates).toContainEqual({
        sku: 'PEC116',
        from: 'raw-pecan-2636297',
        to: 'raw-pecan',
      });
      expect(candidates).toContainEqual({
        sku: 'MIX9',
        from: 'raw-mix-nuts-2636301',
        to: 'raw-mix-nuts',
      });
      expect(candidates).toHaveLength(2);
    });

    it('produces NO candidate when the import slug already equals the current slug', () => {
      const oldHandlesBySku = new Map([['PEC116', new Set(['raw-pecan'])]]);
      const currentBySku = new Map([['PEC116', 'raw-pecan']]);
      const liveSlugs = new Set(['raw-pecan']);

      const { candidates } = computeCandidates({ oldHandlesBySku, currentBySku, liveSlugs });
      expect(candidates).toHaveLength(0);
    });

    it('conflicts (never redirects) a sku with no live product', () => {
      const oldHandlesBySku = new Map([['DELETED-SKU', new Set(['old-handle'])]]);
      const currentBySku = new Map<string, string>();
      const liveSlugs = new Set<string>();

      const { candidates, conflicts } = computeCandidates({
        oldHandlesBySku,
        currentBySku,
        liveSlugs,
      });
      expect(candidates).toHaveLength(0);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toMatch(/no live product/);
    });

    it('conflicts (never redirects) a handle that is ALSO a currently-live slug', () => {
      const oldHandlesBySku = new Map([['SKU-A', new Set(['some-other-live-slug'])]]);
      const currentBySku = new Map([['SKU-A', 'sku-a-current']]);
      const liveSlugs = new Set(['sku-a-current', 'some-other-live-slug']);

      const { candidates, conflicts } = computeCandidates({
        oldHandlesBySku,
        currentBySku,
        liveSlugs,
      });
      expect(candidates).toHaveLength(0);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toMatch(/ALSO a live product slug/);
    });

    it('conflicts (never redirects) a historical handle claimed by two different skus, without dropping an unrelated candidate', () => {
      const oldHandlesBySku = new Map([
        ['SKU-A', new Set(['widget'])],
        ['SKU-B', new Set(['widget'])],
        ['SKU-C', new Set(['unrelated-handle'])],
      ]);
      const currentBySku = new Map([
        ['SKU-A', 'product-a'],
        ['SKU-B', 'product-b'],
        ['SKU-C', 'product-c'],
      ]);
      const liveSlugs = new Set(['product-a', 'product-b', 'product-c']);

      const { candidates, conflicts } = computeCandidates({
        oldHandlesBySku,
        currentBySku,
        liveSlugs,
      });

      // The colliding handle produces ZERO candidates for either sku.
      expect(candidates.filter(c => c.from === 'widget')).toHaveLength(0);

      // A single conflict entry names the ambiguity for both skus/targets.
      const ambiguity = conflicts.find(c => c.message.includes('widget'));
      expect(ambiguity).toBeDefined();
      expect(ambiguity!.message).toMatch(/ambiguous/);
      expect(ambiguity!.message).toMatch(/widget/);
      expect(ambiguity!.message).toMatch(/SKU-A.*product-a/);
      expect(ambiguity!.message).toMatch(/SKU-B.*product-b/);
      expect(ambiguity!.message).toMatch(/manual review/);

      // The unrelated, non-colliding handle is untouched by the collision
      // handling and still produces its own candidate.
      expect(candidates).toContainEqual({
        sku: 'SKU-C',
        from: 'unrelated-handle',
        to: 'product-c',
      });
    });
  });

  describe('apply (recordSlugRedirect write path)', () => {
    it('writes the sku-joined candidates and is idempotent on re-run', async () => {
      const candidates = [
        { sku: 'PEC116', from: 'raw-pecan-2636297', to: 'raw-pecan' },
        { sku: 'MIX9', from: 'raw-mix-nuts-2636301', to: 'raw-mix-nuts' },
      ];

      const apply = () =>
        withTenantContext(STORE, async tx => {
          for (const c of candidates) {
            await recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, c.from, c.to);
          }
        });

      await apply();

      const row = await prisma.slugRedirect.findFirst({
        where: {
          storeId: STORE,
          entityType: SlugEntityType.PRODUCT,
          fromSlug: 'raw-pecan-2636297',
        },
      });
      expect(row?.toSlug).toBe('raw-pecan');

      // Re-run must not throw a dup-key error and must not create a duplicate row.
      await expect(apply()).resolves.not.toThrow();

      const count = await prisma.slugRedirect.count({
        where: {
          storeId: STORE,
          entityType: SlugEntityType.PRODUCT,
          fromSlug: 'raw-pecan-2636297',
        },
      });
      expect(count).toBe(1);
    });
  });
});
