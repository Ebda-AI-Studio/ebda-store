/**
 * G6: the Cloudflare Email Service transport (services/mail-transport.ts).
 * Pins the binding payload, RFC 8058 header pass-through, error classification and the
 * "sender is always ebda.app" rule that replaces per-store Resend domains.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  cfg: {},
}));
vi.mock('@api/config', () => ({ config: h.cfg }));

import { setCfBindings, clearCfBindings } from '@api/cf/bindings';
import {
  EmailSendError,
  parseAddress,
  sendMail,
  isMailTransportConfigured,
} from '@api/services/mail-transport';

beforeEach(() => {
  h.send.mockReset();
  clearCfBindings();
  setCfBindings({ EMAIL: { send: h.send } });
});

describe('parseAddress', () => {
  it('splits "Name <addr>" and leaves a bare address alone', () => {
    expect(parseAddress('Ebda <no-reply@ebda.app>')).toEqual({
      email: 'no-reply@ebda.app',
      name: 'Ebda',
    });
    expect(parseAddress('"Souq, Shop" <no-reply@ebda.app>')).toEqual({
      email: 'no-reply@ebda.app',
      name: 'Souq, Shop',
    });
    expect(parseAddress('<no-reply@ebda.app>')).toBe('no-reply@ebda.app');
    expect(parseAddress('متجر القمر <no-reply@ebda.app>')).toEqual({
      email: 'no-reply@ebda.app',
      name: 'متجر القمر',
    });
    // CR/LF never survive: no header injection through a name.
    const inj = parseAddress('Evil\r\nBcc: x@y.z <no-reply@ebda.app>');
    expect(JSON.stringify(inj)).not.toMatch(/\\r|\\n/);
    expect(parseAddress('no-reply@ebda.app')).toBe('no-reply@ebda.app');
  });
});

describe('sendMail on Cloudflare', () => {
  it('passes the message and the RFC 8058 headers to the binding', async () => {
    h.send.mockResolvedValue({ messageId: 'cf-1' });
    const headers = {
      'List-Unsubscribe': '<https://api.ebda.app/u?t=1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
    const r = await sendMail({
      from: 'Shop <no-reply@ebda.app>',
      to: 'a@x.test',
      subject: 'S',
      html: '<p/>',
      text: 't',
      replyTo: 'owner@shop.test',
      headers,
      idempotencyKey: 'ignored-on-cloudflare',
    });
    expect(r).toEqual({ id: 'cf-1' });
    expect(h.send).toHaveBeenCalledWith({
      from: { email: 'no-reply@ebda.app', name: 'Shop' },
      to: 'a@x.test',
      subject: 'S',
      html: '<p/>',
      text: 't',
      replyTo: 'owner@shop.test',
      headers,
    });
  });

  it('omits empty optional fields (an empty headers object is rejected upstream)', async () => {
    h.send.mockResolvedValue({ messageId: 'cf-2' });
    await sendMail({
      from: 'no-reply@ebda.app',
      to: ['a@x.test'],
      subject: 'S',
      html: '<p/>',
      headers: {},
    });
    expect(h.send.mock.calls[0][0]).not.toHaveProperty('headers');
    expect(h.send.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it.each([
    ['E_RECIPIENT_SUPPRESSED', true, false],
    ['E_HEADER_NOT_ALLOWED', true, false],
    ['E_VALIDATION_ERROR', true, false],
    ['E_RATE_LIMIT_EXCEEDED', false, true],
    ['E_DAILY_LIMIT_EXCEEDED', false, true],
    ['E_INTERNAL_SERVER_ERROR', false, false],
    ['E_DELIVERY_FAILED', false, false],
  ])('classifies %s (permanent=%s rateLimit=%s)', async (code, permanent, rateLimit) => {
    h.send.mockRejectedValue(Object.assign(new Error('boom'), { code }));
    const err = await sendMail({ from: 'no-reply@ebda.app', to: 'a@x.test', subject: 'S' }).catch(
      e => e
    );
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.code).toBe(code);
    expect(err.permanent).toBe(permanent);
    expect(err.isRateLimit).toBe(rateLimit);
  });

  it('fails loud, never silently, when the binding is missing', async () => {
    clearCfBindings();
    expect(isMailTransportConfigured()).toBe(false);
    await expect(
      sendMail({ from: 'no-reply@ebda.app', to: 'a@x.test', subject: 'S' })
    ).rejects.toMatchObject({ code: 'E_NO_BINDING' });
  });
});

describe('undeliverable recipients (Ruling WA-LEGACY-1) on the Cloudflare path', () => {
  const base = { from: 'Ebda Store <orders.souq@ebda.app>', subject: 's', html: '<p>x</p>' };

  it('a .invalid recipient is dropped and the binding is never called', async () => {
    const r = await sendMail({ ...base, to: 'wa-201001234567@placeholder.invalid' });
    expect(r).toEqual({ id: 'skipped-undeliverable' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a mixed list keeps only the deliverable address', async () => {
    h.send.mockResolvedValue({ messageId: 'm1' });
    await sendMail({ ...base, to: ['a@placeholder.invalid', 'buyer@example.com'] });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0].to).toEqual(['buyer@example.com']);
  });
});

describe('isBadRecipientError', () => {
  it('matches only a provider rejection of the address itself', async () => {
    const { EmailSendError, isBadRecipientError } = await import('@api/services/mail-transport');
    expect(
      isBadRecipientError(
        new EmailSendError('E_VALIDATION_ERROR', 'Invalid email address: Missing domain or user')
      )
    ).toBe(true);
    expect(isBadRecipientError(new EmailSendError('E_SENDER_NOT_VERIFIED', 'x'))).toBe(false);
    expect(isBadRecipientError(new Error('Invalid email address'))).toBe(false);
  });
});
