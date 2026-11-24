/**
 * Every e-mail sent on behalf of the shared identity service (accounts.ebda.app) carries the master brand: the sender display
 * name is "Ebda AI Studio" and the shell names it, never the bare product "Ebda Store" / "Ebda" (Ruling ID-1, brand rule).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));

vi.mock('@api/config', () => ({
  config: { nodeEnv: 'production', adminUrl: 'https://store.ebda.app', resendApiKey: 're_x' },
}));
vi.mock('@api/services/mail-transport', () => ({ isMailTransportConfigured: () => true }));
vi.mock('@api/services/email.service', async () => {
  const actual = await vi.importActual<typeof import('@api/services/email.service')>(
    '@api/services/email.service'
  );
  return {
    ...actual,
    EmailService: { sendPlatformRaw: async (o: Record<string, unknown>) => void h.sent.push(o) },
  };
});
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sendCodeMail, sendNoticeMail } = await import('@api/lib/identity-directory');

beforeEach(() => {
  h.sent = [];
});

const base = { to: 'm@example.com', language: 'en' as const, firstName: 'Mona', ttlMinutes: 30 };

describe('identity-service mail uses the master brand', () => {
  it.each([['email_verify'], ['password_reset'], ['staff_invite'], ['factor_enrol']] as const)(
    '%s: sender display name and shell name are "Ebda AI Studio"',
    async kind => {
      await sendCodeMail({ ...base, kind, code: '123456', storeName: 'Demo' });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].fromName).toBe('Ebda AI Studio');
      const html = String(h.sent[0].html);
      expect(html).toContain('Ebda AI Studio');
      expect(html).not.toMatch(/Ebda Store/);
    }
  );

  it('the "sign-in method added" notice too, in English and Arabic', async () => {
    await sendNoticeMail({
      to: 'm@example.com',
      kind: 'factor_added',
      factor: 'passkey',
      language: 'en',
      firstName: 'M',
    });
    await sendNoticeMail({
      to: 'm@example.com',
      kind: 'factor_added',
      factor: 'totp',
      language: 'ar',
      firstName: 'M',
    });
    expect(h.sent.map(m => m.fromName)).toEqual(['Ebda AI Studio', 'Ebda AI Studio']);
    expect(String(h.sent[0].html)).not.toMatch(/Ebda Store/);
    expect(String(h.sent[1].html)).not.toMatch(/ابدأ ستور/);
  });

  it('the "recovery codes changed" notice: master brand, EN and AR, tells the owner what to do', async () => {
    for (const language of ['en', 'ar'] as const)
      await sendNoticeMail({
        to: 'm@example.com',
        kind: 'recovery_codes_changed',
        language,
        firstName: 'M',
      });
    expect(h.sent.map(m => m.fromName)).toEqual(['Ebda AI Studio', 'Ebda AI Studio']);
    expect(String(h.sent[0].html)).toMatch(/recovery codes/i);
    expect(String(h.sent[0].html)).not.toMatch(/Ebda Store/);
    expect(String(h.sent[1].html)).toContain('أكواد الاسترجاع');
    expect(String(h.sent[1].html)).not.toMatch(/ابدأ ستور/);
  });
});
