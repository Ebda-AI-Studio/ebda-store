/**
 * QA-PRICE-ZERO-1, service wiring: the paths that can leave an ACTIVE product / variant at price 0 refuse it.
 * Behavioural for bulk price/status and variant update (mocked Prisma); source-pinned for the create/update/import
 * entry points whose preconditions (plan limits, B2B fields) a mock would only restate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prisma: {
    product: {
      findMany: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    productVariant: { findFirst: vi.fn(), update: vi.fn(async () => ({ options: [] })) },
  },
  hasTenantContext: () => false,
}));

const { ProductService } = await import('@api/services/product.service');
const { BulkService } = await import('@api/services/bulk.service');
const { VariantService } = await import('@api/services/variant.service');
const { prisma } = await import('@ebda/database');

const row = (over: Record<string, unknown>) => ({
  id: 'p1',
  name: 'Mug',
  price: 0,
  status: 'draft',
  inventory: 3,
  pricingMode: 'fixed',
  _count: { variants: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProductService.bulkUpdate', () => {
  it('refuses to activate a 0-priced draft and writes nothing', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce([row({})] as never);
    await expect(
      ProductService.bulkUpdate('s1', ['p1'], { status: 'active' })
    ).rejects.toMatchObject({ code: 'PRICE_REQUIRED_FOR_ACTIVE' });
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });
  it('refuses a price write that lands an ACTIVE product on 0 (set 0, or adjustPct -99 of 1 piastre)', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      row({ price: 1, status: 'active' }),
    ] as never);
    await expect(
      ProductService.bulkUpdate('s1', ['p1'], { price: { mode: 'set', value: 0 } })
    ).rejects.toMatchObject({ code: 'PRICE_REQUIRED_FOR_ACTIVE' });
    await expect(
      ProductService.bulkUpdate('s1', ['p1'], { price: { mode: 'adjustPct', value: -99 } })
    ).rejects.toMatchObject({ code: 'PRICE_REQUIRED_FOR_ACTIVE' });
  });
  it('lets a draft be repriced to 0, a priced draft be activated, and a gold row be activated (repricer owns it)', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce([row({})] as never);
    await expect(
      ProductService.bulkUpdate('s1', ['p1'], { price: { mode: 'set', value: 0 } })
    ).resolves.toBeDefined();
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce([row({ price: 900 })] as never);
    await expect(
      ProductService.bulkUpdate('s1', ['p1'], { status: 'active' })
    ).resolves.toBeDefined();
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce([
      row({ pricingMode: 'gold_rate' }),
    ] as never);
    await expect(
      ProductService.bulkUpdate('s1', ['p1'], { status: 'active' })
    ).resolves.toBeDefined();
  });
});

describe('BulkService.bulkUpdateStatus', () => {
  it('skips a free product, activates the rest, and names the refused one', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce([
      row({ id: 'free', name: 'Free mug' }),
      row({ id: 'ok', price: 500 }),
    ] as never);
    const r = await BulkService.bulkUpdateStatus('s1', ['free', 'ok'], 'active' as never);
    const written = (
      vi.mocked(prisma.product.updateMany).mock.calls[0][0] as {
        where: { id: { in: string[] } };
      }
    ).where.id.in;
    expect(written).toEqual(['ok']);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.errors[0]).toMatch(/Free mug/);
  });
  it('archiving / drafting is never blocked', async () => {
    await BulkService.bulkUpdateStatus('s1', ['free'], 'draft' as never);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).toHaveBeenCalled();
  });
});

describe('VariantService.updateVariant', () => {
  const variant = (over: Record<string, unknown>) => ({
    id: 'v1',
    isActive: true,
    price: 800,
    inventory: 0,
    pricingMode: null,
    product: { status: 'active', price: 800, pricingMode: 'fixed' },
    ...over,
  });
  it('refuses setting an active product variant price to 0 or clearing it onto a 0 product price', async () => {
    vi.mocked(prisma.productVariant.findFirst).mockResolvedValue(variant({}) as never);
    await expect(
      VariantService.updateVariant('s1', 'p1', 'v1', { price: 0 } as never)
    ).rejects.toMatchObject({
      code: 'PRICE_REQUIRED_FOR_ACTIVE',
    });
    vi.mocked(prisma.productVariant.findFirst).mockResolvedValue(
      variant({ product: { status: 'active', price: 0, pricingMode: 'fixed' } }) as never
    );
    await expect(
      VariantService.updateVariant('s1', 'p1', 'v1', { price: null } as never)
    ).rejects.toMatchObject({
      code: 'PRICE_REQUIRED_FOR_ACTIVE',
    });
    expect(prisma.productVariant.update).not.toHaveBeenCalled();
  });
  it('allows it on a draft product', async () => {
    vi.mocked(prisma.productVariant.findFirst).mockResolvedValue(
      variant({ product: { status: 'draft', price: 0, pricingMode: 'fixed' } }) as never
    );
    await expect(
      VariantService.updateVariant('s1', 'p1', 'v1', { price: 0 } as never)
    ).resolves.toBeDefined();
  });
});

describe('entry points are guarded (source-pinned)', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../../apps/api/src', f), 'utf8');
  it('ProductService.create and update call assertActiveProductPrice before writing', () => {
    const src = read('services/product.service.ts');
    expect(src).toMatch(
      /assertActiveProductPrice\(\{ status: data\.status \?\? 'draft', price: data\.price \}\)[\s\S]*w\.product\.create/
    );
    expect(src).toMatch(
      /status: data\.status \?\? product\.status[\s\S]*price: data\.price \?\? product\.price/
    );
  });
  it('CSV / catalog import fails a free active row on its own, and variant rows with an explicit 0', () => {
    const src = read('services/bulk.service.ts');
    expect(src).toMatch(
      /isFreeActiveProduct\(\{[\s\S]*?result\.errors\.push\(\{ row: rowIndex, error: PRICE_REQUIRED_MESSAGE\.messageEn \}\)/
    );
    expect(src).toMatch(/explicit variant price of 0/);
  });
  it('catalog-import and the MCP write tools reach the products only through ProductService / VariantService', () => {
    for (const f of ['services/catalog-import.service.ts', 'mcp/tools/admin-write.tools.ts']) {
      expect(read(f)).not.toMatch(/\bprisma\.product\.(create|update)\(/);
    }
  });
});
