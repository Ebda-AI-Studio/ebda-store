/**
 * WhatsApp MARKETING consent (Ruling WA-CONSENT-1). Cart reminders are marketing (Meta classifies them
 * as marketing templates; PDPL needs prior consent for electronic marketing), so `cart.abandoned` is
 * emitted ONLY for a buyer with an active consent. Order, COD and shipping messages are transactional
 * and never read this. Consent is unticked by default, recorded with time, source and the label
 * language, revocable (the buyer, the merchant, or a STOP on WhatsApp), exported with the account and
 * erased with it. It is keyed by the suite buyer key, so it holds no raw phone.
 */
import { customerRow, customerRows } from '../../lib/customer-directory';
import { notifyModelWrite, prisma, runInTenantContext, type Prisma } from '@ebda/database';
import { storeDb, storeRepo, storeWriter } from '../../lib/repo-factory';
import { runInStoreTenantContext } from '../../lib/store-scoped-read';
import { readStoreDb } from '../jobs/store-db';
import { buyerKeyFor, toE164 } from '@ebda/shared';
import { suiteBuyerKeySecret } from './config';

export type ConsentSource = 'checkout' | 'cart' | 'admin' | 'whatsapp';

/** Revoke sources that are not a grant source (see the table's revoked_source check). */
export type RevokeSource = ConsentSource | 'erasure' | 'profile';

export interface ConsentInput {
  consent: boolean;
  /** The account making the write (absent for a STOP or an admin action on a bare number). Never binds. */
  userId?: string;
  /** Set ONLY on a PROVEN grant: the account becomes the row's owner (export/erasure scope). */
  bindUserId?: string;
  source: ConsentSource;
  locale?: 'en' | 'ar';
}

/** True when the store's consent rows live on its Durable Object (no Postgres there: NEON-ZERO, Ruling NZ-D23). */
async function onDo(storeId: string): Promise<boolean> {
  return (await storeRepo(storeId)).backend === 'do';
}

/**
 * An `updateMany` on a DO store's consent rows. The DO writer is not the Prisma client the database observer hangs off, so the
 * write is announced here exactly like `writeConsent` does: no path changes consent without Ebda Chat hearing of it (consent-state.ts).
 */
async function doConsentUpdateMany(
  storeId: string,
  args: Prisma.StoreWhatsAppConsentUpdateManyArgs
): Promise<{ count: number }> {
  const result = await (await storeWriter(storeId)).storeWhatsAppConsent.updateMany(args);
  notifyModelWrite('StoreWhatsAppConsent', 'updateMany', args, result);
  return result;
}

/**
 * Is `phone` the contact number on a DELIVERED order this customer placed? A pending or cancelled order
 * proves nothing (the number is typed free text); a delivered one means the courier reached it.
 */
export async function phoneOnOwnOrder(
  storeId: string,
  userId: string,
  phone: string,
  // The caller's transaction client when it is inside a tenant scope (erasure); the ambient client otherwise.
  client?: Pick<typeof prisma, 'order'>
): Promise<boolean> {
  const want = toE164(phone);
  if (!want) return false;
  // No caller client: the store's own backend (a DO store's orders are on its Durable Object; NEON-ZERO class sweep,
  // P1 2026-11-09: the GET/POST /public/cart/whatsapp-optin proof threw POSTGRES_REMOVED). Postgres: the scoped `prisma`.
  const db = client ?? (await storeDb(storeId));
  const orders = await db.order.findMany({
    where: { storeId, customerId: userId, status: 'delivered' },
    select: { shippingAddress: true },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  return orders.some(o => {
    const p = (o.shippingAddress as { phone?: unknown } | null)?.phone;
    return typeof p === 'string' && toE164(p) === want;
  });
}

/**
 * An account is being deleted or deactivated: withdraw consent for every row it owns and for its
 * current number when that number is proven, with source `erasure` (the observer announces each one).
 * Rows are kept (an opt-out record), only switched off.
 */
export async function revokeForAccount(
  storeId: string,
  userId: string,
  phone: string | null
): Promise<void> {
  // A DO store's consent rows are on its Durable Object: the proof, the read and each revoke go through the store's own
  // backend (class sweep 2026-11-09: this threw POSTGRES_REMOVED for a DO store, aborting the account erasure/deactivation).
  const doStore = await onDo(storeId);
  await runInStoreTenantContext(storeId, async () => {
    // The ownership proof reads `orders`: it MUST run inside the tenant scope (under strict RLS an
    // out-of-scope read returns nothing and the proof is silently false), same scope as the revoke.
    const proven = phone && (await phoneOnOwnOrder(storeId, userId, phone));
    const key = proven ? await buyerKeyFor(suiteBuyerKeySecret(), phone) : null;
    const where = { storeId, granted: true, OR: [{ userId }, ...(key ? [{ buyerKey: key }] : [])] };
    if (doStore) {
      const rows = await (
        await storeDb(storeId)
      ).storeWhatsAppConsent.findMany({
        where,
        select: { buyerKey: true },
      });
      for (const r of rows) {
        await doConsentUpdateMany(storeId, {
          where: { storeId, buyerKey: r.buyerKey },
          data: { granted: false, revokedAt: new Date(), revokedSource: 'erasure' },
        });
      }
      return;
    }
    const rows = await prisma.storeWhatsAppConsent.findMany({
      where,
      select: { buyerKey: true },
    });
    for (const r of rows) {
      await prisma.storeWhatsAppConsent.updateMany({
        where: { storeId, buyerKey: r.buyerKey },
        data: { granted: false, revokedAt: new Date(), revokedSource: 'erasure' },
      });
    }
  });
}

/**
 * The ONE consent upsert. Runs on the caller's current transaction (no scope of its own), so a caller
 * that needs a lock held across check + write can do both in one tenant transaction.
 * Every write is seen by the database observer (consent-state.ts), which tells Ebda Chat
 * (customer.consent_changed), so no path can change consent unannounced.
 */
async function writeConsent(storeId: string, buyerKey: string, input: ConsentInput): Promise<void> {
  const now = new Date();
  // Ownership (`userId`) is set ONLY by a PROVEN grant (`bindUserId`). A revoke, a STOP or an admin
  // write NEVER sets, clears or overwrites it (an unproven account must not be able to strip
  // another account's ownership and so make its erasure miss the row); only a proven grant by
  // another account rebinds the row. `undefined` = leave the column as it is.
  const owner: string | undefined = input.bindUserId;
  const args = {
    where: { storeId_buyerKey: { storeId, buyerKey } },
    create: {
      storeId,
      buyerKey,
      userId: input.bindUserId ?? null,
      ...(input.consent
        ? {
            granted: true,
            grantedAt: now,
            grantedSource: input.source,
            locale: input.locale ?? null,
          }
        : { granted: false, revokedAt: now, revokedSource: input.source }),
    },
    update: {
      ...(owner !== undefined ? { userId: owner } : {}),
      ...(input.consent
        ? {
            granted: true,
            grantedAt: now,
            grantedSource: input.source,
            locale: input.locale ?? null,
            revokedAt: null,
            revokedSource: null,
          }
        : { granted: false, revokedAt: now, revokedSource: input.source }),
    },
  } satisfies Parameters<typeof prisma.storeWhatsAppConsent.upsert>[0];
  if ((await storeRepo(storeId)).backend === 'do') {
    // A DO store's consent row lives on its Durable Object. The DO writer is not the Prisma client the database observer
    // hangs off, so the write is announced here exactly like a D1-served write (services/platform/router.ts): no path changes
    // consent without Ebda Chat hearing of it (consent-state.ts).
    const result = await (await storeWriter(storeId)).storeWhatsAppConsent.upsert(args);
    notifyModelWrite('StoreWhatsAppConsent', 'upsert', args, result);
    return;
  }
  await prisma.storeWhatsAppConsent.upsert(args);
}

/**
 * Serialises a GRANT against a PHONE CHANGE of the same account. Both take this transaction-scoped
 * lock first and hold it until they commit, so a grant that checked phone A either commits before the
 * phone change (which then revokes A) or runs after it and sees phone B. Must run inside a tenant
 * transaction. (An advisory lock rather than `SELECT ... FOR UPDATE`: same serialisation, and it does
 * not depend on the app role holding an UPDATE policy on `users`.)
 */
export async function lockAccountConsent(userId: string): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wa-consent-account:${userId}`}, 0))`;
}

/** Revoke the old number's consent on the CURRENT transaction (see `lockAccountConsent`). */
export async function revokeForPhoneChangeInTx(
  storeId: string,
  userId: string,
  oldPhone: string
): Promise<void> {
  const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), oldPhone);
  if (!buyerKey) return;
  // WA-CONSENT-PROOF-1: a profile phone is self-declared, so a customer who typed SOMEONE ELSE'S number
  // and later changes it must not switch that person's consent off. Same rule as `revokeForAccount`:
  // only rows this account owns, or every row of the number when it is PROVEN theirs.
  const proven = await phoneOnOwnOrder(storeId, userId, oldPhone);
  const args = {
    where: { storeId, buyerKey, granted: true, ...(proven ? {} : { userId }) },
    data: { granted: false, revokedAt: new Date(), revokedSource: 'profile' as const },
  };
  if (await onDo(storeId)) {
    await doConsentUpdateMany(storeId, args);
    return;
  }
  await prisma.storeWhatsAppConsent.updateMany(args);
}

/** The customer changed their profile phone: the OLD number's consent ends; the new one needs a fresh tick. */
export async function revokeForPhoneChange(
  storeId: string,
  userId: string,
  oldPhone: string
): Promise<void> {
  await runInStoreTenantContext(storeId, () => revokeForPhoneChangeInTx(storeId, userId, oldPhone));
}

export const WhatsAppConsentService = {
  /** Record or withdraw the consent for the buyer behind `phone`. Null when the phone is not a phone. */
  async record(
    storeId: string,
    phone: string,
    input: ConsentInput
  ): Promise<{ granted: boolean } | null> {
    const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), phone);
    if (!buyerKey) return null;
    return this.recordForKey(storeId, buyerKey, input);
  },

  async recordForKey(
    storeId: string,
    buyerKey: string,
    input: ConsentInput
  ): Promise<{ granted: boolean }> {
    await runInStoreTenantContext(storeId, () => writeConsent(storeId, buyerKey, input));
    return { granted: input.consent };
  },

  /**
   * The checkout box (Ruling WA-CONSENT-1, security review): the phone is NEVER taken from the request.
   * The caller is an authenticated customer, the cart must be THEIR session cart, and the number is the
   * one on THEIR account (the same number the cart reminder is sent to). A different session, a
   * guest, or a body-supplied phone can neither opt in nor revoke anybody.
   */
  async recordForCart(
    storeId: string,
    sessionId: string,
    userId: string,
    input: { consent: boolean; locale?: 'en' | 'ar' }
  ): Promise<
    | { status: 'recorded'; granted: boolean; cartId: string }
    | { status: 'no_cart' | 'no_phone' | 'phone_unproven' }
  > {
    // ONE tenant transaction: lock the account's consent, read the phone, check the proof, write. A
    // concurrent phone change (`updateProfile`) takes the same lock around its revoke + phone write, so
    // a grant can never land on a number that was just replaced.
    // A store on its Durable Object has no Postgres transaction or advisory lock (NEON-ZERO): the bare store scope, and the
    // DO serialises each write. Residual (Ruling NZ-WA-CONSENT-1 in the PR): a grant and a phone change of the same account on
    // a DO store are no longer serialised by the lock; the phone change still revokes the old number after it lands.
    const onDo = (await storeRepo(storeId)).backend === 'do';
    return runInStoreTenantContext(storeId, async () => {
      if (!onDo) await lockAccountConsent(userId);
      const cart = await (
        await storeDb(storeId)
      ).cart.findFirst({
        where: { storeId, sessionId, customerId: userId },
        select: { id: true },
      });
      // GRANTING is tied to this session's cart; WITHDRAWING needs no cart (any device, any time).
      if (!cart && input.consent) return { status: 'no_cart' as const };
      const doUser = await customerRow(storeId, userId);
      const user =
        doUser !== undefined
          ? doUser
          : await prisma.user.findFirst({
              where: { id: userId, storeId },
              select: { phone: true },
            });
      if (!user?.phone) return { status: 'no_phone' as const };
      // A profile phone is self-declared (WA-CONSENT-PROOF-1), so BOTH directions need it: GRANTING needs
      // proof the number is theirs (a delivered order of THIS customer), and so does WITHDRAWING, unless
      // the account already OWNS the row (it granted with proof earlier). Otherwise an attacker who typed
      // a victim's number into their profile could switch the victim's consent off.
      const proven = await phoneOnOwnOrder(storeId, userId, user.phone);
      const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), user.phone);
      if (!buyerKey) return { status: 'no_phone' as const };
      if (!proven) {
        if (input.consent) return { status: 'phone_unproven' as const };
        const row = await (
          await storeDb(storeId)
        ).storeWhatsAppConsent.findUnique({
          where: { storeId_buyerKey: { storeId, buyerKey } },
          select: { userId: true },
        });
        if (!row || row.userId !== userId) return { status: 'phone_unproven' as const };
      }
      await writeConsent(storeId, buyerKey, {
        consent: input.consent,
        source: 'checkout',
        locale: input.locale,
        userId,
        ...(input.consent ? { bindUserId: userId } : {}),
      });
      return {
        status: 'recorded' as const,
        granted: input.consent,
        cartId: cart?.id ?? 'none',
      };
    });
  },

  /** The signed-in customer's current consent for their account number (so the box shows the truth). */
  async stateForUser(
    storeId: string,
    userId: string
  ): Promise<{ granted: boolean; proven: boolean }> {
    const doUser = await customerRow(storeId, userId);
    const user =
      doUser !== undefined
        ? doUser
        : await prisma.user.findFirst({ where: { id: userId, storeId }, select: { phone: true } });
    // The profile phone is self-declared: report consent ONLY for a proven number, otherwise a user
    // could type someone else's number and learn whether that person opted in.
    if (!user?.phone || !(await phoneOnOwnOrder(storeId, userId, user.phone))) {
      return { granted: false, proven: false };
    }
    const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), user.phone);
    return { granted: buyerKey ? await this.hasConsent(storeId, buyerKey) : false, proven: true };
  },

  /** True only for an active, un-revoked consent. Unknown buyer = no consent. */
  async hasConsent(storeId: string, buyerKey: string): Promise<boolean> {
    const row = await readStoreDb(storeId, db =>
      db.storeWhatsAppConsent.findUnique({
        where: { storeId_buyerKey: { storeId, buyerKey } },
        select: { granted: true },
      })
    );
    return row?.granted === true;
  },

  /**
   * Erasure: delete EVERY row this account created (any earlier number, by `userId`) and the current
   * number's row. One delete per key so the consent observer can attribute and announce each one.
   * Runs on the caller's transaction client.
   */
  async eraseForAccount(
    tx: Pick<typeof prisma, 'storeWhatsAppConsent'>,
    storeId: string,
    userId: string,
    buyerKey?: string
  ): Promise<number> {
    // Scope: rows THIS account proved (userId set by a proven grant) plus the row of its CURRENT
    // PROVEN number (`buyerKey` must be passed only when proven). A STOP-sourced opt-out on an older
    // number is KEPT (owner cleared): an opt-out must survive for that number's real owner, and
    // losing it could re-enable messages.
    const found = await tx.storeWhatsAppConsent.findMany({
      where: { storeId, OR: [{ userId }, ...(buyerKey ? [{ buyerKey }] : [])] },
      select: { buyerKey: true, granted: true, revokedSource: true, userId: true },
    });
    // A row reached ONLY through the shared number but owned by ANOTHER account (two customers with
    // delivered orders on the same number) is that account's record: leave it.
    const rows = found.filter(
      r => r.userId === userId || r.userId === null || r.userId === undefined
    );
    for (const r of rows) {
      const keepOptOut =
        r.buyerKey !== buyerKey && r.granted === false && r.revokedSource === 'whatsapp';
      if (keepOptOut) {
        await tx.storeWhatsAppConsent.updateMany({
          where: { storeId, buyerKey: r.buyerKey },
          data: { userId: null },
        });
      } else {
        await tx.storeWhatsAppConsent.deleteMany({ where: { storeId, buyerKey: r.buyerKey } });
      }
    }
    return rows.length;
  },

  /**
   * Every consent row this ACCOUNT ever created (any earlier phone, by `userId`), plus the row of the
   * current number when it is proven theirs (`includeKey`). Hashes and timestamps only, never a phone.
   */
  async exportForAccount(storeId: string, userId: string, includeKey?: string) {
    const args = {
      where: { storeId, OR: [{ userId }, ...(includeKey ? [{ buyerKey: includeKey }] : [])] },
      select: {
        granted: true,
        grantedAt: true,
        grantedSource: true,
        locale: true,
        revokedAt: true,
        revokedSource: true,
      },
    };
    // A DO store's rows are on its Durable Object (class sweep 2026-11-09); Postgres keeps its tenant-scoped read.
    if (await onDo(storeId)) {
      return runInStoreTenantContext(storeId, async () =>
        (await storeDb(storeId)).storeWhatsAppConsent.findMany(args)
      );
    }
    return runInTenantContext(storeId, () => prisma.storeWhatsAppConsent.findMany(args));
  },
};

/**
 * `whatsapp.opt_out_changed` (envelope v1.1): the buyer sent STOP on WhatsApp. optedOut=true turns the
 * Store-side marketing consent OFF; optedOut=false NEVER turns it back on (that needs a fresh tick at
 * checkout). Monotonic by `version`: a version at or below the stored one is ignored.
 */
export async function applyOptOutChanged(
  storeId: string,
  buyerKey: string,
  optedOut: boolean,
  version: number
): Promise<'applied' | 'ignored'> {
  if (await onDo(storeId)) {
    return runInStoreTenantContext(storeId, () =>
      applyOptOutChangedOnDo(storeId, buyerKey, optedOut, version)
    );
  }
  return runInTenantContext(storeId, async () => {
    const now = new Date();
    // Atomic and monotonic: the version guard is IN the write, so two concurrent events can never
    // lower `optOutVersion` and a replayed older version changes nothing.
    if (!optedOut) {
      // optedOut=false never re-enables consent; record the version only.
      await prisma.storeWhatsAppConsent.updateMany({
        where: { storeId, buyerKey, optOutVersion: { lt: version } },
        data: { optOutVersion: version },
      });
      return 'ignored';
    }
    const { count } = await prisma.storeWhatsAppConsent.updateMany({
      where: { storeId, buyerKey, optOutVersion: { lt: version } },
      data: { granted: false, revokedAt: now, revokedSource: 'whatsapp', optOutVersion: version },
    });
    if (count > 0) return 'applied';
    const exists = await prisma.storeWhatsAppConsent.findUnique({
      where: { storeId_buyerKey: { storeId, buyerKey } },
      select: { optOutVersion: true },
    });
    if (exists) return 'ignored'; // already at this version or newer
    try {
      await prisma.storeWhatsAppConsent.create({
        data: {
          storeId,
          buyerKey,
          granted: false,
          revokedAt: now,
          revokedSource: 'whatsapp',
          optOutVersion: version,
        },
      });
      return 'applied';
    } catch (err) {
      // ONLY a unique-key collision means "a concurrent event created the row first": re-run the
      // version-guarded update so the opt-out lands on the row that now exists. Anything else is a real
      // failure and is RETHROWN so the queue redelivers (swallowing it would drop a buyer's STOP).
      if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
      const again = await prisma.storeWhatsAppConsent.updateMany({
        where: { storeId, buyerKey, optOutVersion: { lt: version } },
        data: { granted: false, revokedAt: now, revokedSource: 'whatsapp', optOutVersion: version },
      });
      return again.count > 0 ? 'applied' : 'ignored';
    }
  });
}

/**
 * `applyOptOutChanged` for a store on its Durable Object (class sweep 2026-11-09: the STOP consumer threw POSTGRES_REMOVED, so
 * a buyer's STOP never reached the Store and marketing kept going). Same contract and same guards: the version check is IN the
 * write, optedOut=false never re-enables, only a unique-key collision is retried, every write is announced.
 */
async function applyOptOutChangedOnDo(
  storeId: string,
  buyerKey: string,
  optedOut: boolean,
  version: number
): Promise<'applied' | 'ignored'> {
  const now = new Date();
  const guarded = { storeId, buyerKey, optOutVersion: { lt: version } };
  if (!optedOut) {
    await doConsentUpdateMany(storeId, { where: guarded, data: { optOutVersion: version } });
    return 'ignored';
  }
  const stop = {
    granted: false,
    revokedAt: now,
    revokedSource: 'whatsapp' as const,
    optOutVersion: version,
  };
  const { count } = await doConsentUpdateMany(storeId, { where: guarded, data: stop });
  if (count > 0) return 'applied';
  const exists = await (
    await storeDb(storeId)
  ).storeWhatsAppConsent.findUnique({
    where: { storeId_buyerKey: { storeId, buyerKey } },
    select: { optOutVersion: true },
  });
  if (exists) return 'ignored'; // already at this version or newer
  try {
    const args = { data: { storeId, buyerKey, ...stop } };
    const created = await (await storeWriter(storeId)).storeWhatsAppConsent.create(args);
    notifyModelWrite('StoreWhatsAppConsent', 'create', args, created);
    return 'applied';
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
    const again = await doConsentUpdateMany(storeId, { where: guarded, data: stop });
    return again.count > 0 ? 'applied' : 'ignored';
  }
}
