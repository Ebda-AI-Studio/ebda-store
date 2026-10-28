/**
 * B2B Task 8: the invoice prints the tier label and the struck-through retail price from the line's PERSISTED snapshot, an order
 * placed before B2B renders exactly as before, the fiscal-document renderer does the same, and the analytics split buckets
 * lines by price source (pre-B2B lines are retail).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { withRlsBypass } from '@ebda/database';
import { InvoiceService } from '@api/services/invoice.service';
import { AnalyticsService } from '@api/services/analytics.service';
import { renderFiscalDocumentHtml } from '@api/services/fiscal-document-render';
import { priceLineLabel, struckListPrice } from '@api/lib/order-pricing';
import { hasDb } from '../helpers/bundle-fixtures';

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

describe('price label helpers (pure)', () => {
  it('labels a GROUP tier "Wholesale price" with its threshold, a group line plainly, in both languages with Latin digits', () => {
    const g = { priceSource: 'tier', priceTierMinQty: 10, priceGroupApplied: true };
    expect(priceLineLabel(g, 'en')).toBe('Wholesale price, 10+ units');
    expect(priceLineLabel(g, 'ar')).toBe('سعر الجملة، 10+ وحدة');
    expect(priceLineLabel({ priceSource: 'group', priceTierMinQty: null }, 'en')).toBe(
      'Wholesale price'
    );
  });
  it('final review minor 4: a PUBLIC quantity break (any shopper) reads "Quantity price", never "Wholesale price"', () => {
    for (const groupApplied of [false, null, undefined]) {
      const pub = { priceSource: 'tier', priceTierMinQty: 10, priceGroupApplied: groupApplied };
      expect(priceLineLabel(pub, 'en')).toBe('Quantity price, 10+ units');
      expect(priceLineLabel(pub, 'ar')).toBe('سعر الكمية، 10+ وحدة');
    }
  });
  it('prints nothing for a retail line and for a line sold before the snapshot existed', () => {
    for (const i of [{ priceSource: 'base' }, { priceSource: null }, {}]) {
      expect(priceLineLabel(i, 'en')).toBeNull();
      expect(priceLineLabel(i, 'ar')).toBeNull();
    }
  });
  it('strikes the list price only when the line was sold below it', () => {
    expect(struckListPrice({ priceSource: 'tier', listPrice: 100, price: 80 })).toBe(100);
    expect(struckListPrice({ priceSource: 'base', listPrice: 100, price: 100 })).toBeNull();
    expect(struckListPrice({ priceSource: 'base', listPrice: 120, price: 100 })).toBeNull(); // a retail line never shows a strike
    expect(struckListPrice({ priceSource: 'tier', listPrice: 80, price: 80 })).toBeNull();
    expect(struckListPrice({ priceSource: null, listPrice: null, price: 80 })).toBeNull();
  });
  it('the fiscal-document renderer prints the label and strikes the list price from the stored payload; an old payload is unchanged', () => {
    const doc = (lines: unknown[]) =>
      renderFiscalDocumentHtml(
        {
          docType: 'tax_invoice',
          number: 'INV-1',
          currency: 'EGP',
          vatRateBps: null,
          payload: { lines, seller: undefined },
        } as never,
        'en'
      );
    const tier = doc([
      {
        kind: 'item',
        description: 'Tea',
        quantity: 12,
        unitPrice: 8000,
        amount: 96000,
        priceLabel: 'Wholesale price, 10+ units',
        priceLabelAr: 'سعر الجملة، 10+ وحدة',
        listPrice: 10000,
      },
    ]);
    expect(tier).toContain('Wholesale price, 10+ units');
    expect(tier).toContain('<s ');
    const old = doc([
      { kind: 'item', description: 'Tea', quantity: 12, unitPrice: 8000, amount: 96000 },
    ]);
    expect(old).not.toContain('data-price-label');
    expect(old).not.toContain('<s ');
  });
});

describe.skipIf(!hasDb)('invoice + analytics against Postgres', () => {
  let storeId = '';
  let tierOrderId = '';
  let groupTierOrderId = '';
  let legacyOrderId = '';

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `b2bia-o-${SUF}@t.com`,
          passwordHash: 'x',
          role: 'store_admin',
          firstName: 'O',
          lastName: 'W',
        },
      });
      const cust = await tx.user.create({
        data: {
          email: `b2bia-c-${SUF}@t.com`,
          passwordHash: 'x',
          role: 'customer',
          firstName: 'C',
          lastName: 'U',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'b2bia',
          slug: `b2bia-${SUF}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;
      const product = await tx.product.create({
        data: {
          storeId,
          name: 'Tea',
          slug: `tea-${SUF}`,
          price: 10000,
          inventory: 100,
          status: 'active',
        },
      });
      const mk = (n: string, item: Record<string, unknown>, total: number) =>
        tx.order.create({
          data: {
            storeId,
            customerId: cust.id,
            orderNumber: `B2BIA-${SUF}-${n}`,
            status: 'delivered',
            paymentStatus: 'paid',
            subtotal: total,
            total,
            shippingAddress: {},
            billingAddress: {},
            items: {
              create: [
                {
                  productId: product.id,
                  productName: 'Tea',
                  quantity: 12,
                  price: item.price as number,
                  total,
                  ...item,
                },
              ],
            },
          },
        });
      tierOrderId = (
        await mk(
          'T',
          { price: 8000, listPrice: 10000, priceSource: 'tier', priceTierMinQty: 10 },
          96000
        )
      ).id;
      groupTierOrderId = (
        await mk(
          'G',
          {
            price: 7000,
            listPrice: 10000,
            priceSource: 'tier',
            priceTierMinQty: 10,
            priceGroupApplied: true,
          },
          84000
        )
      ).id;
      legacyOrderId = (await mk('L', { price: 10000 }, 120000)).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: SUF } } }).catch(() => {});
    });
  });

  it('the invoice shows the tier label (en and ar) and the struck list price for the snapshotted line', async () => {
    const en = await InvoiceService.generateInvoice(storeId, tierOrderId, 'en');
    expect(en).toContain('Quantity price, 10+ units'); // a public break
    expect(en).not.toContain('Wholesale price');
    expect(en).toContain('list-price');
    const ar = await InvoiceService.generateInvoice(storeId, tierOrderId, 'ar');
    expect(ar).toContain('سعر الكمية، 10+ وحدة');
    const g = await InvoiceService.generateInvoice(storeId, groupTierOrderId, 'en');
    expect(g).toContain('Wholesale price, 10+ units'); // the buyer's group tier
    const gAr = await InvoiceService.generateInvoice(storeId, groupTierOrderId, 'ar');
    expect(gAr).toContain('سعر الجملة، 10+ وحدة');
  });

  it('an order placed before B2B renders with no label and no struck price', async () => {
    const html = await InvoiceService.generateInvoice(storeId, legacyOrderId, 'en');
    expect(html).not.toContain('data-price-label');
    expect(html).not.toContain('list-price');
  });

  it('the analytics split buckets lines by price source, pre-B2B lines count as retail, and wholesale = tier + group', async () => {
    const r = await AnalyticsService.getRevenueByPriceSource(storeId, {
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 86_400_000),
    });
    expect(r.tier).toEqual({ revenue: 96000, units: 12 });
    expect(r.retail).toEqual({ revenue: 120000, units: 12 });
    // a GROUP tier is the buyer's group price, not a public quantity break (final review minor 4)
    expect(r.group).toEqual({ revenue: 84000, units: 12 });
    expect(r.wholesale).toEqual({ revenue: 180000, units: 24 });
    expect(r.wholesaleSharePercent).toBe(60); // 180000 / 300000
  });
});
