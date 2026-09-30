import { Prisma } from '@force/database';

/**
 * SQL twin of the Customers-list key — `customerKeyOf(order) ?? 'guest:' +
 * order.id` (`lib/customer-key.ts`) — for aggregate queries; the orders table
 * must be aliased `o`. Keep the two in lockstep; the integration test
 * `tests/integration/analytics-customer-key.test.ts` asserts they agree.
 */
export const CUSTOMER_KEY_SQL = Prisma.sql`COALESCE(
  NULLIF(o.customer_id, ''),
  NULLIF(LOWER(CASE WHEN jsonb_typeof(o.shipping_address -> 'email') = 'string'
                    THEN o.shipping_address ->> 'email' END), ''),
  NULLIF(CASE WHEN jsonb_typeof(o.shipping_address -> 'phone') = 'string'
              THEN o.shipping_address ->> 'phone' END, ''),
  'guest:' || o.id
)`;
