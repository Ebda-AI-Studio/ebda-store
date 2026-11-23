import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createDoClient } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// #1082: applyApprovedTaxChange writes with `where: { storeId, status: 'verified', reviewedAt: <the Date it read> }` so the
// reviewedAt check and the write are one atomic statement. That only works if the REAL store adapter compares a Date against how
// it is stored (integer epoch ms, timestamp_ms). If it did not, every VAT change approval would match 0 rows (409). This runs the
// exact shapes on the real StoreDO client (workerd): a reviewedAt WITH milliseconds matches; a re-review that moved it does not.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const clientFor = (storeId: string) => {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
  // the super-admin actor: the DO's tax review guard lets only a super_admin write a verified identity
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, { ...(m as object), actorRole: 'super_admin' } as never)
  ) as any;
};

const REVIEWED = new Date('2026-11-01T10:20:30.457Z'); // milliseconds on purpose

async function seed(store: string, reviewedAt: Date | null) {
  const c = clientFor(store);
  await c.storeTaxProfile.create({
    data: {
      storeId: store,
      status: 'verified',
      taxRegistrationNumber: '987654321',
      legalName: 'Old Co',
      reviewedAt,
      verifiedAt: reviewedAt,
    },
  });
  return c;
}

// exactly what applyApprovedTaxChange sends: `current` is the row it just read through the same client
async function apply(c: any, store: string, current: { reviewedAt: Date | null }) {
  return c.storeTaxProfile.updateMany({
    where: { storeId: store, status: 'verified', reviewedAt: current.reviewedAt },
    data: {
      taxRegistrationNumber: '123456789',
      legalName: 'New Co',
      reviewedAt: new Date(),
      reviewedBy: 'admin-1',
    },
  });
}

describe('applyApprovedTaxChange write on the real StoreDO', () => {
  it('a reviewedAt with milliseconds, read back and sent as the where, matches (count 1) and the TRN changes', async () => {
    const c = await seed('tax-apply-a', REVIEWED);
    const current = await c.storeTaxProfile.findUnique({
      where: { storeId: 'tax-apply-a' },
      select: { id: true, status: true, reviewedAt: true },
    });
    expect(current.reviewedAt.getTime()).toBe(REVIEWED.getTime()); // ms survive the round trip
    const out = await apply(c, 'tax-apply-a', current);
    expect(out.count).toBe(1);
    const after = await c.storeTaxProfile.findUnique({ where: { storeId: 'tax-apply-a' } });
    expect(after).toMatchObject({ taxRegistrationNumber: '123456789', legalName: 'New Co' });
  });

  it('a never-reviewed profile (reviewedAt null) matches a null where', async () => {
    const c = await seed('tax-apply-null', null);
    const current = await c.storeTaxProfile.findUnique({ where: { storeId: 'tax-apply-null' } });
    expect(current.reviewedAt).toBeNull();
    expect((await apply(c, 'tax-apply-null', current)).count).toBe(1);
  });

  it('a re-review between the read and the write moves reviewedAt: the write matches nothing (count 0) and changes nothing', async () => {
    const c = await seed('tax-apply-b', REVIEWED);
    const current = await c.storeTaxProfile.findUnique({ where: { storeId: 'tax-apply-b' } });
    // revoke + re-verify lands now: reviewedAt moves by ONE millisecond (the tightest case)
    await c.storeTaxProfile.updateMany({
      where: { storeId: 'tax-apply-b' },
      data: { reviewedAt: new Date(REVIEWED.getTime() + 1) },
    });
    expect((await apply(c, 'tax-apply-b', current)).count).toBe(0);
    const after = await c.storeTaxProfile.findUnique({ where: { storeId: 'tax-apply-b' } });
    expect(after.taxRegistrationNumber).toBe('987654321');
  });
});
