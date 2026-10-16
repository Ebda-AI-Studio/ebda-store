/**
 * Storefront contact messages go to the STORE (Ruling FU46-1). Before: every store's shopper
 * messages were emailed to Ebda's own sender address (config.smtpFromEmail, BRAND.noReplyEmail by
 * default) — merchants never saw them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { targetMock, sendStoreMock, sendPlatformMock } = vi.hoisted(() => ({
  targetMock: vi.fn(),
  sendStoreMock: vi.fn(async () => undefined),
  sendPlatformMock: vi.fn(async () => undefined),
}));

vi.mock('@api/services/store-contact.service', () => ({ storeContactTarget: targetMock }));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendStoreContactMessage: sendStoreMock, sendContactForm: sendPlatformMock },
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})) } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import logger from '@api/lib/logger';
import { handleContactFormSubmitted } from '@api/lib/inngest/functions/contact-form-send';

const MESSAGE = {
  name: 'Mona',
  email: 'mona@example.test',
  subject: 'Size question',
  message: 'Do you have it in M?',
};
const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };
const event = (data: Record<string, unknown>) => ({ name: 'contact/form.submitted', data });

describe('contact-form-send (FU46-1)', () => {
  beforeEach(() => {
    targetMock.mockReset();
    sendStoreMock.mockClear();
    sendPlatformMock.mockClear();
  });

  it("sends to the store's contact email, from the store's sender", async () => {
    targetMock.mockResolvedValue({ to: 'shop@example.test', isDemo: false, slug: 'shop' });
    await handleContactFormSubmitted({ event: event({ storeId: 's1', ...MESSAGE }), step });
    expect(targetMock).toHaveBeenCalledWith('s1');
    expect(sendStoreMock).toHaveBeenCalledWith('s1', 'shop@example.test', MESSAGE);
    expect(sendPlatformMock).not.toHaveBeenCalled();
  });

  it("a store with no usable address sends NO mail anywhere (never Ebda's inbox) and does not throw (FU46-1c)", async () => {
    targetMock.mockResolvedValue({ to: null, isDemo: false, slug: 'shop' });
    await handleContactFormSubmitted({ event: event({ storeId: 's1', ...MESSAGE }), step });
    expect(sendStoreMock).not.toHaveBeenCalled();
    expect(sendPlatformMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('mona@example.test');
    expect(logged).not.toContain('Do you have it in M?');
  });

  it('a store that is gone or became a demo store sends nothing and does not throw', async () => {
    targetMock.mockResolvedValueOnce(null);
    await handleContactFormSubmitted({ event: event({ storeId: 's1', ...MESSAGE }), step });
    targetMock.mockResolvedValueOnce({ to: 'x@example.test', isDemo: true, slug: 'demo' });
    await handleContactFormSubmitted({ event: event({ storeId: 's2', ...MESSAGE }), step });
    expect(sendStoreMock).not.toHaveBeenCalled();
    expect(sendPlatformMock).not.toHaveBeenCalled();
  });

  it('an event enqueued before FU46-1 (no storeId) is dropped, not mailed to the platform (FU46-1c)', async () => {
    await handleContactFormSubmitted({ event: event({ ...MESSAGE }), step });
    expect(targetMock).not.toHaveBeenCalled();
    expect(sendPlatformMock).not.toHaveBeenCalled();
    expect(sendStoreMock).not.toHaveBeenCalled();
  });

  it('a send failure is rethrown so Inngest retries and dead-letters', async () => {
    targetMock.mockResolvedValue({ to: 'shop@example.test', isDemo: false, slug: 'shop' });
    sendStoreMock.mockRejectedValueOnce(new Error('resend down'));
    await expect(
      handleContactFormSubmitted({ event: event({ storeId: 's1', ...MESSAGE }), step })
    ).rejects.toThrow('resend down');
  });

  it('logs a provider error with addresses scrubbed, never the raw error (D8)', async () => {
    targetMock.mockResolvedValue({ to: 'shop@example.test', isDemo: false, slug: 'shop' });
    sendStoreMock.mockRejectedValueOnce(new Error('rejected recipient shop@example.test'));
    await expect(
      handleContactFormSubmitted({ event: event({ storeId: 's1', ...MESSAGE }), step })
    ).rejects.toThrow();
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain('shop@example.test');
    expect(logged).not.toContain('mona@example.test');
  });
});
