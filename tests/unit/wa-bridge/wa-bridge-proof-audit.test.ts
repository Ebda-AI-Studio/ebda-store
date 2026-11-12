/**
 * WA-1 regression: the REAL do-port `attachProof` must hand the audit trail a reference with no signature. Reverting
 * `mediaRef: proofRef(mediaUrl)` to the raw URL turns this red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const audit = vi.fn(async (_e: unknown) => undefined);
vi.mock('../../../apps/api/src/middleware/security', () => ({
  auditLog: (e: unknown) => audit(e),
}));
vi.mock('../../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async () => ({
    db: { payment: { findFirst: async () => ({ id: 'pay-1' }) } },
  }),
  storeMoney: vi.fn(),
  storeWriter: vi.fn(),
}));
vi.mock('../../../apps/api/src/lib/buyer-identity', () => ({ ANONYMOUS_BUYER: 'anon' }));
vi.mock('../../../apps/api/src/config', () => ({ config: {} }));
vi.mock('../../../apps/api/src/lib/definer', () => ({ lookupStore: vi.fn() }));
vi.mock('../../../apps/api/src/lib/wa/link', () => ({ isWhatsAppLinked: vi.fn() }));
vi.mock('../../../apps/api/src/lib/wa/store-events-consumer', () => ({ applyCodOutcome: vi.fn() }));
vi.mock('../../../apps/api/src/services/payment-providers/payment.factory', () => ({
  PaymentService: {},
}));
vi.mock('../../../apps/api/src/services/payment-providers/instapay.service', () => ({
  InstapayService: {},
}));
vi.mock('../../../apps/api/src/services/payment-providers/webhook-url', () => ({
  paymentWebhookUrl: vi.fn(),
}));
vi.mock('../../../apps/api/src/lib/payment-line-items', () => ({ buildPaymentLineItems: vi.fn() }));
vi.mock('../../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { createDoPort } from '../../../apps/api/src/lib/wa/bridge/do-port';

beforeEach(() => audit.mockClear());

describe('attachProof audit row (WA-1)', () => {
  it('never carries the signed proof URL, its signature or its query', async () => {
    const url = 'https://chat.ebda.app/media/m1?sig=SUPERSECRETSIG&exp=1762900000#x';
    expect(await createDoPort().attachProof('s1', 'o1', url)).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = JSON.stringify(audit.mock.calls[0]![0]);
    expect(entry).not.toMatch(/SUPERSECRETSIG|sig=|exp=|mediaUrl/);
    expect(entry).toContain('https://chat.ebda.app/media/m1');
  });
});
