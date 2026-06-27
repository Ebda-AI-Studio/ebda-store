import { describe, it, expect } from 'vitest';
import { resolveSender, type StoreSenderShape } from '@api/services/email-sender';

const baseStore = (overrides: Partial<StoreSenderShape> = {}): StoreSenderShape => ({
  name: 'Wady Aljuz',
  domain: null,
  email: null,
  emailSenderLocalPart: 'noreply',
  emailDomainStatus: null,
  ...overrides,
});

describe('resolveSender', () => {
  it('falls back to platform domain when no custom domain', () => {
    const result = resolveSender(baseStore());
    expect(result.from).toBe('Wady Aljuz <noreply@force-ai.co>');
    expect(result.replyTo).toBeUndefined();
  });

  it('falls back when custom domain set but not verified', () => {
    const result = resolveSender(
      baseStore({ domain: 'wadyaljuz.com', emailDomainStatus: 'pending' })
    );
    expect(result.from).toBe('Wady Aljuz <noreply@force-ai.co>');
  });

  it('uses custom domain when verified', () => {
    const result = resolveSender(
      baseStore({ domain: 'wadyaljuz.com', emailDomainStatus: 'verified' })
    );
    expect(result.from).toBe('Wady Aljuz <noreply@wadyaljuz.com>');
  });

  it('honours custom local part on verified domain', () => {
    const result = resolveSender(
      baseStore({
        domain: 'wadyaljuz.com',
        emailDomainStatus: 'verified',
        emailSenderLocalPart: 'hello',
      })
    );
    expect(result.from).toBe('Wady Aljuz <hello@wadyaljuz.com>');
  });

  it('honours custom local part on platform fallback too', () => {
    const result = resolveSender(baseStore({ emailSenderLocalPart: 'orders' }));
    expect(result.from).toBe('Wady Aljuz <orders@force-ai.co>');
  });

  it('sets replyTo to store contact email when present', () => {
    const result = resolveSender(baseStore({ email: 'hi@wadyaljuz.com' }));
    expect(result.replyTo).toBe('hi@wadyaljuz.com');
  });

  it('treats empty-string local part as default noreply', () => {
    const result = resolveSender(baseStore({ emailSenderLocalPart: '' }));
    expect(result.from).toBe('Wady Aljuz <noreply@force-ai.co>');
  });

  it('strips CRLF from store name to prevent header injection', () => {
    const result = resolveSender(baseStore({ name: 'Wady\r\nBcc: attacker@example.com' }));
    expect(result.from).toBe('Wady  Bcc: attacker@example.com <noreply@force-ai.co>');
  });

  it('strips ASCII control chars from store name', () => {
    const result = resolveSender(baseStore({ name: 'Wady\x00Aljuz\x07' }));
    expect(result.from).toBe('Wady Aljuz <noreply@force-ai.co>');
  });
});
