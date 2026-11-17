/**
 * Per-store AI request cap + interactive headroom (adversarial audit P2,
 * Task 12).
 *
 * assertAiQuota() counted aiUsage rows with NO storeId filter — the 450/day
 * global cap is shared across ALL tenants, so one merchant's bulk sweep over
 * a >450-product catalog drained it and denied AI (translate, palette,
 * categorize, answer-engine, accounting) to every other store until 00:00
 * UTC.
 *
 * Fix under test — the GLOBAL cap is KEPT (it protects the real Google
 * project ceiling); beneath it:
 *   - a per-store daily request cap (AI_STORE_DAILY_REQUEST_CAP) bounds any
 *     single tenant's slice;
 *   - bulk callers (`bulk: true`) stop below the global cap by an
 *     interactive reserve, so a background sweep can never zero out
 *     interactive AI for the whole platform.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { withRlsBypass } from '@ebda/database';
import { assertAiQuota, isAiQuotaCapError } from '@api/lib/ai-quota';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('assertAiQuota — per-store slice + interactive headroom', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeAId: string; // heavy consumer
  let storeBId: string; // idle store
  const envBackup: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of [
      'AI_DAILY_REQUEST_CAP',
      'AI_MONTHLY_REQUEST_CAP',
      'AI_STORE_DAILY_REQUEST_CAP',
      'AI_DAILY_INTERACTIVE_RESERVE',
    ]) {
      envBackup[k] = process.env[k];
    }

    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `aiq-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'AIQ',
          lastName: 'Owner',
        },
      });
      const mkStore = (n: string) =>
        tx.store.create({
          data: {
            name: `aiq-${n}`,
            slug: `aiq-${n}-${suffix}`,
            template: 'qamar',
            currency: 'EGP',
            ownerId: owner.id,
          },
        });
      storeAId = (await mkStore('a')).id;
      storeBId = (await mkStore('b')).id;

      // Store A burned 3 non-cached requests today.
      await tx.aiUsage.createMany({
        data: Array.from({ length: 3 }, () => ({
          storeId: storeAId,
          feature: 'translate',
          inputTokens: 10,
          outputTokens: 10,
          cachedHit: false,
        })),
      });
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await withRlsBypass(async tx => {
      await tx.aiUsage
        .deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } })
        .catch(() => {});
      await tx.store.deleteMany({ where: { id: { in: [storeAId, storeBId] } } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a store at its per-store cap is refused while an idle store still passes (no cross-tenant drain)', async () => {
    process.env.AI_STORE_DAILY_REQUEST_CAP = '3';
    process.env.AI_DAILY_REQUEST_CAP = '100000';
    process.env.AI_MONTHLY_REQUEST_CAP = '100000';

    await expect(assertAiQuota({ storeId: storeAId })).rejects.toMatchObject({
      statusCode: 429,
      code: 'AI_QUOTA_STORE_DAILY_EXCEEDED',
    });
    // The idle store is NOT starved by store A's consumption.
    // (assertAiQuota now returns the reserved-slot handle, #857 — release it as a real caller does.)
    const slotB = await assertAiQuota({ storeId: storeBId });
    await slotB.release();
  });

  it('the per-store cap error is a stop-the-sweep code', async () => {
    process.env.AI_STORE_DAILY_REQUEST_CAP = '3';
    process.env.AI_DAILY_REQUEST_CAP = '100000';
    process.env.AI_MONTHLY_REQUEST_CAP = '100000';
    const err = await assertAiQuota({ storeId: storeAId }).catch(e => e);
    expect(isAiQuotaCapError(err)).toBe(true);
  });

  it('the GLOBAL cap is kept — it still trips even for a store under its own slice', async () => {
    process.env.AI_STORE_DAILY_REQUEST_CAP = '1000';
    process.env.AI_DAILY_REQUEST_CAP = '3'; // 3 global rows exist (store A's)
    process.env.AI_MONTHLY_REQUEST_CAP = '100000';
    await expect(assertAiQuota({ storeId: storeBId })).rejects.toMatchObject({
      code: 'AI_QUOTA_DAILY_EXCEEDED',
    });
  });

  it('bulk callers stop below the global cap (interactive reserve) while interactive calls still pass', async () => {
    process.env.AI_STORE_DAILY_REQUEST_CAP = '1000';
    process.env.AI_DAILY_REQUEST_CAP = '4'; // 3 global rows used
    process.env.AI_DAILY_INTERACTIVE_RESERVE = '1'; // bulk ceiling = 3
    process.env.AI_MONTHLY_REQUEST_CAP = '100000';

    await expect(assertAiQuota({ storeId: storeBId, bulk: true })).rejects.toMatchObject({
      code: 'AI_QUOTA_DAILY_EXCEEDED',
    });
    const slotB = await assertAiQuota({ storeId: storeBId });
    await slotB.release();
  });
});
