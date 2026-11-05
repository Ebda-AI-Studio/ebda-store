/**
 * Payload builders for merchant outgoing webhooks. Minimal PII by design (apps/docs/content/merchant-webhooks.mdx):
 * an order carries ids, totals (minor units = piastres), status and line items; the customer's name,
 * email and phone travel ONLY on an endpoint whose `includeCustomer` is on.
 */
import { prisma } from '@ebda/database';
import { storeRepo } from '../lib/repo-factory';
import { customersById } from '../lib/jobs/store-db';

export interface FanoutEvent {
  type: string;
  /** Stable per logical event: the same key never creates a second delivery per endpoint. */
  dedupeKey: string;
  data: Record<string, unknown>;
  /** Merged into `data.customer` for endpoints that opted in. */
  customer?: { name: string | null; email: string | null; phone: string | null } | null;
}

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  currency: string;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  total: number;
  createdAt: Date;
  shippingAddress: unknown;
  customer: { firstName: string; lastName: string; email: string; phone: string | null } | null;
  items: Array<{
    productId: string;
    variantId: string | null;
    productName: string;
    variantName: string | null;
    sku: string | null;
    quantity: number;
    price: number;
    total: number;
  }>;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function formatOrderParts(row: OrderRow): Pick<FanoutEvent, 'data' | 'customer'> {
  const addr = (row.shippingAddress ?? {}) as Record<string, unknown>;
  const name =
    `${row.customer?.firstName ?? str(addr.firstName) ?? ''} ${row.customer?.lastName ?? str(addr.lastName) ?? ''}`.trim() ||
    null;
  return {
    data: {
      order: {
        id: row.id,
        number: row.orderNumber,
        status: row.status,
        paymentStatus: row.paymentStatus,
        currency: row.currency,
        subtotal: row.subtotal,
        tax: row.tax,
        shipping: row.shipping,
        discount: row.discount,
        total: row.total,
        createdAt: row.createdAt.toISOString(),
        items: row.items.map(i => ({
          productId: i.productId,
          variantId: i.variantId,
          name: i.variantName ? `${i.productName} - ${i.variantName}` : i.productName,
          sku: i.sku,
          quantity: i.quantity,
          unitPrice: i.price,
          total: i.total,
        })),
      },
    },
    customer: {
      name,
      email: row.customer?.email ?? str(addr.email),
      phone: row.customer?.phone ?? str(addr.phone),
    },
  };
}

/** The order for a webhook, read in the ambient tenant. null when it is not this store's. */
export async function loadOrderParts(storeId: string, orderId: string) {
  const repo = await storeRepo(storeId);
  // A store on its Durable Object: the order is read from its DO and the buyer (a platform `User`) attached after the read,
  // with the same select the Postgres relation has (Ruling CF-JOBS-4B).
  const reader = repo.backend === 'do' ? repo.db : prisma;
  const raw = await reader.order.findFirst({
    where: { id: orderId, storeId },
    select: {
      customerId: true,
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      currency: true,
      subtotal: true,
      tax: true,
      shipping: true,
      discount: true,
      total: true,
      createdAt: true,
      shippingAddress: true,
      ...(repo.backend === 'do'
        ? {}
        : { customer: { select: { firstName: true, lastName: true, email: true, phone: true } } }),
      items: {
        select: {
          productId: true,
          variantId: true,
          productName: true,
          variantName: true,
          sku: true,
          quantity: true,
          price: true,
          total: true,
        },
      },
    },
  });
  if (!raw) return null;
  const row =
    repo.backend === 'do'
      ? {
          ...raw,
          customer:
            (
              await customersById(storeId, [(raw as { customerId?: string | null }).customerId])
            ).get((raw as { customerId?: string | null }).customerId ?? '') ?? null,
        }
      : raw;
  return { row, ...formatOrderParts(row as unknown as OrderRow) };
}

export async function loadProductData(storeId: string, productId: string) {
  const repo = await storeRepo(storeId);
  const p = await (repo.backend === 'do' ? repo.db : prisma).product.findFirst({
    where: { id: productId, storeId },
    select: {
      id: true,
      name: true,
      nameAr: true,
      slug: true,
      sku: true,
      price: true,
      status: true,
    },
  });
  if (!p) return null;
  return {
    product: {
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      slug: p.slug,
      sku: p.sku,
      price: p.price,
      status: p.status,
    },
  };
}
