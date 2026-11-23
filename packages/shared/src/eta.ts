import { z } from 'zod/v3';

/**
 * Egyptian Tax Authority (ETA) e-receipt connector, shared contract.
 * Plan: docs/plans/done/2026-10-07-egypt-vat-and-eta.md (addendum "P2-P4 build"), ruling ETA-1.
 * Hosts: https://sdk.invoicing.eta.gov.eg/faq/ (read 2026-10-26).
 */
export const ETA_ENVIRONMENTS = ['preprod', 'prod'] as const;
export type EtaEnvironment = (typeof ETA_ENVIRONMENTS)[number];

export const ETA_HOSTS: Record<EtaEnvironment, { identity: string; api: string; portal: string }> =
  {
    preprod: {
      identity: 'https://id.preprod.eta.gov.eg',
      api: 'https://api.preprod.invoicing.eta.gov.eg',
      portal: 'https://preprod.invoicing.eta.gov.eg',
    },
    prod: {
      identity: 'https://id.eta.gov.eg',
      api: 'https://api.invoicing.eta.gov.eg',
      portal: 'https://invoicing.eta.gov.eg',
    },
  };

export const ETA_RECEIPT_KINDS = ['sale', 'return'] as const;
export type EtaReceiptKind = (typeof ETA_RECEIPT_KINDS)[number];

/**
 * queued     - row written, waiting for the submit job
 * retrying   - a transient failure (429/503/5xx/network); nextAttemptAt is set
 * submitted  - ETA answered 202 and has not (yet) listed it in acceptedDocuments
 * accepted   - listed in acceptedDocuments (longId stored, QR available)
 * rejected   - ETA rejected the document (terminal; the merchant must act)
 * failed     - we could not build/submit a valid receipt (terminal; reason stored)
 * late       - the 24 h window passed without acceptance (needs a Late Submission Request)
 * manual     - needs a human (e.g. a partial return)
 */
export const ETA_RECEIPT_STATUSES = [
  'queued',
  'retrying',
  'submitted',
  'accepted',
  'rejected',
  'failed',
  'late',
  'manual',
] as const;
export type EtaReceiptStatus = (typeof ETA_RECEIPT_STATUSES)[number];

/** 24 h submission window (https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/). */
export const ETA_SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Reasons the ETA accepts on a Return Receipt Without Reference (`documentUseReason`), from
 * https://sdk.invoicing.eta.gov.eg/codes/return-with-no-reference-reasons-type/ (read 2026-10-26; the page
 * lists exactly these two and gives no Arabic text, the Arabic below is ours). The document type is
 * `receiptType "RWR"`, https://sdk.invoicing.eta.gov.eg/documents/return-receipt-without-reference-v1-2/ .
 */
export const ETA_RETURN_NO_REF_REASONS = [
  {
    code: 'I',
    en: 'International return receipt',
    ar: 'إيصال مرتجع دولي (البيع تم خارج مصر)',
  },
  {
    code: 'B',
    en: 'Sales issued before adoption',
    ar: 'بيع صدر قبل اعتماد الإيصال الإلكتروني',
  },
] as const;
export type EtaReturnNoRefReason = (typeof ETA_RETURN_NO_REF_REASONS)[number]['code'];
export const etaReturnReasonSchema = z.object({ reason: z.enum(['I', 'B']) }).strict();

const code = (max: number) => z.string().trim().min(1).max(max);

/** What the merchant types in the admin connect form (secrets are write-only). */
export const etaConnectionInputSchema = z
  .object({
    enabled: z.boolean(),
    environment: z.enum(ETA_ENVIRONMENTS),
    clientId: code(100),
    /** Omitted or starting with `****` (isMaskedSecret) = keep the stored secret. */
    clientSecret: z.string().trim().max(100).optional(),
    posSerial: code(100),
    posPreSharedKey: z.string().trim().max(200).optional(),
    branchCode: code(50),
    /** ETA activity code (https://sdk.invoicing.eta.gov.eg/codes/activity-types/). */
    activityCode: code(10),
    /** An EGS code the merchant registered and ETA approved ("EG-<RIN>-<internal>"). */
    defaultItemCode: code(100),
    address: z.object({
      governate: code(100),
      regionCity: code(100),
      street: code(200),
      buildingNumber: code(100),
      postalCode: z.string().trim().max(30).optional(),
    }),
    /** Merchant-side signing bridge (optional; receipts currently go unsigned). */
    signingBridgeUrl: z.string().url().max(500).optional().nullable(),
    /** Bearer token the bridge expects; write-only like the other secrets. */
    signingBridgeToken: z.string().trim().max(500).optional(),
  })
  .strict();
export type EtaConnectionInput = z.infer<typeof etaConnectionInputSchema>;

/** Seller block data the mapper needs (rin / trade name come from the verified tax profile). */
export interface EtaSeller {
  rin: string;
  companyTradeName: string;
  branchCode: string;
  activityCode: string;
  deviceSerialNumber: string;
  address: {
    governate: string;
    regionCity: string;
    street: string;
    buildingNumber: string;
    postalCode?: string;
  };
}
