import crypto from 'crypto';
import { prisma } from '@ebda/database';
import { smsConsentPhoneKey } from '../lib/sms-consent';
import { storeDb, storeRepo, storeWriter } from '../lib/repo-factory';

/**
 * Promotional-SMS consent, per customer per store (issue 206).
 *
 * Semantics (docs/RULINGS.md, SMS-1..SMS-4):
 *  - A row is keyed by `customerKeyOf` (user id, else the guest's lowercased
 *    email, else phone), the same key the Customers page uses.
 *  - Consent covers a PHONE. The gate sends a promotional SMS only when some
 *    row of this store for the recipient's phone key is `granted`.
 *  - Withdrawal is phone-wide: revoking clears every granted row of the store
 *    for that phone (and the shopper's own row), so "stop texting me" can
 *    never be undone by an older guest row for the same number.
 *  - An unticked checkout box is not a withdrawal — it records nothing.
 */

export type SmsConsentSource = 'checkout' | 'account' | 'unsubscribe';

export interface SmsConsentView {
  status: 'granted' | 'revoked' | 'none';
  phone: string | null;
  grantedAt: Date | null;
  grantedSource: SmsConsentSource | null;
  revokedAt: Date | null;
  revokedSource: SmsConsentSource | null;
}

const VIEW_SELECT = {
  id: true,
  phone: true,
  granted: true,
  grantedAt: true,
  grantedSource: true,
  revokedAt: true,
  revokedSource: true,
} as const;

type ConsentRow = {
  phone: string;
  granted: boolean;
  grantedAt: Date | null;
  grantedSource: SmsConsentSource | null;
  revokedAt: Date | null;
  revokedSource: SmsConsentSource | null;
};

function statusOf(row: { granted: boolean; revokedAt: Date | null }): SmsConsentView['status'] {
  return row.granted ? 'granted' : row.revokedAt ? 'revoked' : 'none';
}

export function toConsentView(row: ConsentRow | null | undefined): SmsConsentView {
  if (!row) {
    return {
      status: 'none',
      phone: null,
      grantedAt: null,
      grantedSource: null,
      revokedAt: null,
      revokedSource: null,
    };
  }
  return {
    status: statusOf(row),
    phone: row.phone,
    grantedAt: row.grantedAt,
    grantedSource: row.grantedSource,
    revokedAt: row.revokedAt,
    revokedSource: row.revokedSource,
  };
}

export class SmsConsentService {
  /**
   * Record an explicit opt-in. Idempotent and race-free: one
   * `INSERT … ON CONFLICT (store_id, customer_key) DO UPDATE`, so two
   * concurrent checkouts by the same customer cannot trip the unique index
   * (which would abort the request transaction). Returns false (and writes
   * nothing) when the phone is not a phone.
   */
  static async recordGrant(
    storeId: string,
    input: {
      customerKey: string;
      userId?: string | null;
      phone: string;
      source: 'checkout' | 'account';
    }
  ): Promise<boolean> {
    const phoneKey = smsConsentPhoneKey(input.phone);
    if (!phoneKey || !input.customerKey) return false;
    const phone = input.phone.trim().slice(0, 40);
    // A store on its Durable Object (NEON-ZERO, Ruling NZ-D23): the raw INSERT below threw POSTGRES_REMOVED, swallowed by the
    // checkout, so every DO store silently dropped the shopper's SMS opt-in (class sweep, P1 2026-11-09). One DO upsert on the
    // same unique key is the same idempotent, race-free write (the DO serialises its writes).
    if ((await storeRepo(storeId)).backend === 'do') {
      const now = new Date();
      const fields = {
        userId: input.userId ?? null,
        phone,
        phoneKey,
        granted: true,
        grantedAt: now,
        grantedSource: input.source,
      };
      await (
        await storeWriter(storeId)
      ).smsMarketingConsent.upsert({
        where: { storeId_customerKey: { storeId, customerKey: input.customerKey } },
        create: { id: crypto.randomUUID(), storeId, customerKey: input.customerKey, ...fields },
        update: fields,
      });
      return true;
    }
    await prisma.$executeRaw`
      INSERT INTO "sms_marketing_consents"
        ("id", "store_id", "customer_key", "user_id", "phone", "phone_key",
         "granted", "granted_at", "granted_source", "created_at", "updated_at")
      VALUES
        (${crypto.randomUUID()}, ${storeId}, ${input.customerKey}, ${input.userId ?? null},
         ${phone}, ${phoneKey}, true, NOW(), ${input.source}::"SmsConsentSource", NOW(), NOW())
      ON CONFLICT ("store_id", "customer_key") DO UPDATE SET
        "user_id"        = EXCLUDED."user_id",
        "phone"          = EXCLUDED."phone",
        "phone_key"      = EXCLUDED."phone_key",
        "granted"        = true,
        "granted_at"     = EXCLUDED."granted_at",
        "granted_source" = EXCLUDED."granted_source",
        "updated_at"     = NOW()
    `;
    return true;
  }

  /**
   * Withdraw consent for a phone in a store (phone-wide), plus the shopper's
   * own row when a user id is given (it may hold an older phone). Returns the
   * number of rows that flipped from granted to withdrawn.
   */
  static async revoke(
    storeId: string,
    target: { phone?: string | null; userId?: string | null },
    source: 'account' | 'unsubscribe'
  ): Promise<number> {
    const phoneKey = smsConsentPhoneKey(target.phone);
    const or: Array<Record<string, string>> = [];
    if (phoneKey) or.push({ phoneKey });
    if (target.userId) or.push({ customerKey: target.userId });
    if (or.length === 0) return 0;
    // A DO store writes its own consent rows (same filter, same phone-wide withdrawal); Postgres is unchanged.
    const writer =
      (await storeRepo(storeId)).backend === 'do' ? await storeWriter(storeId) : prisma;
    const res = await writer.smsMarketingConsent.updateMany({
      where: { storeId, granted: true, OR: or },
      data: { granted: false, revokedAt: new Date(), revokedSource: source },
    });
    return res.count;
  }

  /**
   * The consent row an unsubscribe link (v3 token, store id inside) names, read from THAT store's own backend. Null when the
   * store has no such row (a forged or re-paired store segment finds nothing: consent ids are random uuids).
   */
  static async lookupForUnsubscribe(
    storeId: string,
    consentId: string
  ): Promise<{
    id: string;
    storeId: string;
    phone: string;
    granted: boolean;
    store: { name: string; nameAr: string | null };
  } | null> {
    const db = await storeDb(storeId);
    const row = await db.smsMarketingConsent.findFirst({
      where: { id: consentId, storeId },
      select: { id: true, phone: true, granted: true },
    });
    if (!row) return null;
    const store = await db.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true },
    });
    return {
      id: row.id,
      storeId,
      phone: row.phone,
      granted: row.granted,
      store: { name: store?.name ?? '', nameAr: store?.nameAr ?? null },
    };
  }

  /**
   * THE promotional-SMS gate's read: the granted consent row for this phone
   * in this store, or null. Background callers (abandoned-cart cron,
   * back-in-stock fan-out) have no tenant GUC, so this is a trusted,
   * store-scoped read outside the ambient context, like the dispatcher's
   * event-config read.
   */
  static async findActiveForPhone(
    storeId: string,
    phone: string | null | undefined
  ): Promise<{ id: string } | null> {
    const phoneKey = smsConsentPhoneKey(phone);
    if (!phoneKey) return null;
    // Through the store's own backend: a DO store's consent rows are on its Durable Object (`withStore` there only opens a
    // lazy Postgres scope, POSTGRES_REMOVED); a Postgres store keeps the store-scoped read.
    return (await storeDb(storeId)).smsMarketingConsent.findFirst({
      where: { storeId, phoneKey, granted: true },
      select: { id: true },
      orderBy: { grantedAt: 'desc' },
    });
  }

  /**
   * What every consent SURFACE shows for one customer: the account page, the
   * admin profile, the merchant MCP profile (issue 2423).
   *
   * It reads the same set of rows the gate and the withdrawal act on: the
   * customer's own key row, plus every row of this store for the phone the
   * surface already knows. A granted row among them wins (that is what the
   * gate would send on); otherwise the most recently changed row decides
   * revoked/none. Reading the key row alone hid a consent the gate honours —
   * a guest who opted in at checkout and then registered resolves to a
   * DIFFERENT key (`customerKeyOf` is the user id once signed in), so the
   * account page showed no consent and no "Stop SMS offers" button while the
   * shopper kept receiving offers.
   */
  static async getForCustomerKey(
    storeId: string,
    customerKey: string,
    phone?: string | null
  ): Promise<SmsConsentView> {
    const rows = await (
      await storeDb(storeId)
    ).smsMarketingConsent.findMany({
      where: { storeId, OR: consentScope(customerKey, phone) },
      select: { ...VIEW_SELECT, updatedAt: true },
    });
    return toConsentView(pickConsentRow(rows));
  }

  /**
   * Consent status for many Customers-page rows at once (list view), by the
   * same rule as `getForCustomerKey`: each row's own key plus its phone.
   */
  static async statusForKeys(
    storeId: string,
    customers: Array<{ key: string; phone?: string | null }>
  ): Promise<Map<string, SmsConsentView['status']>> {
    const out = new Map<string, SmsConsentView['status']>();
    if (customers.length === 0) return out;
    const keys = customers.map(c => c.key);
    const phoneKeys = customers
      .map(c => smsConsentPhoneKey(c.phone))
      .filter((k): k is string => k !== null);
    const rows = await (
      await storeDb(storeId)
    ).smsMarketingConsent.findMany({
      where: {
        storeId,
        OR: [
          { customerKey: { in: keys } },
          ...(phoneKeys.length > 0 ? [{ phoneKey: { in: phoneKeys } }] : []),
        ],
      },
      select: {
        customerKey: true,
        phoneKey: true,
        granted: true,
        revokedAt: true,
        updatedAt: true,
      },
    });
    for (const c of customers) {
      const phoneKey = smsConsentPhoneKey(c.phone);
      const mine = rows.filter(
        r => r.customerKey === c.key || (phoneKey !== null && r.phoneKey === phoneKey)
      );
      const row = pickConsentRow(mine);
      if (row) out.set(c.key, statusOf(row));
    }
    return out;
  }
}

/** The rows a customer's consent is made of: their key row + their phone's rows. */
function consentScope(customerKey: string, phone: string | null | undefined) {
  const phoneKey = smsConsentPhoneKey(phone);
  const or: Array<{ customerKey: string } | { phoneKey: string }> = [{ customerKey }];
  if (phoneKey) or.push({ phoneKey });
  return or;
}

/**
 * The row that decides what a customer's consent IS: a granted row if there is
 * one (the newest grant), else the most recently changed row.
 */
export function pickConsentRow<
  T extends { granted: boolean; updatedAt: Date; grantedAt?: Date | null },
>(rows: T[]): T | null {
  const outranks = (a: T, b: T): boolean => {
    if (a.granted !== b.granted) return a.granted;
    if (a.granted) return (a.grantedAt?.getTime() ?? 0) > (b.grantedAt?.getTime() ?? 0);
    return a.updatedAt.getTime() > b.updatedAt.getTime();
  };
  return rows.reduce<T | null>((best, r) => (best === null || outranks(r, best) ? r : best), null);
}
