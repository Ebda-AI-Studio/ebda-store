import { describe, expect, it } from 'vitest';
import { webhookUrlErrorKey } from './url-error';

describe('webhookUrlErrorKey', () => {
  it('maps the shared schema reason on the url field', () => {
    expect(
      webhookUrlErrorKey({ code: 'VALIDATION_ERROR', details: { url: ['https_required'] } })
    ).toBe('https_required');
    expect(
      webhookUrlErrorKey({ code: 'VALIDATION_ERROR', details: { url: ['ip_literal_not_allowed'] } })
    ).toBe('ip_literal_not_allowed');
  });
  it('an unknown url issue is still a url problem; another field is not', () => {
    expect(webhookUrlErrorKey({ code: 'VALIDATION_ERROR', details: { url: ['Required'] } })).toBe(
      'invalid'
    );
    expect(
      webhookUrlErrorKey({ code: 'VALIDATION_ERROR', details: { events: ['too small'] } })
    ).toBeNull();
  });
  it('maps the live-check reasons', () => {
    expect(
      webhookUrlErrorKey({
        code: 'WEBHOOK_URL_REJECTED',
        details: { reason: 'host resolves to a private address' },
      })
    ).toBe('private_address');
    expect(
      webhookUrlErrorKey({
        code: 'WEBHOOK_URL_REJECTED',
        details: { reason: 'DNS_UNRESOLVED: host lookup failed' },
      })
    ).toBe('dns_unresolved');
    expect(webhookUrlErrorKey({ code: 'WEBHOOK_URL_REJECTED', details: { reason: 'x' } })).toBe(
      'rejected'
    );
    expect(webhookUrlErrorKey({ code: 'NOT_FOUND' })).toBeNull();
  });
});
