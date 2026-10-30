import { applyWalletEntry } from './refund';
import { scrubReceiptsForOrders } from './instapay-receipts';
import { MoneyError, type SyncSql } from './sync-sql';

/**
 * A shopper's account erasure on the StoreDO (INFRA-CF-1 R6a, Ruling CF-R6A-3): the store-owned half of
 * `AuthService.eraseAccount`, ONE section. The `users` row, its tokens and passkeys are platform data and stay in Postgres /
 * the identity service; everything the store holds about the shopper is here.
 *
 * It follows the Postgres function table by table. WHERE Postgres anonymises, so does this (the legal-record rules), and where
 * it deletes, this deletes; `tests/integration/repo-factory-erase-shopper-contract.test.ts` compares the rows of both backends
 * and `tests/unit/erase-shopper-parity.test.ts` pins every table the erasure registry deletes or scrubs to one of: handled
 * here, kept like Postgres keeps it (with the reason), or not a shopper's data.
 *
 *  orders            kept for the tax record (Egypt MOF >= 5y): customer link, both address snapshots, customer notes, buyer
 *                    key and area key go; totals, lines, number stay
 *  reviews           kept (anonymous review is valid content), author link goes
 *  webhook payloads  `data.customer` removed from the shopper's orders' deliveries and from any with their e-mail
 *  instapay receipts personal fields scrubbed and marked so the screenshots are deleted (the ids come back for the R2 delete)
 *  wallet            the ledger is a FINANCIAL record: kept, free-text notes nulled, a remaining balance written off with an
 *                    `expire` entry (never deleted); loyalty points / transactions are deleted
 *  CRM row           scrubbed, not deleted (analytics survive), ONLY when exactly one row matches the e-mail and exactly one
 *                    the phone: an ambiguous match scrubs nothing and says so (another data subject's record is never destroyed)
 *  campaign mail     a recipient row SENT inside the send-cap window is anonymised (tombstone address, every link cleared), so
 *                    the store's 24h cap keeps counting it; every other row of the address is deleted. Erasure must never
 *                    hand a store its send cap back.
 *  consents          SMS deleted; WhatsApp deleted except an opt-out the number's real owner may still rely on (unlinked)
 *  everything else the shopper owns (addresses, carts, wishlists, push, B2B applications) deleted
 */
export const WALLET_FORFEIT_NOTE = 'Forfeited on account erasure';
export const ANONYMIZED_ADDRESS = '{"anonymized":true}';

export interface EraseShopperInput {
  storeId: string;
  userId: string;
  /** Platform role of the account: anything but `customer` is refused (an admin account is a business identity). */
  role: string;
  email: string | null;
  phone: string | null;
  /** SMS consent phone key of the profile phone (`smsConsentPhoneKey`), computed by the Worker. */
  smsPhoneKey: string | null;
  /** The buyer key of the profile phone, ONLY when that phone is proven to be this account's (WA-CONSENT-PROOF-1). */
  provenBuyerKey: string | null;
  actorId: string;
  /** Send-cap window in ms (`SEND_CAP_WINDOW_MS`). */
  capWindowMs: number;
  now?: number;
}

export interface EraseShopperResult {
  /** The shopper's own orders (for the Customer Intelligence erase scope). */
  orders: Array<{ id: string; buyerKey: string | null; createdAt: number }>;
  /** Receipt screenshots to delete from the private bucket after this commits. */
  receiptIds: string[];
  crmChecked: boolean;
  crmRowsScrubbed: number;
  crmAmbiguous: boolean;
  walletForfeited: number;
  walletNotesScrubbed: boolean;
}

const NOT_FOUND = (): never => {
  throw new MoneyError('BAD_ARGS', 'erase input', 400);
};

export function eraseShopper(db: SyncSql, a: EraseShopperInput): EraseShopperResult {
  if (!a.storeId || !a.userId) NOT_FOUND();
  if (a.role !== 'customer')
    throw new MoneyError('FORBIDDEN', 'Admin accounts cannot be erased via this endpoint', 403);
  const now = a.now ?? Date.now();
  const { storeId, userId } = a;
  const out: EraseShopperResult = {
    orders: [],
    receiptIds: [],
    crmChecked: false,
    crmRowsScrubbed: 0,
    crmAmbiguous: false,
    walletForfeited: 0,
    walletNotesScrubbed: false,
  };
  return db.transactionSync(() => {
    // 1. orders (read before they lose the link)
    out.orders = db
      .all('SELECT id, buyer_key, created_at FROM orders WHERE store_id = ? AND customer_id = ?', [
        storeId,
        userId,
      ])
      .map(r => ({
        id: r.id as string,
        buyerKey: (r.buyer_key as string | null) ?? null,
        createdAt: r.created_at as number,
      }));
    const orderIds = out.orders.map(o => o.id);

    // 2. webhook delivery log (Ruling WH-7): the shopper's contact data leaves the stored payloads
    const email = a.email?.trim().toLowerCase() || null;
    if (orderIds.length > 0 || email)
      db.run(
        `UPDATE webhook_deliveries SET payload = json_remove(payload, '$.data.customer')
          WHERE store_id = ? AND json_extract(payload, '$.data.customer') IS NOT NULL
            AND (json_extract(payload, '$.data.order.id') IN (SELECT value FROM json_each(?))
                 OR lower(json_extract(payload, '$.data.customer.email')) = ?)`,
        [storeId, JSON.stringify(orderIds), email]
      );

    // 3. InstaPay receipts of those orders
    if (orderIds.length > 0) {
      out.receiptIds = db
        .all(
          `SELECT id FROM instapay_order_receipts WHERE store_id = ? AND image_deleted_at IS NULL
              AND order_id IN (SELECT value FROM json_each(?))`,
          [storeId, JSON.stringify(orderIds)]
        )
        .map(r => r.id as string);
      scrubReceiptsForOrders(db, { orderIds, now });
    }

    // 3b. Customer Intelligence capture rows (append-only; the trigger lets buyer_key go to NULL only while the erasure flag is
    //     up, raised and lowered inside this section). The shopper's own order keys, and the proven current number's key.
    const buyerKeys = [
      ...new Set([
        ...out.orders.flatMap(o => (o.buyerKey ? [o.buyerKey] : [])),
        ...(a.provenBuyerKey ? [a.provenBuyerKey] : []),
      ]),
    ];
    if (buyerKeys.length > 0) {
      const flag = (v: 0 | 1) =>
        db.run(
          "INSERT INTO do_flags (name, value) VALUES ('erasure', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
          [v]
        );
      flag(1);
      db.run(
        'UPDATE commerce_outcomes SET buyer_key = NULL WHERE store_id = ? AND buyer_key IN (SELECT value FROM json_each(?))',
        [storeId, JSON.stringify(buyerKeys)]
      );
      flag(0);
    }

    // 4. orders keep money history, lose identity
    db.run(
      `UPDATE orders SET customer_id = NULL, shipping_address = ?, billing_address = ?, customer_notes = NULL,
              buyer_key = NULL, area_key = NULL WHERE store_id = ? AND customer_id = ?`,
      [ANONYMIZED_ADDRESS, ANONYMIZED_ADDRESS, storeId, userId]
    );

    // 5. reviews keep the body, lose the author
    db.run('UPDATE reviews SET customer_id = NULL WHERE store_id = ? AND customer_id = ?', [
      storeId,
      userId,
    ]);

    // 6. pure-PII rows
    db.run('DELETE FROM addresses WHERE user_id = ?', [userId]);
    db.run('DELETE FROM onesignal_subscriptions WHERE user_id = ?', [userId]);
    db.run('DELETE FROM abandoned_carts WHERE store_id = ? AND customer_id = ?', [storeId, userId]);
    db.run('DELETE FROM carts WHERE store_id = ? AND customer_id = ?', [storeId, userId]);
    db.run('DELETE FROM wishlists WHERE store_id = ? AND user_id = ?', [storeId, userId]);
    db.run('DELETE FROM push_subscriptions WHERE store_id = ? AND customer_id = ?', [
      storeId,
      userId,
    ]);
    db.run('DELETE FROM loyalty_transactions WHERE store_id = ? AND customer_id = ?', [
      storeId,
      userId,
    ]);
    db.run('DELETE FROM loyalty_points WHERE store_id = ? AND customer_id = ?', [storeId, userId]);
    db.run('DELETE FROM wholesale_applications WHERE store_id = ? AND user_id = ?', [
      storeId,
      userId,
    ]);
    // the CRM row's user link is what grants a group price: severed, so an erased account never prices as a wholesaler
    db.run(
      'UPDATE customers SET user_id = NULL, group_id = NULL WHERE store_id = ? AND user_id = ?',
      [storeId, userId]
    );

    // 7. wallet: financial record kept, notes nulled, remaining balance written off
    const notes = db.run(
      `UPDATE wallet_transactions SET note = NULL WHERE store_id = ? AND customer_id = ?
          AND note IS NOT NULL AND note != ?`,
      [storeId, userId, WALLET_FORFEIT_NOTE]
    ).changes;
    out.walletNotesScrubbed = notes > 0;
    const wallets = db.all(
      'SELECT id, balance FROM customer_wallets WHERE store_id = ? AND customer_id = ? AND balance > 0',
      [storeId, userId]
    );
    for (const w of wallets) {
      const latest = db.all(
        'SELECT id FROM wallet_transactions WHERE store_id = ? AND wallet_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [storeId, w.id]
      )[0];
      const r = applyWalletEntry(db, {
        storeId,
        customerId: userId,
        amount: -(w.balance as number),
        type: 'expire',
        idempotencyKey: `erasure-forfeit:${w.id}:${(latest?.id as string | undefined) ?? 'none'}`,
        note: WALLET_FORFEIT_NOTE,
        actorId: a.actorId,
        now,
      });
      if (!r.replayed) out.walletForfeited += w.balance as number;
    }

    // 8. merchant CRM copy: a single-row match on each identifier, or nothing
    if (a.email || a.phone) {
      out.crmChecked = true;
      const ids = new Set<string>();
      if (a.email) {
        const rows = db.all(
          'SELECT id FROM customers WHERE store_id = ? AND lower(email) = lower(?)',
          [storeId, a.email]
        );
        if (rows.length === 1) ids.add(rows[0].id as string);
        else if (rows.length > 1) out.crmAmbiguous = true;
      }
      if (a.phone) {
        const rows = db.all('SELECT id FROM customers WHERE store_id = ? AND phone = ?', [
          storeId,
          a.phone,
        ]);
        if (rows.length === 1) ids.add(rows[0].id as string);
        else if (rows.length > 1) out.crmAmbiguous = true;
      }
      for (const id of ids) {
        db.run('DELETE FROM customer_addresses WHERE customer_id = ?', [id]);
        db.run(
          `UPDATE customers SET email = ?, first_name = 'Erased', last_name = 'User', phone = NULL, notes = NULL,
                  preferred_locale = NULL, last_locale_choice = NULL WHERE id = ? AND store_id = ?`,
          [`erased-${id}@anonymized.local`, id, storeId]
        );
      }
      out.crmRowsScrubbed = ids.size;
    }

    // 9. newsletter + campaign mail
    if (a.email) {
      const norm = a.email.trim().toLowerCase();
      const since = now - a.capWindowMs;
      // sent inside the cap window: anonymised, never deleted, so the send cap keeps counting it
      for (const r of db.all(
        'SELECT id FROM campaign_recipients WHERE store_id = ? AND email = ? AND sent_at >= ?',
        [storeId, norm, since]
      ))
        db.run(
          `UPDATE campaign_recipients SET email = ?, subscriber_id = NULL, customer_id = NULL,
                  provider_message_id = NULL, error = NULL WHERE id = ? AND store_id = ?`,
          [`erased-${r.id}@anonymized.local`, r.id, storeId]
        );
      db.run('DELETE FROM campaign_recipients WHERE store_id = ? AND email = ?', [storeId, norm]);
      db.run('DELETE FROM newsletter_subscribers WHERE store_id = ? AND email = ?', [
        storeId,
        norm,
      ]);
    }

    // 10. SMS-marketing consent: the shopper's own rows, plus guest-checkout rows under the same e-mail or phone
    const keys: Array<[string, unknown[]]> = [
      ['user_id = ?', [userId]],
      ['customer_key = ?', [userId]],
    ];
    if (a.email) keys.push(['customer_key = ?', [a.email.trim().toLowerCase()]]);
    if (a.smsPhoneKey) keys.push(['phone_key = ?', [a.smsPhoneKey]]);
    db.run(
      `DELETE FROM sms_marketing_consents WHERE store_id = ? AND (${keys.map(k => k[0]).join(' OR ')})`,
      [storeId, ...keys.flatMap(k => k[1])]
    );

    // 11. WhatsApp marketing consent: rows this account proved, plus its proven current number
    const wa = db
      .all(
        `SELECT buyer_key, granted, revoked_source, user_id FROM store_whatsapp_consents
        WHERE store_id = ? AND (user_id = ? ${a.provenBuyerKey ? 'OR buyer_key = ?' : ''})`,
        a.provenBuyerKey ? [storeId, userId, a.provenBuyerKey] : [storeId, userId]
      )
      .filter(r => r.user_id === userId || r.user_id === null);
    for (const r of wa) {
      const keepOptOut =
        r.buyer_key !== a.provenBuyerKey && r.granted === 0 && r.revoked_source === 'whatsapp';
      if (keepOptOut)
        db.run(
          'UPDATE store_whatsapp_consents SET user_id = NULL WHERE store_id = ? AND buyer_key = ?',
          [storeId, r.buyer_key]
        );
      else
        db.run('DELETE FROM store_whatsapp_consents WHERE store_id = ? AND buyer_key = ?', [
          storeId,
          r.buyer_key,
        ]);
    }
    return out;
  });
}
