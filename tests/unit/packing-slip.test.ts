/**
 * Packing slip HTML: content, no money, barcode in the store's shape at slip
 * size, A4 / 4x6 label print CSS, RTL, tenant scoping and the 100-order cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
let lastRows: Array<{ store?: unknown }> = [];
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    order: {
      findMany: async (...a: unknown[]) => {
        lastRows = await findMany(...a);
        return lastRows;
      },
    },
    // `Store` is a platform row: read beside the order, here from the first row the mock returned
    store: { findUnique: async () => lastRows[0]?.store ?? null },
  }),
}));

const { PackingSlipService, PACKING_SLIP_MAX_ORDERS } =
  await import('@api/services/packing-slip.service');

const STORE = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';

const order = (id: string, n: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: n,
  locale: 'en',
  createdAt: new Date('2026-10-21T10:00:00Z'),
  customerNotes: 'Please gift wrap, from Sara',
  notes: 'INTERNAL: customer is a fraud risk',
  subtotal: 1234500,
  shipping: 55500,
  discount: 0,
  total: 1290000,
  currency: 'EGP',
  shippingAddress: {
    firstName: 'Mona',
    lastName: 'Ali',
    phone: '+201012345678',
    address1: '12 Tahrir St',
    city: 'Dokki',
    state: 'Giza',
    country: 'Egypt',
  },
  store: {
    name: 'Nile Store',
    nameAr: 'متجر النيل',
    logo: 'https://cdn.ebda.app/stores/x/logos/a.png',
    timezone: 'Africa/Cairo',
    settings: { packingSlipNote: 'Thanks for shopping with us!' },
  },
  items: [
    {
      id: 'l1',
      productName: 'Linen abaya',
      variantName: 'Sand / M / 54 cm',
      variantNameAr: 'رملي / M / 54 سم',
      sku: 'ABA-SND-M',
      quantity: 2,
      price: 987654,
      personalisation: 'Sara',
      bundleGroupId: null,
      product: {
        nameAr: 'عباية كتان',
        images: [{ url: 'https://cdn.ebda.app/stores/x/products/p.jpg' }],
      },
    },
    {
      id: 'l2',
      productName: 'Scarf',
      variantName: null,
      sku: 'SCF-1',
      quantity: 1,
      price: 22500,
      bundleGroupId: null,
      product: { nameAr: 'طرحة', images: [] },
    },
  ],
  ...over,
});

beforeEach(() => findMany.mockReset().mockResolvedValue([order(O1, 'ORD-T5JK9Q-AB3XY')]));

describe('packing slip content', () => {
  it('has logo, store, number + barcode, date, ship-to, items with thumb/variant/sku/qty/tick, count, notes, footer', async () => {
    const html = await PackingSlipService.generate(STORE, [O1], { size: 'a4' });
    expect(html).toContain('src="https://cdn.ebda.app/stores/x/logos/a.png"');
    expect(html).toContain('Nile Store');
    expect(html).toContain('ORD-T5JK9Q-AB3XY');
    expect(html).toContain('<bdi dir="ltr"><svg'); // plain barcode by default, LTR
    expect(html).toMatch(/21 October 2026|21 Oct 2026|2026/);
    expect(html).toContain('Mona Ali');
    expect(html).toContain('12 Tahrir St');
    expect(html).toContain('+201012345678');
    expect(html).toContain('Linen abaya');
    expect(html).toContain('Sand / M / 54 cm');
    expect(html).toContain('ABA-SND-M');
    expect(html).toContain('src="https://cdn.ebda.app/stores/x/products/p.jpg"');
    expect((html.match(/class="tick"/g) ?? []).length).toBe(2); // one tick box per line
    expect(html).toMatch(/Items:?\s*(<[^>]+>)*\s*3/); // 2 + 1
    expect(html).toContain('Please gift wrap, from Sara');
    expect(html).toContain('Sara'); // personalisation
    expect(html).toContain('Thanks for shopping with us!');
  });
  it('NEVER prints a price, total, currency or the internal admin notes', async () => {
    const html = await PackingSlipService.generate(STORE, [O1], { size: 'a4' });
    for (const bad of [
      '9876.54',
      '987654',
      '12,345',
      '12345.00',
      '1290000',
      '12900',
      '555',
      'EGP',
      'Total',
      'Subtotal',
      'Shipping',
      'Price',
      'ج.م',
      'السعر',
      'الإجمالي',
      'INTERNAL',
      'fraud',
    ]) {
      expect(html, bad).not.toContain(bad);
    }
  });
  it('no colour that is not ink on white (never orange)', async () => {
    const html = (await PackingSlipService.generate(STORE, [O1], { size: 'a4' })).toLowerCase();
    expect(html).not.toContain('#ff6e01');
    expect(html).not.toMatch(/background:\s*#(?!fff)/);
  });
  it('Arabic: RTL document, Arabic names, LTR barcode/number/phone', async () => {
    const html = await PackingSlipService.generate(STORE, [O1], { size: 'a4', locale: 'ar' });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain('متجر النيل');
    expect(html).toContain('عباية كتان');
    expect(html).toContain('رملي / M / 54 سم');
    expect(html).toContain('<bdi dir="ltr"><svg');
    expect(html).toMatch(/<bdi dir="ltr">\+201012345678<\/bdi>/);
  });
  it('escapes everything it prints', async () => {
    findMany.mockResolvedValue([
      order(O1, 'ORD-T5JK9Q-AB3XY', {
        customerNotes: '<script>alert(1)</script>',
        shippingAddress: { firstName: '<b>x</b>', lastName: 'y', phone: '1' },
      }),
    ]);
    const html = await PackingSlipService.generate(STORE, [O1], { size: 'a4' });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('barcode on the slip', () => {
  it('uses the merchant shape when it meets the size floor (palm at A4), plain when not (label)', async () => {
    const withShape = (shape: string) => ({
      store: { ...order(O1, 'x').store, settings: { receiptBarcodeShape: shape } },
    });
    findMany.mockResolvedValue([order(O1, 'ORD-T5JK9Q-AB3XY', withShape('palm'))]);
    expect(await PackingSlipService.generate(STORE, [O1], { size: 'a4' })).toContain('<mask');
    expect(await PackingSlipService.generate(STORE, [O1], { size: 'label' })).not.toContain(
      '<mask'
    ); // 320px: palm < 2px/module
    findMany.mockResolvedValue([order(O1, 'ORD-T5JK9Q-AB3XY', withShape('off'))]);
    const off = await PackingSlipService.generate(STORE, [O1], { size: 'a4' });
    expect(off).not.toContain('<svg');
    expect(off).toContain('ORD-T5JK9Q-AB3XY'); // the number is still printed
  });
});

describe('format and print css', () => {
  it('A4 by default with a page break between orders; the last has none', async () => {
    findMany.mockResolvedValue([order(O1, 'ORD-T5JK9Q-AB3XY'), order(O2, 'ORD-T5JK9R-CD4EF')]);
    const html = await PackingSlipService.generate(STORE, [O1, O2], { size: 'a4' });
    expect(html).toContain('size: A4');
    expect((html.match(/<section class="slip"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/\.slip\s*{[^}]*break-after:\s*page/);
    expect(html).toMatch(/\.slip:last-child\s*{[^}]*break-after:\s*auto/);
  });
  it('4x6 label size', async () => {
    const html = await PackingSlipService.generate(STORE, [O1], { size: 'label' });
    expect(html).toContain('size: 4in 6in');
    expect(html).not.toContain('size: A4');
  });
});

describe('tenant scoping and caps', () => {
  it('queries by the caller store and the ids, soft-deleted excluded; foreign/missing ids print nothing', async () => {
    findMany.mockResolvedValue([order(O1, 'ORD-T5JK9Q-AB3XY')]); // O2 belongs to another store: the scoped query does not return it
    const html = await PackingSlipService.generate(STORE, [O1, O2], { size: 'a4' });
    const where = findMany.mock.calls[0]![0].where;
    expect(where.storeId).toBe(STORE);
    expect(where.id.in).toEqual([O1, O2]);
    expect(where.deletedAt).toBeNull();
    expect((html.match(/<section class="slip"/g) ?? []).length).toBe(1);
  });
  it('404 when none of the orders belong to the store', async () => {
    findMany.mockResolvedValue([]);
    await expect(PackingSlipService.generate(STORE, [O2], { size: 'a4' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
  it('caps a bulk print at 100 orders, de-duplicates ids, rejects an empty list', async () => {
    expect(PACKING_SLIP_MAX_ORDERS).toBe(100);
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    await expect(PackingSlipService.generate(STORE, many, { size: 'a4' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(PackingSlipService.generate(STORE, [], { size: 'a4' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await PackingSlipService.generate(STORE, [O1, O1], { size: 'a4' });
    expect(findMany.mock.calls.at(-1)![0].where.id.in).toEqual([O1]);
  });
});

describe('skipped ids (M4)', () => {
  it('generateDetailed reports requested ids that printed nothing (other store, deleted)', async () => {
    findMany.mockResolvedValue([order(O1, 'ORD-T5JK9Q-AB3XY')]);
    const r = await PackingSlipService.generateDetailed(STORE, [O1, O2], { size: 'a4' });
    expect(r.skippedIds).toEqual([O2]);
    expect(r.html).toContain('ORD-T5JK9Q-AB3XY');
    findMany.mockResolvedValue([order(O1, 'N-1'), order(O2, 'N-2')]);
    expect(
      (await PackingSlipService.generateDetailed(STORE, [O1, O2], { size: 'a4' })).skippedIds
    ).toEqual([]);
  });
});
