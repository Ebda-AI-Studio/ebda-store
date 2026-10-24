import { describe, it, expect, vi } from 'vitest';

// Per-store sender domains exist only on the legacy provider (G6); this suite pins that path.
vi.mock('@api/config', () => ({ config: { emailProvider: 'resend', resendApiKey: '' } }));

import { resolveSender, type StoreSenderShape } from '@api/services/email-sender';

const baseStore = (overrides: Partial<StoreSenderShape> = {}): StoreSenderShape => ({
  name: 'Demo Shop',
  domain: null,
  email: null,
  emailSenderLocalPart: 'noreply',
  emailDomainStatus: null,
  ...overrides,
});

describe('resolveSender', () => {
  it('falls back to platform domain when no custom domain', () => {
    const result = resolveSender(baseStore());
    expect(result.from).toBe('Demo Shop <noreply@ebda.app>');
    expect(result.replyTo).toBeUndefined();
  });

  it('falls back when custom domain set but not verified', () => {
    const result = resolveSender(
      baseStore({ domain: 'demo-shop.example', emailDomainStatus: 'pending' })
    );
    expect(result.from).toBe('Demo Shop <noreply@ebda.app>');
  });

  it('uses custom domain when verified', () => {
    const result = resolveSender(
      baseStore({ domain: 'demo-shop.example', emailDomainStatus: 'verified' })
    );
    expect(result.from).toBe('Demo Shop <noreply@demo-shop.example>');
  });

  it('honours custom local part on verified domain', () => {
    const result = resolveSender(
      baseStore({
        domain: 'demo-shop.example',
        emailDomainStatus: 'verified',
        emailSenderLocalPart: 'hello',
      })
    );
    expect(result.from).toBe('Demo Shop <hello@demo-shop.example>');
  });

  it('honours custom local part on platform fallback too', () => {
    const result = resolveSender(baseStore({ emailSenderLocalPart: 'orders' }));
    expect(result.from).toBe('Demo Shop <orders@ebda.app>');
  });

  it('sets replyTo to store contact email when present', () => {
    const result = resolveSender(baseStore({ email: 'hi@demo-shop.example' }));
    expect(result.replyTo).toBe('hi@demo-shop.example');
  });

  it('treats empty-string local part as default noreply', () => {
    const result = resolveSender(baseStore({ emailSenderLocalPart: '' }));
    expect(result.from).toBe('Demo Shop <no-reply@ebda.app>');
  });

  it('strips CRLF from store name to prevent header injection', () => {
    const result = resolveSender(baseStore({ name: 'Demo Shop\r\nBcc: attacker@example.com' }));
    expect(result.from).toBe('Demo Shop  Bcc: attacker@example.com <noreply@ebda.app>');
  });

  it('strips ASCII control chars from store name', () => {
    const result = resolveSender(baseStore({ name: 'Demo\x00Shop\x07' }));
    expect(result.from).toBe('Demo Shop <noreply@ebda.app>');
  });
});
