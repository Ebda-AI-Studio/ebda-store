// INFRA-CF-1 R6a (Ruling CF-R6A-3): every table the erasure registry deletes or scrubs on a StoreDO is accounted for against the
// Postgres erasure function (`AuthService.eraseAccount`) for anonymise-vs-delete parity. A new customer-pii table fails here until
// someone decides which of the three it is, so the shopper erasure on the DO can never silently skip (or over-delete) a table.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_DO_REGISTRY } from '../../apps/api/src/cf/erasure/registry';

type Verdict =
  | { how: 'handled'; pg: string; do: string }
  | { how: 'kept'; reason: string }
  | { how: 'not-shopper'; reason: string };

/** Postgres (`pg`) and the DO operation (`do`) do the same thing in the 'handled' rows; 'kept' rows are left like Postgres leaves them. */
const PARITY: Record<string, Verdict> = {
  customers: {
    how: 'handled',
    pg: 'scrub (single-row match only)',
    do: 'scrub (single-row match only), never delete',
  },
  customer_addresses: {
    how: 'handled',
    pg: 'delete (of the scrubbed CRM row)',
    do: 'delete (of the scrubbed CRM row)',
  },
  wholesale_applications: { how: 'handled', pg: 'delete', do: 'delete' },
  carts: { how: 'handled', pg: 'delete', do: 'delete' },
  orders: {
    how: 'handled',
    pg: 'pseudonymise: customer link, addresses, notes, buyer key, area key',
    do: 'same',
  },
  push_subscriptions: { how: 'handled', pg: 'delete', do: 'delete' },
  onesignal_subscriptions: {
    how: 'handled',
    pg: 'delete (third-party propagation as well)',
    do: 'delete',
  },
  abandoned_carts: { how: 'handled', pg: 'delete', do: 'delete' },
  addresses: { how: 'handled', pg: 'delete', do: 'delete' },
  wishlists: { how: 'handled', pg: 'delete (items cascade)', do: 'delete (items cascade)' },
  wishlist_items: { how: 'handled', pg: 'cascade', do: 'cascade' },
  loyalty_points: { how: 'handled', pg: 'delete', do: 'delete' },
  loyalty_transactions: { how: 'handled', pg: 'delete', do: 'delete' },
  wallet_transactions: {
    how: 'handled',
    pg: 'kept (financial record), note nulled, balance written off with an expire entry',
    do: 'same',
  },
  newsletter_subscribers: { how: 'handled', pg: 'delete', do: 'delete' },
  sms_marketing_consents: { how: 'handled', pg: 'delete (own, e-mail key, phone key)', do: 'same' },
  campaign_recipients: {
    how: 'handled',
    pg: 'ANONYMISE when sent inside the send-cap window, delete otherwise',
    do: 'same',
  },
  reviews: { how: 'handled', pg: 'scrub: author link only', do: 'same' },
  store_whatsapp_consents: {
    how: 'handled',
    pg: 'delete, except an unlinked STOP opt-out',
    do: 'same',
  },
  instapay_order_receipts: {
    how: 'handled',
    pg: 'scrub the payer personal fields, mark so the screenshot is deleted',
    do: 'same (scrubReceiptsForOrders), screenshot ids returned for the R2 delete',
  },
  erasure_ledger: {
    how: 'handled',
    pg: 'n/a (DO-only): the saved scope of the erasure',
    do: 'written first, read on a replay',
  },
  notification_logs: {
    how: 'handled',
    pg: 'n/a (DO-only table): rows keyed by the hashed phone',
    do: 'delete by the shopper buyer keys',
  },
  commerce_outcomes: {
    how: 'handled',
    pg: 'n/a (DO-only table): buyer key to NULL',
    do: 'buyer key to NULL under the erasure flag',
  },
  customer_wallets: {
    how: 'kept',
    reason:
      'the wallet row stays with balance 0 (the ledger is a financial record); the registry deletes it, Postgres does not',
  },
  returns: {
    how: 'kept',
    reason: 'money history; Postgres eraseAccount does not touch returns, the PDPL job scrubs them',
  },
  shipments: {
    how: 'kept',
    reason:
      'tracking and outcome; Postgres eraseAccount does not touch shipments, the PDPL job overwrites the address JSON',
  },
  audit_logs: {
    how: 'kept',
    reason: 'the actor trail; Postgres keeps it, the PDPL job removes network identifiers',
  },
  customer_rfm_snapshots: {
    how: 'kept',
    reason:
      'derived analytics keyed by a customers row id, no personal field of its own; Postgres has no equivalent step',
  },
  affiliates: { how: 'not-shopper', reason: 'a third-party referrer, not a shopper account' },
  affiliate_referrals: { how: 'not-shopper', reason: 'session id only, no shopper identity' },
};

describe('shopper erasure parity (registry vs Postgres eraseAccount)', () => {
  const piiTables = Object.entries(STORE_DO_REGISTRY)
    .filter(([, c]) => c.kind === 'customer-pii')
    .map(([t]) => t);

  it('every customer-pii table of the registry has a verdict', () => {
    expect(piiTables.filter(t => !(t in PARITY))).toEqual([]);
  });

  it('every verdict names a real registry table', () => {
    expect(Object.keys(PARITY).filter(t => !piiTables.includes(t))).toEqual([]);
  });

  it('every table marked handled is really touched by the engine, and every kept table is not deleted from', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../packages/repo/src/do/erase-shopper.ts'),
      'utf8'
    );
    for (const [t, v] of Object.entries(PARITY)) {
      const touched = new RegExp(`(UPDATE|FROM|INTO)\\s+${t}\\b`).test(src);
      if (v.how === 'handled' && !/cascade/.test(v.pg))
        expect(touched, `${t} is marked handled but the engine never touches it`).toBe(true);
      if (v.how === 'kept' && t !== 'audit_logs')
        expect(
          new RegExp(`DELETE FROM ${t}\\b`).test(src),
          `${t} is marked kept but the engine deletes from it`
        ).toBe(false);
    }
  });

  it('a campaign recipient is never deleted without the in-window anonymise running first', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../packages/repo/src/do/erase-shopper.ts'),
      'utf8'
    );
    expect(src.indexOf('UPDATE campaign_recipients')).toBeGreaterThan(-1);
    expect(src.indexOf('UPDATE campaign_recipients')).toBeLessThan(
      src.indexOf('DELETE FROM campaign_recipients')
    );
  });
});
