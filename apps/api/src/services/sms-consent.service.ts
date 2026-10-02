import crypto from 'crypto';
import { prisma, withRlsBypass } from '@force/database';
import { smsConsentPhoneKey } from '../lib/sms-consent';

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
    status: row.granted ? 'granted' : row.revokedAt ? 'revoked' : 'none',
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
    const res = await prisma.smsMarketingConsent.updateMany({
      where: { storeId, granted: true, OR: or },
      data: { granted: false, revokedAt: new Date(), revokedSource: source },
    });
    return res.count;
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
    return withRlsBypass(tx =>
      tx.smsMarketingConsent.findFirst({
        where: { storeId, phoneKey, granted: true },
        select: { id: true },
        orderBy: { grantedAt: 'desc' },
      })
    );
  }

  /** The consent row for a Customers-page key (admin views). */
  static async getForCustomerKey(storeId: string, customerKey: string): Promise<SmsConsentView> {
    const row = await prisma.smsMarketingConsent.findUnique({
      where: { storeId_customerKey: { storeId, customerKey } },
      select: VIEW_SELECT,
    });
    return toConsentView(row);
  }

  /** Consent status for many Customers-page keys at once (list view). */
  static async statusForKeys(
    storeId: string,
    keys: string[]
  ): Promise<Map<string, SmsConsentView['status']>> {
    const out = new Map<string, SmsConsentView['status']>();
    if (keys.length === 0) return out;
    const rows = await prisma.smsMarketingConsent.findMany({
      where: { storeId, customerKey: { in: keys } },
      select: { customerKey: true, granted: true, revokedAt: true },
    });
    for (const r of rows)
      out.set(r.customerKey, r.granted ? 'granted' : r.revokedAt ? 'revoked' : 'none');
    return out;
  }
}
