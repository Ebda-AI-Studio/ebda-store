import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RfmSegment } from '@ebda/database';
import { readInStoreContext } from '../../lib/store-scoped-read';
import type { McpStore } from '../resolve-store';
import { assertScope, MERCHANT_SCOPES } from '../merchant-auth';
import { ok } from './tool-result';
import { CouponService } from '../../services/coupon.service';
import { ReviewService } from '../../services/review.service';
import {
  aggregateCustomers,
  aggregateCustomersMatching,
  getCustomerProfile,
  RFM_SEGMENT_VALUES,
  segmentsForCustomers,
  filterCustomersBySegment,
  type AggregatedCustomer,
} from '../../services/customer-aggregate.service';
import {
  FUNNEL_WINDOWS,
  listFunnelSnapshots,
  summarizeFunnel,
} from '../../services/accounting/funnel-report.service';
import { rfmKeyFor } from '../../lib/customer-key';
import { maskEmail, maskPhone } from '../../lib/pii-mask';
import { AppError } from '../../middleware/error-handler';

/**
 * Merchant-admin MCP, phase 1 continued: READ tools for customers, coupons,
 * the funnel and reviews (accounting/MCP audit 2026-09-30 §7).
 *
 * Same contract as `admin-read.tools.ts` — read that header first:
 *  - every handler calls `assertScope(merchant:read)` before touching data;
 *  - every read runs inside `readInStoreContext(store.id)`, and the store id
 *    is the one the router resolved from the slug AND verified the key
 *    against — no tool accepts a storeId argument, so there is nothing a
 *    caller can point at another tenant;
 *  - every handler is a façade over the service the dashboard calls.
 *
 * ## Contact details are masked, always
 *
 * Tool output lands in a third-party LLM's context window and its transcript.
 * A customer's email and phone therefore leave as `a***@gmail.com` /
 * `+201 ****1234`, and no street-level address is returned. There is no
 * unmask flag: the merchant has the full record on the dashboard, and an
 * agent does not need a shopper's door to reason about the business.
 *
 * ## A guest's identifier is not their email
 *
 * On the Customers page a guest row's id IS its email or phone — returning
 * that as the id would defeat the masking above. Tools use `customerRef`
 * instead: the user id for a registered customer, and for a guest the SAME
 * `GUEST:<sha256>` key the RFM snapshots are stored under
 * (`lib/customer-key.ts`), so an agent can correlate a customer with their
 * segment without ever seeing the contact.
 */

/** The SDK's handler `extra`; only the verified auth is read here. */
type ToolExtra = { authInfo?: unknown };

const CUSTOMERS_MAX_LIMIT = 100;
const REVIEWS_MAX_LIMIT = 100;
const COUPONS_MAX_LIMIT = 100;

/** Opaque, PII-free reference for a Customers-page row. */
export function customerRefOf(row: { id: string; isGuest: boolean }): string {
  // `guest:<orderId>` rows (a guest checkout with no contact at all) carry no
  // PII in their id; hashing them would only make them unresolvable.
  if (row.isGuest && row.id.startsWith('guest:')) return row.id;
  return rfmKeyFor(row.id, row.isGuest);
}

function maskedCustomerSummary(
  c: AggregatedCustomer,
  segment: RfmSegment | null,
  currency: string
) {
  return {
    customerRef: customerRefOf(c),
    isGuest: c.isGuest,
    name: `${c.firstName} ${c.lastName}`.trim() || null,
    email: maskEmail(c.email),
    phone: maskPhone(c.phone),
    // Locality only — enough to reason about delivery regions.
    area: c.area || null,
    city: c.city || null,
    country: c.country || null,
    orderCount: c.totalOrders,
    totalSpent: c.totalSpent,
    avgOrderValue: c.avgOrderValue,
    currency,
    firstOrderDate: c.firstOrderDate,
    lastOrderDate: c.lastOrderDate,
    lastOrderNumber: c.lastOrderNumber || null,
    segment,
  };
}

/** Coupon lifecycle as a merchant reads it, from the row + the clock. */
export function couponState(
  c: {
    isActive: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
    usageLimit: number | null;
    usageCount: number;
  },
  now = new Date()
): 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'active' {
  if (!c.isActive) return 'inactive';
  if (c.startsAt && c.startsAt > now) return 'scheduled';
  if (c.expiresAt && c.expiresAt < now) return 'expired';
  if (c.usageLimit !== null && c.usageCount >= c.usageLimit) return 'exhausted';
  return 'active';
}

const segmentInput = z.enum([...RFM_SEGMENT_VALUES, 'guest'] as [string, ...string[]]);

export function registerAdminCustomerMarketingReadTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'admin_list_coupons',
    {
      description:
        "List this store's discount coupons: code, type (percentage or fixed), value, " +
        'usage against its limit, active dates, and a derived state ' +
        '(active / scheduled / expired / exhausted / inactive). A fixed value and every ' +
        'amount are in piastres (1 EGP = 100 piastres); a percentage value is 0-100.',
      inputSchema: {
        search: z.string().trim().min(1).max(100).optional().describe('match code or name'),
        isActive: z.boolean().optional(),
        page: z.number().int().min(1).max(10_000).optional(),
        limit: z.number().int().min(1).max(COUPONS_MAX_LIMIT).optional(),
      },
    },
    async (
      args: { search?: string; isActive?: boolean; page?: number; limit?: number },
      extra: ToolExtra
    ) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_list_coupons');
      const result = await readInStoreContext(store.id, () =>
        CouponService.list(store.id, {
          search: args.search,
          isActive: args.isActive,
          page: args.page ?? 1,
          limit: args.limit ?? 25,
        })
      );
      return ok({
        currency: store.currency,
        coupons: result.coupons.map(c => ({
          id: c.id,
          code: c.code,
          name: c.name,
          nameAr: c.nameAr ?? undefined,
          type: c.type,
          value: c.value,
          minOrderAmount: c.minOrderAmount,
          maxDiscount: c.maxDiscount,
          usageCount: c.usageCount,
          usageLimit: c.usageLimit,
          usageLimitPerUser: c.usageLimitPerUser,
          firstOrderOnly: c.firstOrderOnly,
          isActive: c.isActive,
          startsAt: c.startsAt,
          expiresAt: c.expiresAt,
          state: couponState(c),
          createdAt: c.createdAt,
        })),
        pagination: result.meta,
      });
    }
  );

  server.registerTool(
    'admin_list_customers',
    {
      description:
        "List this store's customers exactly as the admin Customers page groups them — " +
        'registered shoppers AND guest checkouts (grouped by email, else phone) — with ' +
        'order count, total spent (piastres), last order and RFM segment. Sorted by total ' +
        'spent, highest first. Email and phone are MASKED; use `customerRef` with ' +
        'admin_get_customer for one customer. `segment` filters to an RFM segment or ' +
        "'guest'.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .optional()
          .describe('match name, email or phone (results stay masked)'),
        segment: segmentInput.optional(),
        page: z.number().int().min(1).max(10_000).optional(),
        limit: z.number().int().min(1).max(CUSTOMERS_MAX_LIMIT).optional(),
      },
    },
    async (
      args: { search?: string; segment?: string; page?: number; limit?: number },
      extra: ToolExtra
    ) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_list_customers');
      const page = args.page ?? 1;
      const limit = args.limit ?? 25;

      return readInStoreContext(store.id, async () => {
        const { customers: all, truncated, summary } = await aggregateCustomers(store.id);
        // A search is resolved in SQL (Arabic-normalised names, any phone form, email), the same
        // match as the Customers page, so it also finds customers beyond the aggregate's order-scan
        // window. The KPI strip and `truncated` keep describing the whole store.
        const customers = args.search
          ? (await aggregateCustomersMatching(store.id, args.search)).customers
          : all;

        // Segment filter reads only that segment's members; per-row segments
        // only for the returned page (issue 2243).
        const bySegment =
          args.segment === 'guest'
            ? customers.filter(c => c.isGuest)
            : args.segment
              ? await filterCustomersBySegment(store.id, customers, args.segment as RfmSegment)
              : customers;
        const filtered = bySegment;

        const start = (page - 1) * limit;
        const pageRows = filtered.slice(start, start + limit);
        const segmentOf = await segmentsForCustomers(store.id, pageRows);
        return ok({
          customers: pageRows.map(c =>
            maskedCustomerSummary(c, segmentOf.get(c.id) ?? null, store.currency)
          ),
          pagination: {
            page,
            limit,
            total: filtered.length,
            totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
          },
          // Store-wide, unaffected by search/segment/page — the Customers-page KPI strip.
          summary,
          truncated,
        });
      });
    }
  );

  server.registerTool(
    'admin_get_customer',
    {
      description:
        'One customer by `customerRef` (from admin_list_customers): totals, payment ' +
        'breakdown, RFM segment, and their order history (up to 100, newest first). ' +
        'Contact details are MASKED and no street address is returned. Throws if the ' +
        'reference does not belong to this store.',
      inputSchema: { customerRef: z.string().trim().min(1).max(200) },
    },
    async ({ customerRef }: { customerRef: string }, extra: ToolExtra) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_get_customer');

      return readInStoreContext(store.id, async () => {
        const { customers } = await aggregateCustomers(store.id);
        // Resolve the opaque ref to a row of THIS store's aggregation. A ref
        // from another store — or an invented one — matches nothing here and
        // is refused with the same 404 as an unknown id.
        const row = customers.find(c => customerRefOf(c) === customerRef);
        if (!row) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

        const segmentOf = await segmentsForCustomers(store.id, [row]);
        const segment = segmentOf.get(row.id) ?? null;

        // A contact-less guest row has no identity to resolve orders by; its
        // single order is readable through admin_get_order.
        if (row.id.startsWith('guest:')) {
          return ok({
            ...maskedCustomerSummary(row, segment, store.currency),
            orders: [],
            ordersNote:
              'Guest checkout with no email or phone; see admin_get_order for order ' +
              `${row.lastOrderNumber || 'details'}.`,
          });
        }

        const { customer, orders, truncated } = await getCustomerProfile(store.id, row.id);
        return ok({
          customerRef,
          isGuest: customer.isGuest,
          name: `${customer.firstName} ${customer.lastName}`.trim() || null,
          email: maskEmail(customer.email),
          phone: maskPhone(customer.phone),
          area: customer.area || null,
          city: customer.city || null,
          country: customer.country || null,
          accountCreatedAt: customer.accountCreatedAt,
          firstOrderDate: customer.firstOrderDate,
          lastOrderDate: customer.lastOrderDate,
          orderCount: customer.totalOrders,
          totalSpent: customer.totalSpent,
          avgOrderValue: customer.avgOrderValue,
          totalRefunded: customer.totalRefunded,
          paidCount: customer.paidCount,
          pendingCount: customer.pendingCount,
          cancelledCount: customer.cancelledCount,
          failedCount: customer.failedCount,
          refundedCount: customer.refundedCount,
          paymentMethods: customer.paymentMethods,
          currency: store.currency,
          segment,
          group: customer.group
            ? { name: customer.group.name, nameAr: customer.group.nameAr }
            : null,
          orders: orders.map(o => ({
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            paymentStatus: o.paymentStatus,
            total: o.total,
            itemCount: o.items.length,
            createdAt: o.createdAt,
          })),
          truncated,
        });
      });
    }
  );

  server.registerTool(
    'admin_get_funnel',
    {
      description:
        'Shopping funnel for the last 7, 30 or 90 days from the nightly rollup: product ' +
        'views → carts created → orders completed (paid), with step conversion rates and ' +
        'per-day rows. Stages the platform cannot measure for guest shoppers ' +
        '(checkout starts, abandonment) are null with a reason in `unavailable` — never 0.',
      inputSchema: {
        days: z
          .union(
            FUNNEL_WINDOWS.map(d => z.literal(d)) as [
              z.ZodLiteral<7>,
              z.ZodLiteral<30>,
              z.ZodLiteral<90>,
            ]
          )
          .optional()
          .describe('window in days: 7, 30 or 90 (default 30)'),
      },
    },
    async (args: { days?: 7 | 30 | 90 }, extra: ToolExtra) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_get_funnel');
      const days = args.days ?? 30;
      const rows = await readInStoreContext(store.id, () => listFunnelSnapshots(store.id, days));
      return ok({ currency: store.currency, ...summarizeFunnel(rows, days) });
    }
  );

  server.registerTool(
    'admin_list_reviews',
    {
      description:
        "List this store's product reviews: rating (1-5), title and text, product, " +
        'moderation status, the merchant reply, and date. The reviewer is shown by name ' +
        'with a MASKED email. Filter by status or product.',
      inputSchema: {
        status: z.enum(['pending', 'published', 'rejected', 'spam', 'all']).optional(),
        productId: z.string().trim().min(1).max(100).optional(),
        page: z.number().int().min(1).max(10_000).optional(),
        limit: z.number().int().min(1).max(REVIEWS_MAX_LIMIT).optional(),
      },
    },
    async (
      args: {
        status?: 'pending' | 'published' | 'rejected' | 'spam' | 'all';
        productId?: string;
        page?: number;
        limit?: number;
      },
      extra: ToolExtra
    ) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_list_reviews');
      const result = await readInStoreContext(store.id, () =>
        ReviewService.listForStore(store.id, {
          status: args.status ?? 'all',
          productId: args.productId,
          page: args.page ?? 1,
          limit: args.limit ?? 25,
        })
      );
      return ok({
        reviews: result.reviews.map(r => ({
          id: r.id,
          rating: r.rating,
          title: r.title ?? undefined,
          body: r.body,
          language: r.language,
          status: r.status,
          verifiedPurchase: r.verifiedPurchase,
          product: r.product ? { id: r.product.id, name: r.product.name } : null,
          reviewer: r.customer
            ? {
                name: `${r.customer.firstName ?? ''} ${r.customer.lastName ?? ''}`.trim() || null,
                email: maskEmail(r.customer.email),
              }
            : null,
          ownerResponse: r.ownerResponse ?? undefined,
          ownerResponseAt: r.ownerResponseAt ?? undefined,
          createdAt: r.createdAt,
        })),
        pagination: result.meta,
      });
    }
  );
}
