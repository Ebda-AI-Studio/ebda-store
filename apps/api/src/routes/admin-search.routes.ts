/**
 * Admin ⌘K palette record lookup (search program P2, Task 18):
 * GET /stores/:storeId/search  ->  { products, orders, customers }, 5 of each.
 *
 * The term travels in the `X-Search-Query` header (percent-encoded), NOT in the URL: it is often a
 * customer's phone or email and URLs are retained in Cloudflare Workers Logs (Ruling SEARCH-P2-9,
 * which extends SEARCH-T5-8). A GET with no term answers three empty lists (the empty state).
 *
 * Cost: one per-user rate limit (`adminSearchLimiter`; GETs skip the global limiter), small caps
 * (50 registered customers / 200 guest orders / 50 order-number ids: the route shows 5 of each), and
 * ONE customer lookup that the order search reuses.
 *
 * Auth: authenticate -> authorize(store_admin, super_admin, staff) -> requireStoreAccess, then each
 * kind is gated by the permission of its own page (products:read, orders:read; customers follow the
 * customer typeahead's `orders:read`), so a role sees exactly the records its pages show. A kind the
 * caller may not read comes back empty, the same as "no match".
 *
 * Every lookup is store-scoped (the store id is the route param `requireStoreAccess` authorised, and
 * the SECURITY DEFINERs take the store only from the tenant scope), and the term is never logged: it
 * can be a phone or an email.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '@ebda/database';
import { storeRepo } from '../lib/repo-factory';
import type { AdminSearchResponse } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { hasPermission, type Permission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { adminSearchLimiter } from '../middleware/security';
import { searchQueryFromHeader } from '../lib/search-term';
import { searchProductIds } from '../services/product-search.service';
import { matchingCustomers } from '../services/admin-search.service';
import { orderSearchWhere } from '../services/order.service';

const router = Router({ mergeParams: true });

const PER_KIND = 5;
// Search-as-you-type (Ruling SEARCH-LIVE-1): a product answers from ONE character (one Arabic letter is a
// word; short terms are word-start matches, index-backed, Ruling SEARCH-T14-3). Customers need two:
// a one-letter customer match would scan names and phones.
const MIN_QUERY = 1;
const MIN_CUSTOMER_QUERY = 2;
/** Orders also need a trigram-sized term: shorter ones take the unindexed relation filter. */
const MIN_ORDER_QUERY = 3;
const USER_CAP = 50;
const GUEST_ORDER_CAP = 200;
const ORDER_NUMBER_ID_CAP = 50;

/** A guest's palette key: the Customers-page key (lowercased email, else phone). */
function guestKey(addr: Record<string, unknown>): string {
  const email = typeof addr.email === 'string' ? addr.email.toLowerCase() : '';
  const phone = typeof addr.phone === 'string' ? addr.phone : '';
  return email || phone;
}

router.get(
  '/:storeId/search',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  adminSearchLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;
      const role = req.user!.role as Parameters<typeof hasPermission>[0];
      const can = (p: Permission) => hasPermission(role, p);
      res.vary('X-Search-Query');
      res.setHeader('Cache-Control', 'private, no-store');
      const q = searchQueryFromHeader(req) ?? '';
      const data: AdminSearchResponse = { products: [], orders: [], customers: [] };
      if (q.length < MIN_QUERY) {
        res.json({ success: true, data });
        return;
      }

      const canOrders = can('orders:read');
      const [productIds, matches] = await Promise.all([
        can('products:read')
          ? searchProductIds(storeId, q, { scope: 'admin', field: 'name', limit: PER_KIND })
          : Promise.resolve([] as string[]),
        canOrders && q.length >= MIN_CUSTOMER_QUERY
          ? matchingCustomers(storeId, q, { userCap: USER_CAP, guestCap: GUEST_ORDER_CAP })
          : Promise.resolve(null),
      ]);
      // Only the first USER_CAP / GUEST_ORDER_CAP matches feed the order search: a palette shows 5
      // orders, so a broader term must not fall back to the unindexed relation filter.
      const orderWhere =
        canOrders && matches && q.length >= MIN_ORDER_QUERY
          ? {
              storeId,
              deletedAt: null,
              OR: await orderSearchWhere(storeId, q, {
                matches: { ...matches, usersTruncated: false, guestsTruncated: false },
                numberIdLimit: ORDER_NUMBER_ID_CAP,
              }),
            }
          : null;
      // A store on its Durable Object reads the display rows from its own tables (Ruling CF-R6A-1): its registered
      // customers are the `customers` rows (what `orders.customer_id` points at), there is no `Order.customer` relation to
      // include, and the platform `prisma` has none of these rows.
      const repo = await storeRepo(storeId);
      const onDo = repo.backend === 'do';
      const db = repo.db as unknown as typeof prisma;
      const userIds = matches?.userIds ?? [];
      const guestOrderIds = matches?.guestOrderIds ?? [];

      const [products, orders, users, guestOrders] = await Promise.all([
        productIds.length
          ? db.product.findMany({
              where: { storeId, id: { in: productIds }, deletedAt: null },
              select: { id: true, name: true, nameAr: true, sku: true },
            })
          : [],
        orderWhere
          ? db.order.findMany({
              where: orderWhere,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: PER_KIND,
              select: {
                id: true,
                orderNumber: true,
                total: true,
                shippingAddress: true,
                ...(onDo ? { customerId: true } : {}),
                ...(onDo ? {} : { customer: { select: { firstName: true, lastName: true } } }),
              },
            })
          : [],
        userIds.length
          ? onDo
            ? (db as never as { customer: typeof prisma.customer }).customer.findMany({
                where: { storeId, id: { in: userIds.slice(0, USER_CAP) } },
                select: { id: true, firstName: true, lastName: true, phone: true },
                orderBy: { id: 'asc' },
                take: PER_KIND,
              })
            : prisma.user.findMany({
                where: { storeId, deletedAt: null, id: { in: userIds.slice(0, USER_CAP) } },
                select: { id: true, firstName: true, lastName: true, phone: true },
                take: PER_KIND,
              })
          : [],
        guestOrderIds.length
          ? db.order.findMany({
              where: {
                storeId,
                customerId: null,
                deletedAt: null,
                id: { in: guestOrderIds.slice(0, GUEST_ORDER_CAP) },
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { shippingAddress: true },
              take: GUEST_ORDER_CAP,
            })
          : [],
      ]);

      const byId = new Map(products.map(p => [p.id, p]));
      data.products = productIds.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
      // DO: the order's registered customer is attached by id after the read (the Postgres twin includes the relation).
      const doCustomers = new Map<string, { firstName: string | null; lastName: string | null }>();
      if (onDo) {
        const ids = [
          ...new Set(
            orders.flatMap(o =>
              (o as { customerId?: string | null }).customerId
                ? [(o as { customerId: string }).customerId]
                : []
            )
          ),
        ];
        if (ids.length)
          for (const c of await (
            db as never as { customer: typeof prisma.customer }
          ).customer.findMany({
            where: { storeId, id: { in: ids } },
            select: { id: true, firstName: true, lastName: true },
          }))
            doCustomers.set(c.id, c);
      }
      data.orders = orders.map(o => {
        const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
        const cust = onDo
          ? doCustomers.get((o as { customerId?: string | null }).customerId ?? '')
          : (o as { customer?: { firstName: string | null; lastName: string | null } | null })
              .customer;
        const name = [cust?.firstName ?? a.firstName, cust?.lastName ?? a.lastName]
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .join(' ');
        return { id: o.id, orderNumber: o.orderNumber, customerName: name, total: o.total };
      });
      const registered = users.map(u => ({
        key: u.id,
        name: [u.firstName, u.lastName].filter(Boolean).join(' '),
        phone: u.phone ?? '',
        isGuest: false,
      }));
      // Guests: one row per contact key (newest order first); a guest with no email or phone has no
      // customer page to open, so it is not listed.
      const seen = new Set<string>();
      const guests: AdminSearchResponse['customers'] = [];
      for (const g of guestOrders) {
        const a = (g.shippingAddress ?? {}) as Record<string, unknown>;
        const key = guestKey(a);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        guests.push({
          key,
          name: [a.firstName, a.lastName]
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .join(' '),
          phone: typeof a.phone === 'string' ? a.phone : '',
          isGuest: true,
        });
      }
      data.customers = [...registered, ...guests].slice(0, PER_KIND);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
