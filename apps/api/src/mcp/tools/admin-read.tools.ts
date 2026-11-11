import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { storeDb } from '../../lib/repo-factory';
import { readInStoreContext } from '../../lib/store-scoped-read';
import type { McpStore } from '../resolve-store';
import { ProductService } from '../../services/product.service';
import { effectiveInventory } from '../../lib/effective-inventory';
import { OrderService } from '../../services/order.service';
import { AnalyticsService } from '../../services/analytics.service';
import { assertScope, MERCHANT_SCOPES } from '../merchant-auth';
import { ok } from './tool-result';
import { maskAddress, maskEmail, redactFreeText } from '../../lib/pii-mask';

/**
 * Phase 1 of the merchant-admin MCP surface: READ tools only.
 *
 * Every handler is a thin façade over the SAME service method the admin
 * dashboard calls. No tool re-implements a query, a filter, or a permission
 * check — so RLS, feature gates, validation and the shape of a "product"
 * stay defined in exactly one place, and a fix to the service reaches the
 * dashboard and the agent together.
 *
 * ## Tenant context is opened HERE, not on the router
 *
 * `mcp.routes.ts`'s header explains at length why the buyer router is mounted
 * without `tenantContext`: its tools open their own scopes and `place_order`
 * makes an external gateway call in-request, so a router-level wrap would nest
 * a `$transaction` around a third-party HTTP call. The same reasoning applies
 * here, plus a second reason specific to this router — `tenantContext` reads
 * `req.params.storeId || req.params.id`, and this router's param is
 * `:storeSlug`, so it would be a SILENT no-op that merely looks like
 * protection. Each tool wraps its own reads in `readInStoreContext`.
 *
 * ## Why reads still need a scope check
 *
 * The router proved the caller holds a valid, unrevoked key for THIS store.
 * `assertScope` is the second half: which operations that key may perform. A
 * key minted for a reporting dashboard carries only `merchant:read`, and that
 * distinction is worthless if read tools skip the check.
 */

/**
 * Order has no `customerName` column and OrderService.list's `customer`
 * select carries firstName/lastName/email (no `name`) — so derive it the
 * same way OrderService.createOrder's socket notification does. Guest
 * orders (customerId null) fall back to the shippingAddress JSON snapshot
 * (firstName/lastName/email), which OrderService.createAdminOrder already
 * treats as the guest-contact source of truth.
 */
function deriveCustomerName(o: {
  customer?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  shippingAddress?: unknown;
}): string | undefined {
  // A nameless customer falls back to their email — MASKED, like every
  // contact detail this surface returns (see pii-mask.ts for why).
  const fromUser =
    `${o.customer?.firstName ?? ''} ${o.customer?.lastName ?? ''}`.trim() ||
    maskEmail(o.customer?.email);
  if (fromUser) return fromUser;

  const addr = (o.shippingAddress ?? {}) as Record<string, unknown>;
  const fromAddress =
    `${typeof addr.firstName === 'string' ? addr.firstName : ''} ${
      typeof addr.lastName === 'string' ? addr.lastName : ''
    }`.trim() || maskEmail(typeof addr.email === 'string' ? addr.email : null);
  return fromAddress || undefined;
}

/**
 * What an agent may know about where and how an order is delivered.
 *
 * Only what the platform actually records — nothing is inferred:
 *  - `method` is the carrier of a BOOKED shipment (`shipments` row); an order
 *    with no booked shipment has no recorded delivery method, so it is null.
 *  - `slot` is always null: checkout does not capture a delivery slot.
 *  - the zone is expressed as the address's area / governorate (the values
 *    the shipping-fee calculator matched on); the matched zone row itself is
 *    not stored on the order.
 *  - street-level address and phone are never included.
 */
export const DELIVERY_FIELDS_NOTE =
  'delivery.slot is always null (checkout does not capture a delivery slot). ' +
  'delivery.method is the carrier of a booked shipment and null when none was booked. ' +
  'area/governorate identify the delivery zone; street address and phone are not returned.';

interface ShipmentSummary {
  carrier: string;
  status: string;
  trackingNumber: string | null;
  estimatedDeliveryAt: Date | null;
}

function deliveryOf(o: any, shipment: ShipmentSummary | undefined) {
  const addr = (o.shippingAddress ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof addr[k] === 'string' && addr[k] ? (addr[k] as string) : null);
  return {
    method: shipment?.carrier ?? null,
    shipmentStatus: shipment?.status ?? null,
    trackingNumber: shipment?.trackingNumber ?? null,
    estimatedDeliveryAt: shipment?.estimatedDeliveryAt ?? null,
    governorate: str('governorate'),
    // The storefront writes the selected delivery area to `state` on the legacy
    // address model; newer orders also carry an explicit `area`.
    area: str('area') ?? str('state'),
    areaAr: str('areaAr'),
    city: str('city'),
    country: str('country'),
    slot: null,
    shippingFee: o.shipping ?? null,
    placedAt: o.createdAt,
    shippedAt: o.shippedAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
  };
}

const SHIPMENT_SUMMARY_SELECT = {
  orderId: true,
  carrier: true,
  status: true,
  trackingNumber: true,
  estimatedDeliveryAt: true,
} as const;

/** Shared shape so a product looks the same from every admin tool. */
function productSummary(p: any) {
  return {
    id: p.id,
    name: p.name,
    nameAr: p.nameAr ?? undefined,
    sku: p.sku ?? undefined,
    slug: p.slug,
    status: p.status,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? undefined,
    // `products.inventory` is stock ONLY for a product with no variants; for a
    // variant product it is unused and stays 0. Reading it directly is the
    // defect that filled the Low Stock Alerts card with well-stocked products
    // in 2026-08. Both services already attach the variant-aware value, so
    // prefer it and fall back to the shared helper rather than to `p.inventory`.
    //
    // This is not cosmetic: skills/catalog-audit and skills/store-health-check
    // both reason over this field, and `admin_get_analytics` goes through
    // variant-aware SQL — so a raw read here makes the two tools contradict
    // each other, which the health-check skill tells the agent is itself a
    // finding.
    inventory: p.totalInventory ?? effectiveInventory(p),
    hasVariants: Boolean(p.hasVariants),
    trackInventory: p.trackInventory,
    featured: p.featured,
    categories: (p.categories ?? []).map((c: any) => c.category?.name ?? c.categoryId),
    updatedAt: p.updatedAt,
  };
}

export function registerAdminReadTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'admin_get_store',
    {
      description:
        'Settings and status for the store this key belongs to — name, currency, ' +
        'domain. The starting point for any store-management session.',
      inputSchema: {},
    },
    async (_args: unknown, extra: any) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_get_store');
      return ok({
        id: store.id,
        name: store.name,
        slug: store.slug,
        currency: store.currency,
        domain: store.domain ?? undefined,
      });
    }
  );

  server.registerTool(
    'admin_list_products',
    {
      description:
        "List this store's products with full admin detail — including draft and " +
        'archived ones, real inventory counts, and SKUs. Unlike the buyer-facing ' +
        'search_products, this is not limited to active products.',
      inputSchema: {
        search: z.string().optional().describe('match against English and Arabic name'),
        status: z.enum(['active', 'draft', 'archived']).optional(),
        featured: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (
      args: { search?: string; status?: string; featured?: boolean; page?: number; limit?: number },
      extra: any
    ) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_list_products');
      const result: any = await readInStoreContext(store.id, () =>
        ProductService.list(store.id, {
          search: args.search,
          status: args.status,
          featured: args.featured,
          page: args.page ?? 1,
          limit: args.limit ?? 25,
        } as Parameters<typeof ProductService.list>[1])
      );
      return ok({
        products: (result.products ?? []).map(productSummary),
        pagination: result.pagination ?? result.meta ?? undefined,
      });
    }
  );

  server.registerTool(
    'admin_get_product',
    {
      description:
        'Full admin detail for one product: variants, cost price, inventory, ' +
        'categories, images, and status. Throws if the id belongs to another store.',
      inputSchema: { productId: z.string().min(1) },
    },
    async ({ productId }: { productId: string }, extra: any) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_get_product');
      // ProductService.getById is store-scoped and throws AppError(404) for an
      // id owned by another store — the SDK turns a thrown Error into
      // `{ isError: true }`, so no try/catch and no leak of the other tenant.
      const p: any = await readInStoreContext(store.id, () =>
        ProductService.getById(store.id, productId)
      );
      return ok({
        ...productSummary(p),
        description: p.description ?? undefined,
        descriptionAr: p.descriptionAr ?? undefined,
        costPrice: p.costPrice ?? undefined,
        barcode: p.barcode ?? undefined,
        weight: p.weight ?? undefined,
        // B0 commerce fields: the same shapes `admin_update_product` accepts (read-write parity).
        facts: Array.isArray(p.facts) && p.facts.length ? p.facts : undefined,
        leadTimeDays: p.leadTimeDays ?? undefined,
        personalisation: p.personalisation ?? undefined,
        sizeChartId: p.sizeChartId ?? undefined,
        variants: (p.variants ?? []).map((v: any) => ({
          id: v.id,
          // ProductVariant's Prisma field is `title`, not `name` — mapped to
          // this response's `name` key (#1735: this mapping already existed
          // and read v.name, which the widened select above never
          // populated, so the fix corrects the select-vs-field mismatch,
          // not just the missing select).
          name: v.title,
          sku: v.sku ?? undefined,
          price: v.price,
          inventory: v.inventory,
          // A disabled variant's inventory is not stock (#1103) — the product's
          // `inventory` above already excludes it; this says why a row's
          // units are missing from that total.
          isActive: v.isActive !== false,
        })),
        images: (p.images ?? []).map((i: any) => i.url),
      });
    }
  );

  server.registerTool(
    'admin_list_orders',
    {
      description:
        "List this store's orders with admin detail — customer, totals, payment " +
        'and fulfilment status, and delivery detail (carrier, area/governorate, ' +
        'shipped/delivered timestamps). Filterable by status and date range.',
      inputSchema: {
        status: z.string().optional(),
        from: z.string().optional().describe('ISO date, inclusive'),
        to: z.string().optional().describe('ISO date, inclusive'),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (
      args: { status?: string; from?: string; to?: string; page?: number; limit?: number },
      extra: any
    ) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_list_orders');
      // An unparseable date must not become `Invalid Date` and silently widen
      // the query to everything — reject it as an argument error instead.
      const parseDate = (v: string | undefined, label: string) => {
        if (!v) return undefined;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`INVALID_ARGUMENT: ${label} is not a date`);
        return d;
      };
      const result: any = await readInStoreContext(store.id, () =>
        OrderService.list(store.id, {
          status: args.status,
          from: parseDate(args.from, 'from'),
          to: parseDate(args.to, 'to'),
          page: args.page ?? 1,
          limit: args.limit ?? 25,
        })
      );
      // One batched read for the page's booked shipments (never one per order).
      const orderIds: string[] = (result.orders ?? []).map((o: any) => o.id);
      const shipments =
        orderIds.length > 0
          ? await readInStoreContext(store.id, async () =>
              (await storeDb(store.id)).shipment.findMany({
                where: { storeId: store.id, orderId: { in: orderIds } },
                select: SHIPMENT_SUMMARY_SELECT,
              })
            )
          : [];
      const shipmentByOrder = new Map(shipments.map(s => [s.orderId, s]));
      return ok({
        orders: (result.orders ?? []).map((o: any) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          paymentStatus: o.paymentStatus,
          total: o.total,
          currency: store.currency,
          customerName: deriveCustomerName(o),
          itemCount: o.items?.length ?? undefined,
          createdAt: o.createdAt,
          delivery: deliveryOf(o, shipmentByOrder.get(o.id)),
        })),
        pagination: result.pagination ?? result.meta ?? undefined,
        deliveryNote: DELIVERY_FIELDS_NOTE,
      });
    }
  );

  server.registerTool(
    'admin_get_order',
    {
      description:
        'Full detail for one order: line items, payment records, delivery detail ' +
        '(carrier, area/governorate, shipped/delivered timestamps) and the status ' +
        'history. Addresses are reduced to locality and contact details are MASKED; ' +
        'order notes are returned with phone numbers and emails redacted. ' +
        'Throws if the id belongs to another store.',
      inputSchema: { orderId: z.string().min(1) },
    },
    async ({ orderId }: { orderId: string }, extra: any) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_get_order');
      return readInStoreContext(store.id, async () => {
        // Store-scoped: throws 404 for another store's order id.
        const o: any = await OrderService.getById(store.id, orderId);
        const [shipment, events] = await Promise.all([
          (await storeDb(store.id)).shipment.findFirst({
            where: { storeId: store.id, orderId: o.id },
            select: SHIPMENT_SUMMARY_SELECT,
          }),
          (await storeDb(store.id)).orderEvent.findMany({
            where: { storeId: store.id, orderId: o.id },
            select: { fromStatus: true, toStatus: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
            take: 100,
          }),
        ]);
        // An explicit ALLOWLIST, never `...o` (issue 2244): a spread is a
        // denylist, so every Order column rode out verbatim — including the
        // shopper-authored `notes`/`customerNotes`, where Egypt shoppers
        // type street directions and a callback number — and any future
        // column would too. This payload lands in a third-party LLM context.
        return ok({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          paymentStatus: o.paymentStatus,
          source: o.source,
          currency: o.currency,
          subtotal: o.subtotal,
          tax: o.tax,
          taxIncludedInPrice: o.taxIncludedInPrice,
          shipping: o.shipping,
          discount: o.discount,
          couponCode: o.couponCode,
          couponDiscount: o.couponDiscount,
          promotionDiscount: o.promotionDiscount,
          appliedPromotion: o.appliedPromotion ?? null,
          bundleDiscount: o.bundleDiscount,
          loyaltyPointsRedeemed: o.loyaltyPointsRedeemed,
          loyaltyDiscount: o.loyaltyDiscount,
          walletAmount: o.walletAmount,
          extraAmount: o.extraAmount,
          extraAmountNote: o.extraAmountNote,
          total: o.total,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
          shippedAt: o.shippedAt,
          deliveredAt: o.deliveredAt,
          // Free text: phone- and email-shaped runs redacted, the rest kept.
          notes: redactFreeText(o.notes),
          customerNotes: redactFreeText(o.customerNotes),
          items: (o.items ?? []).map((it: any) => ({
            id: it.id,
            productId: it.productId,
            variantId: it.variantId,
            productName: it.productName,
            variantName: it.variantName,
            sku: it.sku,
            quantity: it.quantity,
            price: it.price,
            total: it.total,
            bundleId: it.bundleId,
            bundleName: it.bundleName,
          })),
          payments: (o.payments ?? []).map((p: any) => ({
            id: p.id,
            provider: p.provider,
            method: p.method,
            status: p.status,
            amount: p.amount,
            // Gateway references for reconciliation. `paymentUrl` is NOT
            // returned: an unpaid order's hosted checkout link is a bearer
            // capability, and this payload lands in a third-party LLM
            // transcript (PR 2301 audit).
            transactionId: p.transactionId,
            invoiceId: p.invoiceId,
            paidAt: p.paidAt,
            createdAt: p.createdAt,
          })),
          // Masked: contact details are reduced so no shopper can be reached
          // from a transcript.
          shippingAddress: maskAddress(o.shippingAddress),
          billingAddress: maskAddress(o.billingAddress),
          customer: o.customer
            ? {
                id: o.customer.id,
                firstName: o.customer.firstName,
                lastName: o.customer.lastName,
                email: maskEmail(o.customer.email),
              }
            : null,
          delivery: deliveryOf(o, shipment ?? undefined),
          // Status timestamps: every transition from the append-only order_events trail.
          statusHistory: events.map(e => ({ from: e.fromStatus, to: e.toStatus, at: e.createdAt })),
          deliveryNote: DELIVERY_FIELDS_NOTE,
        });
      });
    }
  );

  server.registerTool(
    'admin_get_analytics',
    {
      description:
        'Dashboard figures for this store: revenue, order count, average order ' +
        'value, top products, and low-stock items. The numbers behind the admin ' +
        'dashboard, without opening it. Customers are counted like the Customers ' +
        'page (registered user, else shipping email, else phone — guests count). ' +
        'totalProfit is null when sold lines have no cost price (unknown, not 0); ' +
        'profitItemsMissingCost says how many lines it excludes. conversionRate is ' +
        'orders per product view (%) or null when no views were recorded.',
      inputSchema: {
        from: z.string().optional().describe('ISO date; defaults to the service default window'),
        to: z.string().optional(),
        topProductsLimit: z.number().int().min(1).max(50).optional(),
        lowStockThreshold: z.number().int().min(0).max(1000).optional(),
      },
    },
    async (
      args: {
        from?: string;
        to?: string;
        topProductsLimit?: number;
        lowStockThreshold?: number;
      },
      extra: any
    ) => {
      assertScope(extra?.authInfo, MERCHANT_SCOPES.read, 'admin_get_analytics');
      const parseDate = (v: string | undefined, label: string) => {
        if (!v) return undefined;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`INVALID_ARGUMENT: ${label} is not a date`);
        return d;
      };
      const from = parseDate(args.from, 'from');
      const to = parseDate(args.to, 'to');
      // AnalyticsService's DateRange is { startDate, endDate } — NOT the
      // { from, to } shape OrderService.list takes. Naming them the same on
      // the tool's input keeps the agent-facing API consistent; the mapping
      // happens here, once.
      const range = from && to ? { startDate: from, endDate: to } : undefined;

      return readInStoreContext(store.id, async () => {
        const [stats, topProducts, lowStock] = await Promise.all([
          AnalyticsService.getDashboardStats(store.id, range),
          AnalyticsService.getTopProducts(store.id, args.topProductsLimit ?? 10, range),
          AnalyticsService.getLowStockProducts(store.id, args.lowStockThreshold ?? 10),
        ]);
        return ok({ currency: store.currency, stats, topProducts, lowStock });
      });
    }
  );
}
