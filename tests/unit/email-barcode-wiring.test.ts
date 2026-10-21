/**
 * The order confirmation email asks for the barcode PNG with the merchant's
 * shape, embeds it when ready, and goes out text-only when it is not: the
 * email is never blocked, never fails, by the image.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeFind, ensure } = vi.hoisted(() => ({ storeFind: vi.fn(), ensure: vi.fn() }));
vi.mock('@ebda/database', () => {
  const prisma = { store: { findUnique: storeFind } };
  return { prisma, withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma) };
});
vi.mock('@api/services/resend.service', () => ({
  ResendService: { sendBrandedEmail: vi.fn().mockResolvedValue({ id: 'em' }) },
}));
vi.mock('@api/services/barcode-image.service', () => ({ ensureEmailBarcode: ensure }));
vi.mock('@api/config', () => ({
  config: {
    resendApiKey: 're_test',
    webUrl: 'https://s.test',
    adminUrl: 'https://a.test',
    smtpFromEmail: 'n@test.com',
  },
}));

import { EmailService, type OrderEmailData } from '@api/services/email.service';
import { ResendService } from '@api/services/resend.service';

const data: OrderEmailData = {
  orderNumber: 'ORD-T5JK9Q-AB3XY',
  customerName: 'Mona',
  customerEmail: 'm@example.com',
  items: [{ name: 'Shirt', quantity: 1, price: 100 }],
  subtotal: 100,
  tax: 0,
  shipping: 0,
  total: 100,
  shippingAddress: {
    firstName: 'M',
    lastName: 'A',
    address1: 'x',
    city: 'c',
    state: 's',
    postalCode: '',
    country: 'Egypt',
  },
};
const store = (settings: object) => ({
  id: '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d',
  name: 'S',
  nameAr: 'م',
  logo: null,
  theme: {},
  email: null,
  phone: null,
  domain: null,
  emailSenderLocalPart: 'noreply',
  emailDomainStatus: null,
  whatsapp: null,
  settings,
});
const html = () => vi.mocked(ResendService.sendBrandedEmail).mock.calls.at(-1)![1].html as string;
const IMG = {
  url: 'https://cdn.ebda.app/stores/x/barcodes/0123456789abcdef0123456789abcdef.png',
  width: 360,
  height: 130,
};
const SID = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';

beforeEach(() => vi.clearAllMocks());

describe('sendOrderConfirmation + barcode png', () => {
  it('asks for the merchant shape (default plain) and embeds the image', async () => {
    storeFind.mockResolvedValue(store({ receiptBarcodeShape: 'palm' }));
    ensure.mockResolvedValue(IMG);
    await EmailService.sendOrderConfirmation(SID, data, 'ar');
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: SID,
        kind: 'order',
        number: data.orderNumber,
        shape: 'palm',
      })
    );
    expect(html()).toContain(`src="${IMG.url}"`);
    expect(html()).toContain('alt="رقم الطلب ORD-T5JK9Q-AB3XY"');
    storeFind.mockResolvedValue(store({}));
    await EmailService.sendOrderConfirmation(SID, data, 'en');
    expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ shape: 'plain' }));
  });
  it('not ready or render failed: the email still goes out, text only', async () => {
    storeFind.mockResolvedValue(store({}));
    ensure.mockResolvedValue(null);
    await EmailService.sendOrderConfirmation(SID, data, 'en');
    expect(html()).not.toContain('<img');
    expect(html()).toContain('ORD-T5JK9Q-AB3XY');
    ensure.mockRejectedValue(new Error('boom'));
    await expect(EmailService.sendOrderConfirmation(SID, data, 'en')).resolves.toBeUndefined();
    expect(vi.mocked(ResendService.sendBrandedEmail)).toHaveBeenCalledTimes(2);
  });
  it('shape off never asks for an image', async () => {
    storeFind.mockResolvedValue(store({ receiptBarcodeShape: 'off' }));
    await EmailService.sendOrderConfirmation(SID, data, 'en');
    expect(ensure).not.toHaveBeenCalled();
    expect(html()).not.toContain('<img');
  });
});
