/**
 * Customer erasure vs the webhook delivery log (review M10, Ruling WH-7).
 *
 * A delivery stored for an endpoint that opted into `includeCustomer` holds the shopper's name, email
 * and phone in `payload.data.customer`. When that shopper is erased the stored copies lose that
 * object (order id / totals / items stay: they are the merchant's accounting record and carry no
 * identity). What was already DELIVERED to the merchant's own server cannot be recalled.
 *
 * Kept free of heavy imports so `auth.service` can use it without widening its dependency graph.
 */
import type { Prisma } from '@ebda/database';

export async function redactWebhookCustomerData(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  args: { storeId: string; orderIds: string[]; email: string | null }
): Promise<number> {
  const email = args.email?.trim().toLowerCase() || null;
  if (args.orderIds.length === 0 && !email) return 0;
  return tx.$executeRaw`
    UPDATE webhook_deliveries
       SET payload = jsonb_set(payload, '{data}', (payload -> 'data') - 'customer')
     WHERE store_id = ${args.storeId}
       AND payload #> '{data,customer}' IS NOT NULL
       AND (
         payload #>> '{data,order,id}' = ANY(${args.orderIds}::text[])
         OR lower(payload #>> '{data,customer,email}') = ${email}
       )`;
}
