/**
 * Ruling FU46-1a (Ahmad 2026-10-15, option 1): order emails carrying shopper PII never go to
 * Ebda's own address. Before, every store's "new order" alert (customer name, email, items) and
 * "refund processed" alert were sent to `config.smtpFromEmail`.
 *   - the separate new-order alert is gone: a store that set `settings.orderInvoiceEmail` already
 *     gets the order's invoice there, which is the notice;
 *   - the refund alert goes to the address the caller passes (the store's order address).
 * The one remaining platform-inbox send is the storefront contact form's last fallback (FU46-1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sent = vi.hoisted(() => [] as Array<{ to: string }>);
vi.mock('@api/services/email-queue.service', () => ({
  enqueueEmail: vi.fn(async (m: { to: string }) => void sent.push(m)),
  emailQueue: { enqueue: vi.fn(async (m: { to: string }) => void sent.push(m)) },
}));

import { EmailService } from '@api/services/email.service';
import { config } from '@api/config';

const ROOT = join(__dirname, '../..');

beforeEach(() => {
  sent.length = 0;
});

describe('order alert emails never go to the platform inbox (FU46-1a)', () => {
  it('the refund alert is addressed to the store order address it is given', async () => {
    const spy = vi
      .spyOn(
        EmailService as unknown as { sendPlatform: (...a: unknown[]) => Promise<void> },
        'sendPlatform'
      )
      .mockResolvedValue(undefined);
    await EmailService.sendAdminRefund({
      to: 'orders@store.test',
      orderNumber: 'ORD-9',
      amount: 1000,
      currency: 'EGP',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [msg] = spy.mock.calls[0] as [{ to: string }];
    expect(msg.to).toBe('orders@store.test');
    expect(msg.to).not.toBe(config.smtpFromEmail);
    spy.mockRestore();
  });

  it('there is no new-order alert to the platform any more', () => {
    expect((EmailService as unknown as Record<string, unknown>).sendAdminNewOrder).toBeUndefined();
    const fanout = readFileSync(
      join(ROOT, 'apps/api/src/lib/inngest/functions/order-created.ts'),
      'utf8'
    );
    expect(fanout).not.toMatch(/send-admin-new-order|sendAdminNewOrder/);
  });

  it('the only send to config.smtpFromEmail left is the contact-form fallback', () => {
    const src = readFileSync(join(ROOT, 'apps/api/src/services/email.service.ts'), 'utf8');
    const sites = [...src.matchAll(/to:\s*config\.smtpFromEmail/g)].map(m => {
      const before = src.slice(0, m.index);
      return /static async (\w+)\([^]*$/.exec(
        before.slice(before.lastIndexOf('static async '))
      )![1];
    });
    expect(sites).toEqual(['sendContactForm']);
  });
});
