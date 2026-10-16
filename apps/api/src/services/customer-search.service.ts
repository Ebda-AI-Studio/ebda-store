import { prisma } from '@ebda/database';
import { orderSearchIds } from './order.service';

/**
 * Typeahead behind GET /stores/:storeId/customers/search (admin "New order" form): REGISTERED
 * customers (users with at least one order at this store) AND GUEST customers (orders with
 * customerId = null whose shipping-address JSON contains the term), merged and capped at 10.
 * Extracted from the route so the planner/index test can call the real statements (Task 14).
 */
export async function searchOrderCustomers(storeId: string, q: string) {
  // --- Registered customers (User table, joined via orders) ---
  // The matching customers come from the store-scoped SECURITY DEFINER lookup (Ruling
  // SEARCH-T14-5): inline ILIKE on `users` / `orders` cannot use its trigram indexes as `ebda_app`.
  // They are still read through this store's orders, as before.
  const customerIds = await orderSearchIds(storeId, 'customers', q, 50);
  const registeredOrders =
    customerIds.length === 0
      ? []
      : await prisma.order.findMany({
          where: { storeId, customerId: { in: customerIds } },
          select: {
            customer: {
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            },
          },
          distinct: ['customerId'],
          take: 10,
        });

  // Shape: { id (UUID), isGuest: false, firstName, lastName, email, phone }
  const registered = registeredOrders
    .map(o => o.customer)
    .filter((c): c is NonNullable<(typeof registeredOrders)[number]['customer']> => c !== null)
    .map(c => ({
      id: c.id,
      isGuest: false as const,
      firstName: c.firstName ?? '',
      lastName: c.lastName ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
    }));

  // --- Guest customers (raw SQL: JSON ILIKE) ---
  // Prisma's JSON filter doesn't support partial-match (`contains`),
  // only exact `equals`. For guest typeahead we need ILIKE on
  // JSONB-extracted scalar fields, which is a `$queryRaw` job. The
  // result is deduped by lowercased email when present, falling
  // back to phone, then to order.id (each guest-order without
  // either becomes its own row — same as the customers list page).
  const guestIds = await orderSearchIds(storeId, 'guest', q);
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
