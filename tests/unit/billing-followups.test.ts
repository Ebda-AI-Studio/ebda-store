/**
 * Billing follow-ups (Rulings EBDA-BILLFU-1..3): the InstaPay QR config, the
 * support contact fallback (never an empty wa.me link), and Ebda's own VAT
 * wired into the ONE subscription charge seam.
 *
 * Mutation checks (run by hand, recorded in the PR body):
 *   V1 toChargeVat: return the enabled shape even when `enabled` is false
 *      -> "OFF adds no VAT" goes red.
 *   V2 subscriptionChargeAmount exclusive: drop `+ vatMinor` from the total
 *      -> "exclusive adds 14%" goes red.
 *   V3 subscriptionChargeAmount inclusive: add the VAT on top
 *      -> "inclusive does not change the total" goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND, DEFAULT_PLATFORM_VAT, type PlatformVat } from '@force/shared';

const h = vi.hoisted(() => ({ getPlatformVat: vi.fn() }));
vi.mock('@api/services/platform-vat.service', () => ({ getPlatformVat: h.getPlatformVat }));

const { chargeFor, ledgerVat, resolvePlatformVat, toChargeVat, vatOfPaidAmount } =
  await import('@api/services/billing/charge-amount');
const { instapayQrUrl, supportContact, supportEmail } =
  await import('@api/services/billing/manual-config');
const { subscriptionBillingTemplate } =
  await import('@api/services/email-templates/subscription-billing');

const ON = (mode: 'exclusive' | 'inclusive'): PlatformVat => ({
  enabled: true,
  rate: 14,
  mode,
  trn: '123456789',
  legalName: 'Whisky 11 LLC',
});

beforeEach(() => h.getPlatformVat.mockReset());

describe('Ebda VAT on subscription charges (one seam, read per charge)', () => {
  it('OFF (the default): total equals the plan price exactly, no VAT line', async () => {
    h.getPlatformVat.mockResolvedValue({ ...DEFAULT_PLATFORM_VAT });
    const c = await chargeFor(349000);
    expect(c).toEqual({ totalMinor: 349000, netMinor: 349000, vatMinor: 0, vat: null });
    expect(ledgerVat(c)).toEqual({ vatMinor: 0, vat: null });
  });
  it('OFF with a stored rate/TRN still adds nothing (enabled is the only switch)', async () => {
    h.getPlatformVat.mockResolvedValue({ ...ON('exclusive'), enabled: false });
    expect((await chargeFor(349000)).totalMinor).toBe(349000);
    expect((await resolvePlatformVat()).enabled).toBe(false);
  });
  it('exclusive adds 14% on top and records the split + Ebda TRN/legal name', async () => {
    h.getPlatformVat.mockResolvedValue(ON('exclusive'));
    const c = await chargeFor(349000);
    expect(c.totalMinor).toBe(397860);
    expect(ledgerVat(c)).toEqual({
      vatMinor: 48860,
      vat: {
        netMinor: 349000,
        vatMinor: 48860,
        rateBps: 1400,
        mode: 'exclusive',
        trn: '123456789',
        legalName: 'Whisky 11 LLC',
      },
    });
  });
  it('inclusive does not change the total; VAT is carved out of it', async () => {
    h.getPlatformVat.mockResolvedValue(ON('inclusive'));
    const c = await chargeFor(349000);
    expect(c.totalMinor).toBe(349000);
    expect(c.netMinor + c.vatMinor).toBe(349000);
    expect(c.vatMinor).toBe(42860);
  });
  it('reads the setting on every charge (never cached: it decides money)', async () => {
    h.getPlatformVat.mockResolvedValueOnce({ ...DEFAULT_PLATFORM_VAT });
    h.getPlatformVat.mockResolvedValueOnce(ON('exclusive'));
    expect((await chargeFor(100000)).totalMinor).toBe(100000);
    expect((await chargeFor(100000)).totalMinor).toBe(114000);
  });
  it('a fractional rate converts to basis points exactly', () => {
    expect(toChargeVat({ ...ON('exclusive'), rate: 2.5 }).rateBps).toBe(250);
  });
  it('a recorded manual payment is the gross: VAT carved out in either mode, none when OFF', () => {
    const ex = toChargeVat(ON('exclusive'));
    expect(vatOfPaidAmount(397860, ex)).toMatchObject({ totalMinor: 397860, vatMinor: 48860 });
    expect(vatOfPaidAmount(397860, toChargeVat(DEFAULT_PLATFORM_VAT)).vatMinor).toBe(0);
  });
});

describe('InstaPay QR config', () => {
  it('unset, http or junk -> null (no QR, never a broken image)', () => {
    expect(instapayQrUrl({})).toBeNull();
    expect(instapayQrUrl({ EBDA_INSTAPAY_QR_URL: '   ' })).toBeNull();
    expect(instapayQrUrl({ EBDA_INSTAPAY_QR_URL: 'http://media.ebda.app/q.jpg' })).toBeNull();
    expect(instapayQrUrl({ EBDA_INSTAPAY_QR_URL: 'javascript:alert(1)' })).toBeNull();
    expect(instapayQrUrl({ EBDA_INSTAPAY_QR_URL: 'not a url' })).toBeNull();
  });
  it('an https URL is returned as is', () => {
    expect(
      instapayQrUrl({ EBDA_INSTAPAY_QR_URL: 'https://media.ebda.app/platform/instapay-qr.jpg' })
    ).toBe('https://media.ebda.app/platform/instapay-qr.jpg');
  });
});

describe('support contact (no WhatsApp number yet)', () => {
  it('BRAND support email is the address that actually receives mail', () => {
    expect(BRAND.supportEmail).toBe('hello@ebda.app');
  });
  it('EBDA_SUPPORT_EMAIL overrides; unset or malformed falls back to BRAND', () => {
    expect(supportEmail({})).toBe('hello@ebda.app');
    expect(supportEmail({ EBDA_SUPPORT_EMAIL: 'nope' })).toBe('hello@ebda.app');
    expect(supportEmail({ EBDA_SUPPORT_EMAIL: ' billing@ebda.app ' })).toBe('billing@ebda.app');
  });
  it('WhatsApp unset: no wa.me link, a mailto instead', () => {
    expect(supportContact('Shop', {})).toEqual({
      whatsappUrl: null,
      email: 'hello@ebda.app',
      mailto: 'mailto:hello@ebda.app?subject=Shop',
    });
  });
  it('WhatsApp set: the wa.me link, and the email is still there', () => {
    const c = supportContact(undefined, { EBDA_SUPPORT_WHATSAPP: '01012345678' });
    expect(c.whatsappUrl).toBe('https://wa.me/201012345678');
    expect(c.email).toBe('hello@ebda.app');
  });
});

describe('billing notice email', () => {
  const base = {
    storeName: 'Amelia',
    planName: 'Growth',
    amountMinor: 349000,
    billingUrl: 'https://admin.ebda.app/stores/s1/billing',
    dueOn: '2026-11-20',
    daysLeft: 3,
    method: 'instapay' as const,
    instapayHandle: 'voidengineer911@instapay',
    paymentReference: 'EBD-7K2Q',
  };
  for (const lang of ['en', 'ar'] as const) {
    for (const kind of ['payment_due', 'store_suspended'] as const) {
      it(`${kind} (${lang}): no WhatsApp -> mailto, never an empty wa.me link`, () => {
        const html = subscriptionBillingTemplate[lang]({
          ...base,
          kind,
          whatsappUrl: null,
          supportEmail: 'hello@ebda.app',
        });
        expect(html).toContain('mailto:hello@ebda.app');
        expect(html).not.toContain('wa.me');
      });
    }
    it(`payment_due (${lang}): VAT OFF -> no VAT wording; ON -> VAT line with TRN`, () => {
      const off = subscriptionBillingTemplate[lang]({ ...base, kind: 'payment_due', vat: null });
      expect(off).not.toMatch(/VAT|ضريبة/);
      const on = subscriptionBillingTemplate[lang]({
        ...base,
        kind: 'payment_due',
        amountMinor: 397860,
        vat: {
          netMinor: 349000,
          vatMinor: 48860,
          rateBps: 1400,
          trn: '123456789',
          legalName: 'Whisky 11',
        },
      });
      expect(on).toMatch(lang === 'en' ? /includes VAT 14%/ : /ضريبة القيمة المضافة 14%/);
      expect(on).toContain('123456789');
      expect(on).toContain('Whisky 11');
    });
  }
});
