/**
 * Unit test — return emails ride the durable Redis retry queue.
 *
 * CLAUDE.md: "Order-lifecycle emails route through the durable Redis retry
 * queue (`email-queue.service`, `{ queue: true }`)." The return emails were
 * the odd ones out: they called Resend inline from a detached promise, so a
 * transient Resend failure vanished into a logging `.catch` with no retry —
 * on top of never reaching Resend at all under a tenant transaction (P2028).
 *
 * Asserted here: both return emails hand off to `emailQueue.enqueue` and do
 * NOT call Resend inline. Remove `{ queue: true }` from either call in
 * email.service.ts and its assertion reddens.
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

describe('return emails use the durable queue', () => {
  it('sendReturnConfirmation enqueues rather than calling Resend inline', async () => {
    await EmailService.sendReturnConfirmation(
      STORE_ID,
      {
        email: 'buyer@example.com',
        customerName: 'Bay Er',
        storeName: 'Probe Store',
        returnNumber: 'RET-1',
        orderNumber: 'ORD-1001',
        type: 'refund',
      },
      'en'
    );

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toBe(STORE_ID);
    expect(enqueueMock.mock.calls[0][1]).toMatchObject({ to: 'buyer@example.com' });
    expect(sendBrandedEmailMock).not.toHaveBeenCalled();
  });

  it('sendReturnStatusUpdate enqueues rather than calling Resend inline', async () => {
    await EmailService.sendReturnStatusUpdate(
      STORE_ID,
      {
        email: 'buyer@example.com',
        customerName: 'Bay Er',
        storeName: 'Probe Store',
        returnNumber: 'RET-1',
        status: 'approved',
      },
      'en'
    );

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toBe(STORE_ID);
    expect(sendBrandedEmailMock).not.toHaveBeenCalled();
  });
});
