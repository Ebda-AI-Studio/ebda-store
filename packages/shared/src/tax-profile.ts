import { z } from 'zod/v3';

/**
 * Egypt VAT gate (ruling TAX-2, docs/plans/done/2026-10-07-egypt-vat-and-eta.md).
 *
 * A merchant may charge VAT only once its VAT registration is VERIFIED by a
 * super-admin. These are the shapes shared by the API (validation) and the
 * admin app (form + status copy), so the two cannot drift.
 */

export const TAX_PROFILE_STATUSES = ['none', 'pending', 'verified', 'rejected', 'revoked'] as const;
export type TaxProfileStatusValue = (typeof TAX_PROFILE_STATUSES)[number];

export const TAX_DOCUMENT_KINDS = ['tax_card', 'vat_certificate', 'other'] as const;
export type TaxDocumentKindValue = (typeof TAX_DOCUMENT_KINDS)[number];

/** PDF or a photo of the card/certificate. Checked by magic bytes server-side too. */
export const TAX_DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const TAX_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Evidence files per profile; a re-submission replaces, it does not pile up. */
export const TAX_DOCUMENT_MAX_COUNT = 5;

/** Statuses from which the merchant may edit details / documents and (re)submit. */
export const TAX_PROFILE_EDITABLE_STATUSES: readonly TaxProfileStatusValue[] = [
  'none',
  'rejected',
  'revoked',
];

/**
 * Egyptian tax registration number: 9 digits, commonly printed as `123-456-789`
 * on the tax card (ruling TAX-5 — shape only; whether the number is REAL is the
 * super-admin's review, there is no government validation API wired yet).
 * Separators (spaces, dashes, dots) are stripped; Arabic-Indic digits are folded.
 */
export function normalizeTaxRegistrationNumber(input: string): string {
  return input
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s\-.]/g, '');
}

export const TAX_REGISTRATION_NUMBER_RE = /^\d{9}$/;

export const taxRegistrationNumberSchema = z
  .string()
  .max(32)
  .transform(normalizeTaxRegistrationNumber)
  .refine(v => TAX_REGISTRATION_NUMBER_RE.test(v), {
    message: 'Tax registration number must be 9 digits',
  });

export const taxProfileDetailsSchema = z
  .object({
    taxRegistrationNumber: taxRegistrationNumberSchema,
    legalName: z.string().trim().min(2).max(200),
  })
  .strict();

export const taxProfileSubmitSchema = z
  .object({
    /** "I am VAT-registered with the Egyptian Tax Authority" — must be true. */
    attest: z.literal(true),
  })
  .strict();

export const taxReviewDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().min(3).max(1000) }).strict(),
  z.object({ decision: z.literal('revoke'), reason: z.string().trim().min(3).max(1000) }).strict(),
]);
export type TaxReviewDecision = z.infer<typeof taxReviewDecisionSchema>;

/** The `409` code the settings route returns when VAT is enabled on an unverified store. */
export const TAX_NOT_VERIFIED_CODE = 'TAX_NOT_VERIFIED';

// ── Ebda's OWN VAT on subscriptions (platform setting, ruling TAX-6) ─────────
// Ebda AI Studio is not VAT-registered yet, so this defaults OFF. It is a
// super-admin setting (system_settings key `ebda.vat`), not an env flag.

export const PLATFORM_VAT_SETTING_KEY = 'ebda.vat';
export const PLATFORM_VAT_MODES = ['exclusive', 'inclusive'] as const;
export type PlatformVatMode = (typeof PLATFORM_VAT_MODES)[number];

export interface PlatformVat {
  enabled: boolean;
  /** Percentage, e.g. 14 for 14%. */
  rate: number;
  mode: PlatformVatMode;
  trn: string | null;
  legalName: string | null;
}

export const DEFAULT_PLATFORM_VAT: PlatformVat = {
  enabled: false,
  rate: 14,
  mode: 'exclusive',
  trn: null,
  legalName: null,
};

export const platformVatSchema = z
  .object({
    enabled: z.boolean(),
    rate: z.number().gt(0).max(100),
    mode: z.enum(PLATFORM_VAT_MODES),
    trn: taxRegistrationNumberSchema.nullable(),
    legalName: z.string().trim().min(2).max(200).nullable(),
  })
  .strict()
  .refine(v => !v.enabled || (v.trn !== null && v.legalName !== null), {
    message:
      "Ebda AI Studio's tax registration number and legal name are required before enabling VAT",
    path: ['enabled'],
  });
