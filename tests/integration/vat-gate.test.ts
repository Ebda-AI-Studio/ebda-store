/**
 * Egypt VAT gate, phase 1 (rulings TAX-2, TAX-3, TAX-6) against a real Postgres,
 * with the code under test bound to a real `ebda_app` login (strict RLS, no
 * bypass). Fixtures and assertions read through the owner connection.
 *
 * Proves:
 *   1. a store with `taxEnabled = true` and an ACTIVE 14% rate is charged 0 VAT
 *      on a real admin order until its profile is VERIFIED; once approved the
 *      order charges 14% and freezes the seller TRN; once revoked it is 0 again
 *      and `taxEnabled` is switched off (TAX-3);
 *   2. the DATABASE refuses a non-super-admin's approval (trigger
 *      `tax_profile_review_guard`) even if an application bug let it through;
 *   3. the super-admin queue (definer `ebda_tax_profiles_for_review`) refuses a
 *      store_admin and lists the pending profile for a super_admin;
 *   4. tax profiles/documents are invisible across stores;
 *   5. Ebda's own VAT setting (`ebda.vat`) is writable by a super_admin only,
 *      and while it is OFF a subscription checkout is the plan price, no VAT.
 *
 * Mutation proofs (run by hand, recorded in the PR):
 *   - drop the `NOT public.ebda_is_super_admin()` check from the trigger → case 2 reddens;
 *   - remove `verified &&` from lib/order-tax.ts `collecting` → case 1 reddens.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  withRlsBypass,
  type AppPrismaClient,
} from '@ebda/database';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { resolveActiveTaxRate } from '@api/lib/order-tax';
import { OrderService } from '@api/services/order.service';
import { TaxProfileService } from '@api/services/tax-profile.service';
import { TaxService } from '@api/services/tax.service';
import { getPlatformVat, updatePlatformVat } from '@api/services/platform-vat.service';
import { taxProfilesForReview } from '@api/lib/definer';
import { StubBillingProvider } from '@api/services/billing';
import { startCheckout } from '@api/services/billing/subscription-billing.service';
import { recordManualPayment } from '@api/services/billing/account.service';

// The card checkout path is exercised explicitly; the product default is InstaPay-only.
process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

/** SQLSTATE of a Prisma adapter error (lib/prisma-errors.ts shape) or a raw pg error. */
function sqlState(err: unknown): string | undefined {
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
    cause?: { originalCode?: string };
    message?: string;
  };
  return (
    e?.meta?.driverAdapterError?.cause?.originalCode ??
    e?.cause?.originalCode ??
    (/42501|only a super_admin|not a super_admin/.test(String(e?.message)) ? '42501' : e?.code)
  );
}

describe.skipIf(!hasDb)('VAT gate against Postgres as ebda_app', () => {
  let owner: AppPrismaClient;
  const run = crypto.randomUUID().slice(0, 8);
  const created = { stores: [] as string[], users: [] as string[] };
  let superAdminId = '';

  async function mkUser(role: 'store_admin' | 'super_admin', tag: string) {
    const u = await owner.user.create({
      data: {
        email: `vat-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
        passwordHash: 'x',
        firstName: 'Vat',
        lastName: tag,
        role,
        emailVerified: true,
      },
    });
    created.users.push(u.id);
    return u.id;
  }

  async function mkStore(tag: string) {
    const userId = await mkUser('store_admin', tag);
    const slug = `vat-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}`;
    const store = await owner.store.create({
      data: { name: slug, slug, ownerId: userId, status: 'active', taxEnabled: true },
    });
    created.stores.push(store.id);
    await owner.taxRate.create({
      data: { storeId: store.id, name: 'VAT', rate: 14, isActive: true },
    });
    const product = await owner.product.create({
      data: {
        storeId: store.id,
        name: 'Tee',
        slug: `tee-${slug}`,
        price: 10000,
        inventory: 50,
        status: 'active',
      },
    });
    return { storeId: store.id, userId, productId: product.id };
  }

  /** A pending profile with one (fake-URL) document, as a merchant submit leaves it. */
  async function pendingProfile(storeId: string, trn = '123456789') {
    const p = await owner.storeTaxProfile.create({
      data: {
        storeId,
        status: 'pending',
        taxRegistrationNumber: trn,
        legalName: 'Acme Trading LLC',
        submittedAt: new Date(),
        attestedAt: new Date(),
      },
    });
    await owner.storeTaxDocument.create({
      data: {
        storeId,
        profileId: p.id,
        kind: 'tax_card',
        storageKey: `stores/${storeId}/tax-documents/x.pdf`,
        fileName: 'card.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
      },
    });
    return p.id;
  }

  const adminOrder = (s: { storeId: string; userId: string; productId: string }) =>
    asApp(() =>
      runInTenantContext(
        s.storeId,
        () =>
          OrderService.createAdminOrder(s.storeId, s.userId, {
            shippingAddress: {
              firstName: 'Mona',
              lastName: 'Adel',
              email: 'mona@example.com',
              address1: '1 Nile St',
              city: 'Cairo',
              country: 'EG',
            },
            items: [{ productId: s.productId, quantity: 1 }],
            paymentMethod: 'cod',
          }),
        s.userId
      )
    );

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    superAdminId = await mkUser('super_admin', 'root');
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.systemSetting.deleteMany({ where: { key: 'ebda.vat' } });
    await withRlsBypass(async tx => {
      await tx.storeSubscription.deleteMany({ where: { storeId: { in: created.stores } } });
    }).catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId: { in: created.stores } } });
    await owner.store.deleteMany({ where: { id: { in: created.stores } } });
    await owner.user.deleteMany({ where: { id: { in: created.users } } });
    await owner.$disconnect();
  });

  it('charges 0 VAT until VERIFIED, 14% (with the TRN frozen) once approved, 0 again after revoke', async () => {
    const s = await mkStore('flow');

    // taxEnabled = true + an active 14% rate, but no profile: 0.
    expect(
      (await asApp(() => runInTenantContext(s.storeId, () => resolveActiveTaxRate(s.storeId))))
        .ratePercent
    ).toBe(0);
    const before = await adminOrder(s);
    const o1 = await owner.order.findUniqueOrThrow({ where: { id: before.id } });
    expect(o1.tax).toBe(0);
    expect(o1.sellerTaxRegistrationNumber).toBeNull();

    // pending: still 0.
    await pendingProfile(s.storeId);
    expect(
      (await asApp(() => runInTenantContext(s.storeId, () => resolveActiveTaxRate(s.storeId))))
        .ratePercent
    ).toBe(0);

    // approved by a super_admin: 14%, TRN frozen on the order.
    const approved = await asApp(() =>
      TaxProfileService.review(s.storeId, { decision: 'approve' }, { userId: superAdminId })
    );
    expect(approved.status).toBe('verified');
    const after = await adminOrder(s);
    const o2 = await owner.order.findUniqueOrThrow({ where: { id: after.id } });
    expect(o2.subtotal).toBe(10000);
    expect(o2.tax).toBe(1400);
    expect(o2.sellerTaxRegistrationNumber).toBe('123456789');
    expect(o2.sellerTaxLegalName).toBe('Acme Trading LLC');
    expect(o2.taxRateBps).toBe(1400);

    // revoked: 0 again, the merchant's switch is off, the past order is untouched.
    await asApp(() =>
      TaxProfileService.review(
        s.storeId,
        { decision: 'revoke', reason: 'certificate expired' },
        { userId: superAdminId }
      )
    );
    expect(
      (await asApp(() => runInTenantContext(s.storeId, () => resolveActiveTaxRate(s.storeId))))
        .ratePercent
    ).toBe(0);
    expect((await owner.store.findUniqueOrThrow({ where: { id: s.storeId } })).taxEnabled).toBe(
      false
    );
    expect(
      (await owner.order.findUniqueOrThrow({ where: { id: after.id } })).sellerTaxRegistrationNumber
    ).toBe('123456789');

    // and the merchant cannot switch VAT back on while revoked.
    const err = await asApp(() =>
      runInTenantContext(
        s.storeId,
        () => TaxService.updateSettings(s.storeId, { taxEnabled: true }),
        s.userId
      )
    ).catch(e => e);
    expect(err.code).toBe('TAX_NOT_VERIFIED');

    // every transition was audit-logged.
    const actions = (
      await owner.auditLog.findMany({
        where: { storeId: s.storeId, resourceType: 'store_tax_profile' },
        select: { action: true },
      })
    ).map(a => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['tax_profile.approved', 'tax_profile.revoked'])
    );
  });

  it('the DATABASE refuses a store_admin setting status=verified (trigger), even bypassing the service', async () => {
    const s = await mkStore('trigger');
    await pendingProfile(s.storeId, '222333444');
    const err = await asApp(() =>
      runInTenantContext(
        s.storeId,
        async () => {
          const { prisma } = await import('@ebda/database');
          return prisma.storeTaxProfile.update({
            where: { storeId: s.storeId },
            data: { status: 'verified' },
          });
        },
        s.userId
      )
    ).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(sqlState(err)).toBe('42501');
    expect(
      (await owner.storeTaxProfile.findUniqueOrThrow({ where: { storeId: s.storeId } })).status
    ).toBe('pending');
  });

  it('the review queue is super_admin only, and lists the pending profile with its duplicate-TRN signal', async () => {
    const a = await mkStore('queue-a');
    const b = await mkStore('queue-b');
    const trn = String(100000000 + Math.floor(Math.random() * 899999999)).slice(0, 9);
    await pendingProfile(a.storeId, trn);
    await pendingProfile(b.storeId, trn);

    const denied = await asApp(() =>
      runInTenantContext(undefined, () => taxProfilesForReview('pending'), a.userId)
    ).catch(e => e);
    expect(sqlState(denied)).toBe('42501');

    const rows = await asApp(() =>
      runInTenantContext(undefined, () => taxProfilesForReview('pending'), superAdminId)
    );
    const row = rows.find(r => r.storeId === a.storeId);
    expect(row).toMatchObject({ status: 'pending', taxRegistrationNumber: trn, documentCount: 1 });
    expect(row!.duplicateTrnStores).toBe(1);
  });

  it('a store never sees another store’s tax profile or documents', async () => {
    const a = await mkStore('iso-a');
    const b = await mkStore('iso-b');
    await pendingProfile(b.storeId, '555666777');
    const seen = await asApp(() =>
      runInTenantContext(
        a.storeId,
        async () => {
          const { prisma } = await import('@ebda/database');
          // Layer 1 (code guard): a typed query naming ANOTHER store is refused
          // before it reaches SQL.
          const guardRefusals = await Promise.all(
            [
              () => prisma.storeTaxProfile.findMany({ where: { storeId: b.storeId } }),
              () => prisma.storeTaxDocument.findMany({ where: { storeId: b.storeId } }),
            ].map(q =>
              q().then(
                () => 'not-refused',
                (e: Error) => e.name
              )
            )
          );
          // Layer 2 (RLS): raw SQL is not guard-checked inside a scope, so it
          // proves the database itself hides the other store's rows.
          const profiles = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM store_tax_profiles WHERE store_id = ${b.storeId}`;
          const docs = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM store_tax_documents WHERE store_id = ${b.storeId}`;
          return { guardRefusals, profiles, docs };
        },
        a.userId
      )
    );
    expect(seen.guardRefusals).toEqual(['TenantScopeViolation', 'TenantScopeViolation']);
    expect(seen.profiles).toHaveLength(0);
    expect(seen.docs).toHaveLength(0);
    const view = await asApp(() =>
      runInTenantContext(a.storeId, () => TaxProfileService.get(a.storeId), a.userId)
    );
    expect(view.status).toBe('none');
  });

  it('Ebda VAT (ebda.vat): OFF by default; only a super_admin may write it', async () => {
    await owner.systemSetting.deleteMany({ where: { key: 'ebda.vat' } });
    expect((await asApp(() => getPlatformVat())).enabled).toBe(false);

    const storeAdmin = await mkUser('store_admin', 'not-root');
    const denied = await asApp(() =>
      updatePlatformVat(
        { enabled: false, rate: 14, mode: 'exclusive', trn: null, legalName: null },
        { userId: storeAdmin }
      )
    ).catch(e => e);
    expect(sqlState(denied)).toBe('42501');
    expect(await owner.systemSetting.count({ where: { key: 'ebda.vat' } })).toBe(0);

    const saved = await asApp(() =>
      updatePlatformVat(
        {
          enabled: false,
          rate: 14,
          mode: 'inclusive',
          trn: '987654321',
          legalName: 'Ebda AI Studio',
        },
        { userId: superAdminId }
      )
    );
    expect(saved.mode).toBe('inclusive');
    expect((await asApp(() => getPlatformVat())).trn).toBe('987654321');
    const audit = await owner.auditLog.count({
      where: { action: 'platform_vat.updated', userId: superAdminId },
    });
    expect(audit).toBeGreaterThan(0);
  });

  // Hosted card checkout needs card mode since Ruling EBDA-FUNNEL-17 (InstaPay-only default);
  // these tests exercise the card path explicitly (Ruling EBDA-BILLFU-4: this test was red on main).
  const withCardMode = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.BILLING_TRIAL_CARD_MODE;
    process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.BILLING_TRIAL_CARD_MODE;
      else process.env.BILLING_TRIAL_CARD_MODE = prev;
    }
  };

  it('while Ebda VAT is OFF a subscription checkout is the plan price alone (no VAT)', async () => {
    await owner.systemSetting.deleteMany({ where: { key: 'ebda.vat' } });
    expect((await getPlatformVat()).enabled).toBe(false);
    const s = await mkStore('billing');
    const stub = new StubBillingProvider();
    await withCardMode(() =>
      startCheckout({ storeId: s.storeId, planCode: 'growth', provider: stub })
    );
    const call = stub.checkoutCalls.at(-1) as Record<string, unknown>;
    // Growth = EGP 3,490/month (locked catalog): exactly the plan price.
    expect(call.amountMinor).toBe(349000);
    // No VAT/tax field anywhere in what the provider is asked to charge.
    const keys: string[] = [];
    JSON.stringify(call, (k, v) => (keys.push(k), v));
    expect(keys.filter(k => /vat|tax/i.test(k))).toEqual([]);
    const row = await withRlsBypass(tx =>
      tx.billingEvent.findFirst({ where: { storeId: s.storeId }, orderBy: { createdAt: 'desc' } })
    );
    expect(row?.amountMinor).toBe(349000);
    // Ruling EBDA-BILLFU-3: OFF records no VAT on the ledger row.
    expect(row?.vatMinor).toBe(0);
    expect(row?.vat).toBeNull();
  });

  // Ruling EBDA-BILLFU-3: Ebda VAT ON reaches the real charge path (provider + ledger).
  for (const [mode, total, vatMinor, net] of [
    ['exclusive', 397860, 48860, 349000],
    ['inclusive', 349000, 42860, 306140],
  ] as const) {
    it(`Ebda VAT ON (${mode}): the checkout charges ${total} and the ledger row records the VAT split + TRN`, async () => {
      await asApp(() =>
        updatePlatformVat(
          { enabled: true, rate: 14, mode, trn: '987654321', legalName: 'Ebda AI Studio' },
          { userId: superAdminId }
        )
      );
      try {
        const s = await mkStore(`billing-${mode}`);
        const stub = new StubBillingProvider();
        await withCardMode(() =>
          startCheckout({ storeId: s.storeId, planCode: 'growth', provider: stub })
        );
        const call = stub.checkoutCalls.at(-1) as Record<string, unknown>;
        expect(call.amountMinor).toBe(total);
        const row = await withRlsBypass(tx =>
          tx.billingEvent.findFirst({
            where: { storeId: s.storeId },
            orderBy: { createdAt: 'desc' },
          })
        );
        expect(row?.amountMinor).toBe(total);
        expect(row?.vatMinor).toBe(vatMinor);
        expect(row?.vat).toEqual({
          netMinor: net,
          vatMinor,
          rateBps: 1400,
          mode,
          trn: '987654321',
          legalName: 'Ebda AI Studio',
        });
      } finally {
        await owner.systemSetting.deleteMany({ where: { key: 'ebda.vat' } });
      }
    });
  }

  it('Ebda VAT ON: a recorded InstaPay payment carves the VAT out of the money received; OFF records none', async () => {
    // the amount received is the plan price for the VAT state: 349,000 with VAT off, 349,000 + 14% exclusive with it on
    const pay = (storeId: string, reference: string, amountMinor: number) =>
      recordManualPayment({
        storeId,
        planCode: 'growth',
        interval: 'monthly',
        amountMinor,
        method: 'instapay',
        reference,
        paidAt: new Date(),
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
        actorId: superAdminId,
      });
    const rowOf = (id: string) =>
      withRlsBypass(tx => tx.billingEvent.findUnique({ where: { id } }));

    const off = await mkStore('manual-off');
    await owner.systemSetting.deleteMany({ where: { key: 'ebda.vat' } });
    const r0 = await pay(off.storeId, `IPN-OFF-${run}`, 349000);
    expect((await rowOf(r0.billingEventId))?.vatMinor).toBe(0);

    await asApp(() =>
      updatePlatformVat(
        {
          enabled: true,
          rate: 14,
          mode: 'exclusive',
          trn: '987654321',
          legalName: 'Ebda AI Studio',
        },
        { userId: superAdminId }
      )
    );
    try {
      const on = await mkStore('manual-on');
      const r1 = await pay(on.storeId, `IPN-ON-${run}`, 397860);
      const row = await rowOf(r1.billingEventId);
      expect(row?.amountMinor).toBe(397860);
      expect(row?.vatMinor).toBe(48860);
      // Replaying the same reference is idempotent: one row, VAT unchanged.
      const again = await pay(on.storeId, `IPN-ON-${run}`, 397860);
      expect(again).toEqual({ duplicate: true, billingEventId: r1.billingEventId });
    } finally {
      await owner.systemSetting.deleteMany({ where: { key: 'ebda.vat' } });
    }
  });
});
