/**
 * #1935 — the customer's "Refund issued" email rides the durable Redis retry
 * queue, like every other order-lifecycle email. It is the ONE refund notice
 * a customer gets (order-refunded.ts claims it once per order), and it was
 * sent inline: a transient Resend failure vanished into the fanout's
 * swallowing Promise.allSettled with the claim already written.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, enqueueMock, sendBrandedEmailMock } = vi.hoisted(() => ({
  prismaMock: { store: { findUnique: vi.fn() } },
  enqueueMock: vi.fn().mockResolvedValue('email_test_1'),
  sendBrandedEmailMock: vi.fn().mockResolvedValue({ id: 'resend-1' }),
}));

vi.mock('@force/database', () => ({ prisma: prismaMock }));
vi.mock('@api/services/email-queue.service', () => ({
  emailQueue: { enqueue: enqueueMock },
}));
vi.mock('@api/services/resend.service', () => ({
  ResendService: { sendBrandedEmail: sendBrandedEmailMock },
}));

import { EmailService } from '@api/services/email.service';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  // Two reads happen: the subject/locale lookup, then sendForStore's own
  // branding read. One resolved shape satisfies both.
  prismaMock.store.findUnique.mockResolvedValue({
    id: STORE_ID,
    name: 'Probe Store',
    nameAr: null,
    logo: null,
    theme: null,
    email: null,
    phone: null,
    address: null,
    settings: {},
    domain: null,
    emailSenderLocalPart: null,
    emailDomainStatus: null,
  });
});

describe('the refund email uses the durable queue (#1935)', () => {
  it('sendOrderRefunded enqueues rather than calling Resend inline', async () => {
    await EmailService.sendOrderRefunded(
      STORE_ID,
      {
        orderNumber: 'ORD-1001',
        customerName: 'Bay Er',
        customerEmail: 'buyer@example.com',
        orderTotal: 12000,
        refundAmount: 12000,
      },
      'en'
    );

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toBe(STORE_ID);
    expect(enqueueMock.mock.calls[0][1]).toMatchObject({ to: 'buyer@example.com' });
    expect(sendBrandedEmailMock).not.toHaveBeenCalled();
  });

  it('a guest order with no email address sends nothing (control)', async () => {
    await EmailService.sendOrderRefunded(STORE_ID, {
      orderNumber: 'ORD-1001',
      customerName: 'Guest',
      customerEmail: '',
      orderTotal: 12000,
      refundAmount: 12000,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(sendBrandedEmailMock).not.toHaveBeenCalled();
  });
});
