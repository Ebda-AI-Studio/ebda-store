import { Prisma } from '@ebda/database';

/**
 * "Not already anonymized" filter for `orders.shipping_address` (jsonb, NOT NULL).
 *
 * A bare `NOT { path: ['anonymized'], equals: true }` compiles on Postgres to
 * `NOT (shipping_address #> '{anonymized}' = 'true')`. For a normal order the path is ABSENT, so
 * `#>` yields SQL NULL and `NOT (NULL = 'true')` is NULL, not true: the row is skipped and the
 * 5-year cron never matched a real order (measured on real Postgres 17, Ruling ANON-JSONPATH-1).
 * The `IS NULL` arm (`equals: Prisma.DbNull` on a path) selects the absent-path rows. A JSON
 * `null` value and `false` already pass the NOT arm. Semantics now match the Durable Object
 * branch (`packages/repo/src/do/job-ops-b.ts`: `COALESCE(json_extract(..), 0) != 1`).
 */
export const shippingAddressNotAnonymized: Prisma.OrderWhereInput = {
  OR: [
    { shippingAddress: { path: ['anonymized'], equals: Prisma.DbNull } },
    { NOT: { shippingAddress: { path: ['anonymized'], equals: true } } },
  ],
};
