import { describe, it, expect } from 'vitest';
import { resolveOrderInvoiceRecipient } from '@api/lib/inngest/functions/order-created';

describe('resolveOrderInvoiceRecipient — opt-in per-store owner invoice', () => {
  it('returns the trimmed email when settings.orderInvoiceEmail is a non-empty string', () => {
    expect(resolveOrderInvoiceRecipient({ orderInvoiceEmail: 'buyer@example.com' })).toBe(
      'buyer@example.com'
    );
    expect(resolveOrderInvoiceRecipient({ orderInvoiceEmail: '  owner@store.com  ' })).toBe(
      'owner@store.com'
    );
  });

  it('returns null (no owner invoice) when unset, empty, or not a string — opt-in only', () => {
    expect(resolveOrderInvoiceRecipient({})).toBeNull();
    expect(resolveOrderInvoiceRecipient({ orderInvoiceEmail: '' })).toBeNull();
    expect(resolveOrderInvoiceRecipient({ orderInvoiceEmail: '   ' })).toBeNull();
    expect(resolveOrderInvoiceRecipient({ orderInvoiceEmail: 123 })).toBeNull();
    expect(resolveOrderInvoiceRecipient(null)).toBeNull();
    expect(resolveOrderInvoiceRecipient(undefined)).toBeNull();
    expect(resolveOrderInvoiceRecipient('nope')).toBeNull();
  });
});
