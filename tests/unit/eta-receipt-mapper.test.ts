import { describe, it, expect } from 'vitest';
import {
  allocate,
  buildReturnReceipt,
  buildSaleReceipt,
  EtaMapError,
  type EtaOrderInput,
} from '@api/lib/eta/receipt-mapper';
import { receiptUuid } from '@api/lib/eta/serialize';
import { etaQrPayload } from '@api/lib/eta/qr';

const seller = {
  rin: '674859545',
  companyTradeName: 'Nile Shop',
  branchCode: '0',
  activityCode: '4719',
  deviceSerialNumber: 'POS-1',
  address: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas', buildingNumber: '5' },
};
const base: EtaOrderInput = {
  orderNumber: 'EB-1001',
  createdAt: new Date('2026-10-26T10:00:00.000Z'),
  currency: 'EGP',
  discount: 0,
  shipping: 0,
  codFee: 0,
  extraAmount: 0,
  tax: 2800,
  total: 22800,
  taxableAmount: 20000,
  taxRateBps: 1400,
  paymentProvider: 'paymob',
  buyer: { name: 'Mona Ali', mobile: '01000000000' },
  items: [
    { productId: 'p1', productName: 'Lamp', sku: 'LAMP-1', quantity: 2, total: 10000 },
    { productId: 'p2', productName: 'Rug', sku: null, quantity: 1, total: 10000 },
  ],
};
const args = (o: Partial<EtaOrderInput> = {}) => ({
  order: { ...base, ...o },
  seller,
  defaultItemCode: 'EG-674859545-1',
  previousUuid: '',
  receiptNumber: 'EB-1001',
  issuedAt: new Date('2026-10-26T10:00:00.000Z'),
});

describe('allocate', () => {
  it('always sums to the total (largest remainder)', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });
});

describe('buildSaleReceipt', () => {
  it('maps an exclusive-VAT order to Receipt v1.2 with exact totals', () => {
    const r = buildSaleReceipt(args()) as any;
    expect(r.documentType).toEqual({ receiptType: 's', typeVersion: '1.2' });
    expect(r.header.dateTimeIssued).toBe('2026-10-26T10:00:00Z');
    expect(r.header.previousUUID).toBe('');
    expect(r.header.uuid).toMatch(/^[0-9a-f]{64}$/);
    expect(r.header.uuid).toBe(receiptUuid(r));
    expect(r.seller.branchAddress.country).toBe('EG');
    expect(r.totalAmount).toBe(228);
    expect(r.netAmount).toBe(200);
    expect(r.taxTotals).toEqual([{ taxType: 'T1', amount: 28 }]);
    expect(r.paymentMethod).toBe('V');
    expect(r.itemData).toHaveLength(2);
    expect(r.itemData[0].taxableItems[0]).toEqual({
      taxType: 'T1',
      amount: 14,
      subType: 'V009',
      rate: 14,
    });
    expect(r.itemData[0].unitPrice).toBe(50);
    const sum = r.itemData.reduce((s: number, i: any) => s + i.total, 0);
    expect(Math.round(sum * 100)).toBe(22800);
  });

  it('adds shipping as its own line and keeps the total exact', () => {
    const r = buildSaleReceipt(
      args({ shipping: 5000, taxableAmount: 25000, tax: 3500, total: 28500 })
    ) as any;
    expect(r.itemData).toHaveLength(3);
    expect(r.itemData[2].internalCode).toBe('SHIPPING');
    expect(r.totalAmount).toBe(285);
  });

  it('shows a discount per line and still totals to what the customer paid', () => {
    const r = buildSaleReceipt(
      args({ discount: 2000, taxableAmount: 18000, tax: 2520, total: 20520 })
    ) as any;
    expect(r.totalCommercialDiscount).toBe(20);
    expect(r.totalSales).toBe(200);
    expect(r.netAmount).toBe(180);
    expect(r.totalAmount).toBe(205.2);
  });

  it('omits taxableItems when the order carries no VAT', () => {
    const r = buildSaleReceipt(
      args({ tax: 0, taxableAmount: null, total: 20000, taxRateBps: null })
    ) as any;
    expect(r.itemData[0].taxableItems).toBeUndefined();
    expect(r.taxTotals).toBeUndefined();
    expect(r.totalAmount).toBe(200);
  });

  it('maps cash on delivery to payment code C', () => {
    expect((buildSaleReceipt(args({ paymentProvider: 'cod' })) as any).paymentMethod).toBe('C');
  });

  it('refuses instead of submitting a receipt that disagrees with the charge', () => {
    expect(() => buildSaleReceipt(args({ total: 99999 }))).toThrowError(EtaMapError);
    try {
      buildSaleReceipt(args({ total: 99999 }));
    } catch (e) {
      expect((e as EtaMapError).code).toBe('ETA_TOTAL_MISMATCH');
    }
  });

  it('refuses non-EGP and large unidentified buyers', () => {
    expect(() => buildSaleReceipt(args({ currency: 'USD' }))).toThrow(/not EGP/);
    expect(() =>
      buildSaleReceipt(args({ total: 15_000_000, taxableAmount: 13_157_895, tax: 1_842_105 }))
    ).toThrow(/buyer id/);
  });
});

describe('buildReturnReceipt', () => {
  it('references the sale uuid and chains previousUUID', () => {
    const sale = buildSaleReceipt(args()) as any;
    const ret = buildReturnReceipt({
      sale,
      previousUuid: sale.header.uuid,
      receiptNumber: 'EB-1001-R1',
      issuedAt: new Date('2026-10-27T09:00:00.000Z'),
    }) as any;
    expect(ret.documentType).toEqual({ receiptType: 'r', typeVersion: '1.2' });
    expect(ret.header.referenceUUID).toBe(sale.header.uuid);
    expect(ret.header.previousUUID).toBe(sale.header.uuid);
    expect(ret.header.uuid).not.toBe(sale.header.uuid);
    expect(ret.totalAmount).toBe(sale.totalAmount);
  });
});

describe('etaQrPayload', () => {
  it('matches the documented template', () => {
    expect(
      etaQrPayload({
        environment: 'prod',
        uuid: 'abc',
        dateTimeIssued: '2026-10-26T10:00:00Z',
        total: 228,
        rin: '674859545',
      })
    ).toBe(
      'https://invoicing.eta.gov.eg/receipts/search/abc/share/2026-10-26T10:00:00Z#Total:228,IssuerRIN:674859545'
    );
  });
});
