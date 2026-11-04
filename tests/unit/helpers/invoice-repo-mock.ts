/**
 * Test stand-ins for the invoice loader (Ruling CF-JOBS-4B): `InvoiceService` reads the order through `storeDb` and attaches the
 * platform `Store` and the buyer afterwards. These tests mock one `order.findFirst` that returns the order WITH its `store` and
 * `customer`; this helper serves the order half from `prisma` and the platform half from that same row.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let last: Any = null;

export async function repoFactoryMock() {
  const { prisma } = (await import('@ebda/database')) as Any;
  return {
    storeRepo: async () => ({ backend: 'pg' }),
    storeDb: async () => ({
      ...prisma,
      // the platform `Store` of the last order read (a Durable Object order cannot join it)
      store: { findUnique: async () => last?.store ?? null },
      order: {
        ...prisma.order,
        findFirst: async (...a: unknown[]) => {
          last = await prisma.order.findFirst(...a);
          return last;
        },
      },
    }),
  };
}

/** `withStore` transaction handle: the platform `Store` of the last order read. */
export function platformTx() {
  return { store: { findUnique: async () => last?.store ?? null } };
}

export function storeDbMock() {
  return {
    customersById: async () => {
      const c = last?.customer;
      return new Map(c ? [[last.customerId ?? 'u1', c]] : []);
    },
  };
}
