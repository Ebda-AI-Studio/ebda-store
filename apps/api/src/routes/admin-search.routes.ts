/**
 * Admin ⌘K palette record lookup (search program P2, Task 18):
 * GET /stores/:storeId/search?q=  ->  { products, orders, customers }, 5 of each.
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
import type { AdminSearchResponse } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { hasPermission, type Permission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { searchProductIds } from '../services/product-search.service';
import { matchingCustomers } from '../services/admin-search.service';
import { OrderService } from '../services/order.service';

const router = Router({ mergeParams: true });

const PER_KIND = 5;
const MIN_QUERY = 2;

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;
      const role = req.user!.role as Parameters<typeof hasPermission>[0];
      const can = (p: Permission) => hasPermission(role, p);
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const data: AdminSearchResponse = { products: [], orders: [], customers: [] };
      if (q.length < MIN_QUERY) {
        res.json({ success: true, data });
        return;
      }

      const [productIds, orderWhere, matches] = await Promise.all([
        can('products:read')
          ? searchProductIds(storeId, q, { scope: 'admin', field: 'name', limit: PER_KIND })
          : Promise.resolve([] as string[]),
        can('orders:read') ? OrderService.listWhere(storeId, { search: q }) : Promise.resolve(null),
        can('orders:read')
          ? matchingCustomers(storeId, q)
          : Promise.resolve({ userIds: [], guestOrderIds: [] as string[] }),
      ]);

      const [products, orders, users, guestOrders] = await Promise.all([
        productIds.length
          ? prisma.product.findMany({
              where: { storeId, id: { in: productIds }, deletedAt: null },
              select: { id: true, name: true, nameAr: true, sku: true },
            })
          : [],
        orderWhere
          ? prisma.order.findMany({
              where: orderWhere,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: PER_KIND,
              select: {
                id: true,
                orderNumber: true,
                total: true,
                shippingAddress: true,
                customer: { select: { firstName: true, lastName: true } },
              },
            })
          : [],
        matches.userIds.length
          ? prisma.user.findMany({
              where: { storeId, id: { in: matches.userIds.slice(0, 50) } },
              select: { id: true, firstName: true, lastName: true, phone: true },
              take: PER_KIND,
            })
          : [],
        matches.guestOrderIds.length
          ? prisma.order.findMany({
              where: { storeId, customerId: null, id: { in: matches.guestOrderIds.slice(0, 200) } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { shippingAddress: true },
              take: 200,
            })
          : [],
      ]);

      const byId = new Map(products.map(p => [p.id, p]));
      data.products = productIds.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
      data.orders = orders.map(o => {
        const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
        const name = [o.customer?.firstName ?? a.firstName, o.customer?.lastName ?? a.lastName]
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
