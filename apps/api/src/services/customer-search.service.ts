import { prisma } from '@ebda/database';
import { customerRows } from '../lib/customer-directory';
import { matchingCustomers } from './admin-search.service';

/**
 * Typeahead behind GET /stores/:storeId/customers/search (admin "New order" form): REGISTERED
 * customers (users with an order at this store, or registered on it) AND GUEST customers (orders
 * with customerId = null whose shipping contact matches), merged and capped at 10.
 * The match is `matchingCustomers` (Arabic-normalised names, any phone form, email; one store-scoped
 * SECURITY DEFINER lookup, Ruling SEARCH-T14-5 / migration 20261027000200). Extracted from the
 * route so the planner/index tests can call the real statements.
 */
export async function searchOrderCustomers(storeId: string, q: string) {
  const matches = await matchingCustomers(storeId, q);

  // --- Registered customers: read back as this store's users (tenant guard: top-level storeId) ---
  const doRows = await customerRows(storeId, matches.userIds.slice(0, 50));
  const registeredRows = doRows
    ? doRows.filter(u => u.deletedAt === null).slice(0, 10)
    : matches.userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { storeId, deletedAt: null, id: { in: matches.userIds.slice(0, 50) } },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          take: 10,
        });

  // Shape: { id (UUID), isGuest: false, firstName, lastName, email, phone }
  const registered = registeredRows.map(c => ({
    id: c.id,
    isGuest: false as const,
    firstName: c.firstName ?? '',
    lastName: c.lastName ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
  }));

  // --- Guest customers (raw SQL: JSON fields) ---
  // The matching guest orders come from the definer above; Prisma cannot select/dedupe on JSONB
  // fields, so the rows are read back with a `$queryRaw`. The
  // result is deduped by lowercased email when present, falling
  // back to phone, then to order.id (each guest-order without
  // either becomes its own row — same as the customers list page).
  const guestIds = matches.guestOrderIds.slice(0, 200);
  const guestRows =
    guestIds.length === 0
      ? []
      : await prisma.$queryRaw<
          Array<{
            first_name: string | null;
            last_name: string | null;
            email: string | null;
            phone: string | null;
            order_id: string;
          }>
        >`
    SELECT DISTINCT ON (
      COALESCE(LOWER(shipping_address->>'email'), shipping_address->>'phone', id::text)
    )
      shipping_address->>'firstName' AS first_name,
      shipping_address->>'lastName'  AS last_name,
      shipping_address->>'email'     AS email,
      shipping_address->>'phone'     AS phone,
      id::text AS order_id
    FROM public.orders
    WHERE store_id = ${storeId}
      AND customer_id IS NULL
      AND deleted_at IS NULL
      AND id = ANY(${guestIds}::text[])
    LIMIT 10
  `;

  const guests = guestRows.map(g => ({
    // Synthetic id — frontend treats this as guest (no customerId
    // sent on order create), pre-fills form fields from these
    // values. Matches the customer-detail polymorphic key pattern.
    id: g.email ? `guest:${g.email.toLowerCase()}` : `guest:${g.order_id}`,
    isGuest: true as const,
    firstName: g.first_name ?? '',
    lastName: g.last_name ?? '',
    email: g.email ?? '',
    phone: g.phone ?? '',
  }));

  // Merge + cap at 10. Registered customers ranked first because
  // they're more useful for repeat-order attribution.
  const customers = [...registered, ...guests].slice(0, 10);
  return customers;
}
