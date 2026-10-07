/**
 * Ebda's OWN VAT on subscriptions (ruling TAX-6) + the shared VAT-gate shapes.
 *
 * `getPlatformVat()` is the single server function subscription billing reads.
 * Fail closed: no row, or a row that no longer parses, is OFF. Enabling needs
 * Ebda's TRN and legal name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_PLATFORM_VAT,
  normalizeTaxRegistrationNumber,
  platformVatSchema,
  taxProfileDetailsSchema,
} from '@force/shared';

const findUnique = vi.fn();
vi.mock('@force/database', () => ({
  prisma: { systemSetting: { findUnique: (...a: unknown[]) => findUnique(...a) } },
  withUser: (_u: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { getPlatformVat } = await import('@api/services/platform-vat.service');
const { sniffTaxDocumentMime } = await import('@api/services/tax-profile.service');

describe('getPlatformVat — default OFF, fail closed', () => {
  beforeEach(() => findUnique.mockReset());

  it('no row: OFF at 14% exclusive, no TRN', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getPlatformVat()).toEqual({
      enabled: false,
      rate: 14,
      mode: 'exclusive',
      trn: null,
      legalName: null,
    });
    expect(findUnique.mock.calls[0][0].where).toEqual({ key: 'ebda.vat' });
  });

  it('a malformed row (enabled without a TRN) is OFF, never ON', async () => {
    findUnique.mockResolvedValue({
      value: { enabled: true, rate: 14, mode: 'exclusive', trn: null, legalName: null },
    });
    expect((await getPlatformVat()).enabled).toBe(false);
  });

  it('a valid ON row is returned as stored', async () => {
    const v = {
      enabled: true,
      rate: 14,
      mode: 'inclusive',
      trn: '987654321',
      legalName: 'Whisky 11 LLC',
    };
    findUnique.mockResolvedValue({ value: v });
    expect(await getPlatformVat()).toEqual(v);
  });
});

describe('platformVatSchema', () => {
  it('refuses enabling without the TRN and legal name', () => {
    expect(platformVatSchema.safeParse({ ...DEFAULT_PLATFORM_VAT, enabled: true }).success).toBe(
      false
    );
  });
  it('accepts OFF with nothing filled in', () => {
    expect(platformVatSchema.safeParse(DEFAULT_PLATFORM_VAT).success).toBe(true);
  });
  it('rejects a zero or >100 rate and an unknown mode', () => {
    expect(platformVatSchema.safeParse({ ...DEFAULT_PLATFORM_VAT, rate: 0 }).success).toBe(false);
    expect(platformVatSchema.safeParse({ ...DEFAULT_PLATFORM_VAT, rate: 101 }).success).toBe(false);
    expect(platformVatSchema.safeParse({ ...DEFAULT_PLATFORM_VAT, mode: 'x' }).success).toBe(false);
  });
});

describe('tax registration number shape (ruling TAX-5)', () => {
  it('strips separators and folds Arabic-Indic digits', () => {
    expect(normalizeTaxRegistrationNumber('123-456-789')).toBe('123456789');
    expect(normalizeTaxRegistrationNumber('١٢٣ ٤٥٦ ٧٨٩')).toBe('123456789');
  });
  it('accepts 9 digits, refuses anything else', () => {
    const ok = taxProfileDetailsSchema.safeParse({
      taxRegistrationNumber: '123-456-789',
      legalName: 'Acme',
    });
    expect(ok.success && ok.data.taxRegistrationNumber).toBe('123456789');
    for (const bad of ['12345678', '1234567890', '12345678a', '']) {
      expect(
        taxProfileDetailsSchema.safeParse({ taxRegistrationNumber: bad, legalName: 'Acme' }).success
      ).toBe(false);
    }
  });
});

describe('evidence files are typed by their bytes, not the client mimetype', () => {
  it('PDF, JPEG, PNG are recognised', () => {
    expect(sniffTaxDocumentMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffTaxDocumentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      sniffTaxDocumentMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))
    ).toBe('image/png');
  });
  it('HTML / SVG / anything else is refused (null)', () => {
    expect(sniffTaxDocumentMime(Buffer.from('<html><script>'))).toBeNull();
    expect(sniffTaxDocumentMime(Buffer.from('<svg xmlns='))).toBeNull();
    expect(sniffTaxDocumentMime(Buffer.alloc(0))).toBeNull();
  });
});
