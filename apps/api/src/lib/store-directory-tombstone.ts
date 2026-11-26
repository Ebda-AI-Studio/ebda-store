/**
 * Remove a store from the D1 directory WITHOUT deleting its `stores` row (review of #1109, class check, Ruling NZ-D15B).
 * billing_events (Ebda's own invoices), instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions,
 * trust_requests and ai_usage reference `stores(id)` ON DELETE CASCADE, so a DELETE of the row silently destroys them. The row is
 * tombstoned instead (lib/store-tombstone.ts): identifying columns cleared, slug and domain released, soft-deleted so it never
 * resolves. Rollback of a just-created store (store-create-do.ts) is the one intentional hard delete left: no billing exists yet.
 */
import { tombstoneStatements } from './store-tombstone';

interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
}

export async function tombstoneStoreDirectoryRow(
  db: D1Like,
  storeId: string,
  now: number = Date.now()
): Promise<void> {
  for (const st of tombstoneStatements(storeId, now))
    await db
      .prepare(st.sql)
      .bind(...st.params)
      .run();
}
