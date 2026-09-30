/**
 * Right-to-erasure must reach the merchant-CRM copy of the shopper
 * (integration).
 *
 * `customers` + `customer_addresses` hold a SECOND, full copy of the same
 * shopper's PII (email, first/last name, phone, notes, street addresses),
 * keyed by phone/email rather than by a FK to `users`. Nothing in
 * `AuthService.eraseAccount`'s `userId`/`customerId` deletes reaches it, so
 * before this fix a merchant could click "Erase customer", get a
 * `customer.account.erased_by_merchant` audit row — and the shopper stayed
 * fully readable in the customers list, every customer-group query and the
 * WhatsApp bot.
 *
 * The scrub is store-scoped: a shopper who uses the same phone/email at two
 * stores must only ever lose THIS store's copy.
 *
 * Fixtures are created per-CALL (not per-file) because `vitest.config.ts`
 * sets `retry: 1` and a retry re-runs the body against the same database.
 */

import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { withRlsBypass } from '@force/database';
import { AuthService } from '../../apps/api/src/services/auth.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const PREFIX = 'crmerase-';

interface Seeded {
  userId: string;
  ownStoreCustomerId: string;
  otherStoreCustomerId: string;
  email: string;
  phone: string;
}

/**
 * One shopper identity (email + phone) present as:
 *   - a `users` row belonging to store A (the erasure subject),
 *   - a `customers` CRM row + address in store A (must be scrubbed),
 *   - a `customers` CRM row + address in store B (must be untouched).
 */
async function seed(): Promise<Seeded> {
  const uniq = crypto.randomUUID().slice(0, 12);
  const email = `${PREFIX}${uniq}@example.test`;
  const phone = `+9659${uniq.replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;

  return withRlsBypass(async tx => {
    const makeStore = async (tag: string) => {
      const owner = await tx.user.create({
        data: {
          email: `${PREFIX}owner-${tag}-${uniq}@example.test`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'CRM',
          lastName: 'Owner',
        },
      });
      return tx.store.create({
        data: {
          name: `crmerase-store-${tag}`,
          slug: `${PREFIX}store-${tag}-${uniq}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
        },
      });
    };

    // Same phone + email at both stores — `customers` is unique per
    // (storeId, phone) / (storeId, email), so this is a legitimate shopper
    // shopping at two tenants, not a fixture trick.
    const makeCrmRow = (storeId: string) =>
      tx.customer.create({
        data: {
          storeId,
          email,
          phone,
          firstName: 'Crm',
          lastName: 'Shopper',
          notes: 'prefers evening delivery',
          preferredLocale: 'ar',
          addresses: {
            create: {
              street: 'Block 4 Street 12 House 7',
              area: 'Salmiya',
              governorate: 'Hawalli',
              notes: 'ring twice',
            },
          },
        },
      });

    const storeA = await makeStore('a');
    const storeB = await makeStore('b');

    const user = await tx.user.create({
      data: {
        email,
        phone,
        passwordHash: 'not-a-real-hash',
        role: 'customer',
        storeId: storeA.id,
        firstName: 'Crm',
        lastName: 'Shopper',
      },
    });

    const crmA = await makeCrmRow(storeA.id);
    const crmB = await makeCrmRow(storeB.id);

    return {
      userId: user.id,
      ownStoreCustomerId: crmA.id,
      otherStoreCustomerId: crmB.id,
      email,
      phone,
    };
  });
}

function readCustomer(id: string) {
  return withRlsBypass(tx =>
    tx.customer.findUnique({
      where: { id },
      include: { addresses: true },
    })
  );
}

describe.skipIf(!hasDb)('eraseAccount scrubs the merchant-CRM copy of the shopper', () => {
  afterAll(async () => {
    // Store delete cascades to its `customers` (+ their addresses) and to
    // the erased shopper's `users` row, whose email no longer carries the
    // fixture prefix.
    await withRlsBypass(async tx => {
      await tx.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
      await tx.store.deleteMany({ where: { slug: { startsWith: PREFIX } } }).catch(() => {});
    });
  });

  it('anonymizes the `customers` row and hard-deletes its addresses', async () => {
    const s = await seed();

    const outcome = await AuthService.eraseAccount(s.userId);
    // #1880: the outcome reports the scrub (email and phone hit the same row).
    expect(outcome).toEqual({ crmChecked: true, crmRowsScrubbed: 1, crmAmbiguous: false });

    const crm = await readCustomer(s.ownStoreCustomerId);
    expect(crm).not.toBeNull();
    expect(crm!.email).toMatch(/^erased-.*@anonymized\.local$/);
    expect(crm!.email).not.toBe(s.email);
    expect(crm!.firstName).toBe('Erased');
    expect(crm!.lastName).toBe('User');
    expect(crm!.phone).toBeNull();
    expect(crm!.notes).toBeNull();
    expect(crm!.preferredLocale).toBeNull();
    expect(crm!.addresses).toHaveLength(0);
  });

  it('leaves ANOTHER store’s CRM row for the same phone/email untouched', async () => {
    const s = await seed();

    await AuthService.eraseAccount(s.userId);

    const other = await readCustomer(s.otherStoreCustomerId);
    expect(other!.email).toBe(s.email);
    expect(other!.phone).toBe(s.phone);
    expect(other!.firstName).toBe('Crm');
    expect(other!.notes).toBe('prefers evening delivery');
    expect(other!.addresses).toHaveLength(1);
  });

  it('stays idempotent: a second erase is a no-op, not a unique-constraint error', async () => {
    const s = await seed();

    await AuthService.eraseAccount(s.userId);
    // The second pass finds nothing left to scrub and says so.
    await expect(AuthService.eraseAccount(s.userId)).resolves.toMatchObject({
      crmRowsScrubbed: 0,
    });

    const crm = await readCustomer(s.ownStoreCustomerId);
    expect(crm!.email).toBe(`erased-${s.ownStoreCustomerId}@anonymized.local`);
  });
});
