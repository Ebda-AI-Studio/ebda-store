/**
 * Payment-method contracts shared by the API, the storefront, the admin and the
 * orders PWA (SP6a).
 *
 * MONEY: every amount here is integer piastres (EGP minor units).
 */
import { z } from 'zod';

/** Order status of an InstaPay order until the merchant confirms the transfer arrived. */
export const AWAITING_PAYMENT_CONFIRMATION = 'awaiting_payment_confirmation' as const;

/**
 * Order statuses that are NOT sales revenue: the order was cancelled, the money
 * went back, or (InstaPay) the money has not been confirmed to have arrived.
 * Every revenue / analytics / payout / accounting aggregate excludes exactly
 * this set (and also filters on paymentStatus where the figure is "paid").
 */
export const NON_REVENUE_ORDER_STATUSES = [
  'cancelled',
  'refunded',
  AWAITING_PAYMENT_CONFIRMATION,
] as const;

/** Orders in these statuses must never reach fulfilment (carrier booking, pick/pack, shipping). */
export const UNFULFILLABLE_ORDER_STATUSES = [AWAITING_PAYMENT_CONFIRMATION] as const;

export function isAwaitingPaymentConfirmation(status: string | null | undefined): boolean {
  return status === AWAITING_PAYMENT_CONFIRMATION;
}

/** How long an InstaPay order waits for the merchant's confirmation before it expires. */
export const INSTAPAY_DEFAULT_EXPIRY_HOURS = 48;
export const INSTAPAY_MIN_EXPIRY_HOURS = 1;
/** Two weeks: a longer hold would pin stock for a transfer that is almost surely never coming. */
export const INSTAPAY_MAX_EXPIRY_HOURS = 24 * 14;

/** An InstaPay address (IPA): `name@bank`, as the InstaPay app shows it. */
export const INSTAPAY_HANDLE_REGEX = /^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9._-]{2,32}$/;

/** What the customer may type as the transfer reference (bank reference / RRN / last digits). */
export const INSTAPAY_REFERENCE_MAX = 64;
export const instapayReferenceSchema = z
  .string()
  .trim()
  .min(3)
  .max(INSTAPAY_REFERENCE_MAX)
  .regex(/^[\p{L}\p{N} _./#-]+$/u, 'Letters, digits and - _ . / # only');

/**
 * Per-store InstaPay settings. NON-secret: the handle/phone are shown to every
 * customer at checkout, so they live in `payment_configs.settings`, not in the
 * encrypted credential columns.
 */
export const instapaySettingsBaseSchema = z.object({
  /** InstaPay address, e.g. `amelia@instapay`. */
  handle: z.string().trim().regex(INSTAPAY_HANDLE_REGEX).optional(),
  /** Mobile number the merchant's InstaPay account is linked to (Egyptian mobile). */
  phone: z
    .string()
    .trim()
    .regex(/^(?:\+?20|0020|0)?1[0125]\d{8}$/)
    .optional(),
  /** Name the transfer shows (so the customer can check they are paying the right account). */
  accountName: z.string().trim().max(80).optional(),
  expiryHours: z
    .number()
    .int()
    .min(INSTAPAY_MIN_EXPIRY_HOURS)
    .max(INSTAPAY_MAX_EXPIRY_HOURS)
    .default(INSTAPAY_DEFAULT_EXPIRY_HOURS),
  /** Free text shown under the transfer details (EN / AR). */
  noteEn: z.string().trim().max(300).optional(),
  noteAr: z.string().trim().max(300).optional(),
});

/** The enabled form: at least one way to pay (handle or phone) must be set. */
export const instapaySettingsSchema = instapaySettingsBaseSchema.refine(
  v => Boolean(v.handle || v.phone),
  { message: 'Provide an InstaPay handle or a phone number', path: ['handle'] }
);
export type InstapaySettings = z.infer<typeof instapaySettingsSchema>;

/** The instruction the checkout renders for an InstaPay order (what to pay, to whom, quoting what). */
export interface InstapayInstructions {
  kind: 'manual-instructions';
  method: 'instapay';
  handle?: string;
  phone?: string;
  accountName?: string;
  /** Exact amount to transfer, in piastres. */
  amountMinor: number;
  currency: string;
  /** Order number the customer must quote in the transfer note. */
  reference: string;
  expiresAt: string;
  noteEn?: string;
  noteAr?: string;
  /** Reference the customer already submitted, if any. */
  customerReference?: string | null;
}

/** Per-store COD settings (the fee itself stays in `payment_configs.fixed_fee`, piastres). */
export const codSettingsSchema = z.object({
  /** Percentage of the order total added to the fixed fee, in basis points (100 = 1%). */
  percentBps: z.number().int().min(0).max(5000).default(0),
});
export type CodSettings = z.infer<typeof codSettingsSchema>;

// ---------------------------------------------------------------------------
// Egyptian gateways (SP6b). Per-merchant, per-store. The SECRETS of each gateway
// are in the encrypted `payment_configs` columns (api_key / secret_key /
// merchant_id / webhook_secret); only the NON-secret parts live in `settings`:
//
//   Paymob   api_key = Secret key (Intention API `Token`), webhook_secret = HMAC
//            secret; settings = public key + the integration id of each method.
//   Kashier  merchant_id = MID, api_key = Payment API key (also signs webhooks),
//            secret_key = Secret key; settings = allowed methods, page language.
//   Fawry    merchant_id = merchant code, api_key = secure key (signs requests and
//            webhooks); settings = enabled methods, reference-code lifetime.
// ---------------------------------------------------------------------------

/** Customer-facing methods a Paymob integration id can enable. */
export const PAYMOB_METHODS = ['card', 'meeza', 'wallet', 'valu'] as const;
export type PaymobMethod = (typeof PAYMOB_METHODS)[number];

const integrationId = z.number().int().positive().max(2_147_483_647);

export const paymobSettingsBaseSchema = z.object({
  /** Public key of the Paymob account (shown in the checkout URL, not a secret). */
  publicKey: z.string().trim().min(8).max(200).optional(),
  /** Integration id per method (Paymob dashboard -> Payment Integrations). A method with no id is not offered. */
  integrationIds: z
    .object({
      card: integrationId.optional(),
      meeza: integrationId.optional(),
      wallet: integrationId.optional(),
      valu: integrationId.optional(),
    })
    .default({}),
});
export const paymobSettingsSchema = paymobSettingsBaseSchema.refine(
  v => Boolean(v.publicKey) && Object.values(v.integrationIds).some(id => id !== undefined),
  { message: 'Provide the Paymob public key and at least one integration id', path: ['publicKey'] }
);
export type PaymobSettings = z.infer<typeof paymobSettingsBaseSchema>;

export const KASHIER_METHODS = ['card', 'wallet'] as const;
export const kashierSettingsSchema = z.object({
  /** Which methods the hosted page offers; default both. */
  methods: z
    .array(z.enum(KASHIER_METHODS))
    .min(1)
    .default([...KASHIER_METHODS]),
  /** Language of the hosted payment page. */
  display: z.enum(['en', 'ar']).default('ar'),
});
export type KashierSettings = z.infer<typeof kashierSettingsSchema>;

export const FAWRY_METHODS = ['payatfawry', 'card'] as const;
export const FAWRY_DEFAULT_EXPIRY_HOURS = 72;
export const fawrySettingsSchema = z.object({
  methods: z
    .array(z.enum(FAWRY_METHODS))
    .min(1)
    .default([...FAWRY_METHODS]),
  /** How long the reference code stays payable at a Fawry outlet. */
  expiryHours: z.number().int().min(1).max(720).default(FAWRY_DEFAULT_EXPIRY_HOURS),
});
export type FawrySettings = z.infer<typeof fawrySettingsSchema>;

/** The Egyptian gateway adapters (online payment providers). */
export const EGYPT_GATEWAY_PROVIDERS = ['paymob', 'kashier', 'fawry'] as const;
export type EgyptGatewayProvider = (typeof EGYPT_GATEWAY_PROVIDERS)[number];
