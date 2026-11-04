/** BE:S-19: a flood of bad billing-webhook signatures cannot grow audit_logs without bound. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@api/services/billing', () => ({ BillingSignatureError: class extends Error {} }));
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  handleBillingWebhook: vi.fn(),
}));

const { allowBadSignatureAudit } = await import('@api/routes/billing-webhook.routes');

describe('allowBadSignatureAudit', () => {
  it('allows a handful per source per minute, then refuses', () => {
    const t = 1_000_000;
    const results = Array.from({ length: 8 }, () => allowBadSignatureAudit('1.2.3.4', t));
    expect(results).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('a different source has its own budget, and the window reopens', () => {
    const t = 2_000_000;
    for (let i = 0; i < 10; i++) allowBadSignatureAudit('9.9.9.9', t);
    expect(allowBadSignatureAudit('9.9.9.9', t + 1)).toBe(false);
    expect(allowBadSignatureAudit('5.5.5.5', t + 1)).toBe(true);
    expect(allowBadSignatureAudit('9.9.9.9', t + 60_001)).toBe(true);
  });
});
