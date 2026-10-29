/**
 * The `commerce_outcomes` event contract v1 (docs/plans/2026-10-28-customer-intelligence.md 1.2).
 *
 * One versioned envelope; `data` is a STRICT object per type, so an extra key (a phone, a name, an
 * address line) fails validation instead of riding along. `buyerKey` is the only buyer identifier.
 * Adding a key to `data` is a minor change (add it here, optional; CI-2 added `areaKey` to the cod/delivery/return types so a rate can be cut by area without joining events); renaming or removing one is `v: 2`.
 */
import { z } from 'zod/v3';
import { RETURN_REASON_CODES, RETURN_REASON_RAW_MAX, asciiDigits } from './return-reason';

export const CI_PRODUCTS = ['store', 'whatsapp', 'crm', 'erp'] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Closed list: the gateway's own text never enters the stream (it can carry a card fragment or a name). */
export const PAYMENT_FAILURE_CODES = ['declined', 'expired', 'cancelled'] as const;
/** `notification` = the push/SMS/WhatsApp steps, which the dispatcher routes per store; `email` has its own sender. */
export const CART_CHANNELS = ['email', 'notification'] as const;
export const ONBOARDING_STEPS = ['store_created', 'payment_methods', 'went_live'] as const;
/** Events about a merchant or a cart, not about one order: they carry `orderId: null`. */
export const ORDERLESS_TYPES = ['cart.abandoned', 'merchant.onboarding_step'] as const;

const money = z.number().int().nonnegative();
const short = z.string().min(1).max(48);
const reasonCode = z.enum(RETURN_REASON_CODES);
const hours = z.number().nonnegative().finite();

const dataByType = {
  'order.placed': z.strictObject({
    totalMinor: money,
    currency: z.string().length(3),
    paymentMethod: short,
    channel: short,
    itemCount: z.number().int().nonnegative(),
    areaKey: z.string().max(64).nullable(),
    isFirstOrderForBuyerInStore: z.boolean().nullable(),
  }),
  'order.cod_confirmed': z.strictObject({
    confirmedVia: z.enum(['whatsapp', 'call', 'none']),
    minutesToConfirm: z.number().int().nonnegative().nullable(),
    areaKey: z.string().max(64).nullable().optional(),
  }),
  'order.cod_unconfirmed': z.strictObject({
    confirmedVia: z.enum(['whatsapp', 'call', 'none']),
    minutesToConfirm: z.number().int().nonnegative().nullable(),
    areaKey: z.string().max(64).nullable().optional(),
  }),
  'order.cancelled': z.strictObject({
    reason: short,
    byActor: z.enum(['customer', 'merchant', 'system', 'unknown']),
    totalMinor: money,
  }),
  'order.refunded': z.strictObject({
    reason: short,
    byActor: z.enum(['customer', 'merchant', 'system', 'unknown']),
    totalMinor: money,
  }),
  'payment.captured': z.strictObject({
    provider: short,
    methodKind: short,
    totalMinor: money,
    failureCode: z.string().max(48).nullable(),
  }),
  /** The gateway or its webhook said failed / expired / cancelled. `failureCode` is a closed code, never provider text. */
  'payment.failed': z.strictObject({
    provider: short,
    methodKind: short,
    totalMinor: money,
    failureCode: z.enum(PAYMENT_FAILURE_CODES),
  }),
  'shipment.created': z.strictObject({
    carrier: short,
    codMinor: money,
    areaKey: z.string().max(64).nullable(),
    weightGrams: z.number().int().nonnegative().nullable(),
    attemptsToBook: z.number().int().nonnegative(),
  }),
  'shipment.picked_up': z.strictObject({ carrier: short, hoursSinceCreated: hours.nullable() }),
  'shipment.attempted': z.strictObject({
    carrier: short,
    attemptNo: z.number().int().positive(),
    reasonCode: reasonCode.nullable(),
    areaKey: z.string().max(64).nullable().optional(),
  }),
  'shipment.delivered': z.strictObject({
    carrier: short,
    codMinor: money,
    hoursSincePickup: hours.nullable(),
    attempts: z.number().int().nonnegative(),
    areaKey: z.string().max(64).nullable().optional(),
    /** What the buyer was charged for shipping (`orders.shipping`); added after CI-9, absent on older rows. */
    shippingFeeMinor: money.nullable().optional(),
  }),
  'shipment.returned': z.strictObject({
    carrier: short,
    codMinor: money,
    returnReasonCode: reasonCode,
    returnReasonRaw: z.string().max(RETURN_REASON_RAW_MAX).nullable(),
    attempts: z.number().int().nonnegative(),
    hoursSincePickup: hours.nullable(),
    areaKey: z.string().max(64).nullable().optional(),
    shippingFeeMinor: money.nullable().optional(),
  }),
  /** A recovery message went out for an abandoned cart (no order exists yet: `orderId` is null). */
  'cart.abandoned': z.strictObject({
    channel: z.enum(CART_CHANNELS),
    step: z.number().int().min(1).max(3),
  }),
  /** The order that came after a reminder. `hoursToRecover` runs from the FIRST reminder. */
  'cart.recovered': z.strictObject({
    channel: z.enum(CART_CHANNELS),
    hoursToRecover: hours.nullable(),
  }),
  /** A store-setup milestone (no order: `orderId` is null). `step` is a closed code. */
  'merchant.onboarding_step': z.strictObject({
    step: z.enum(ONBOARDING_STEPS),
    secondsSinceSignup: z.number().int().nonnegative().nullable(),
    template: short.nullable(),
  }),
} as const;

export type CiEventType = keyof typeof dataByType;
export const CI_EVENT_TYPES = Object.keys(dataByType) as CiEventType[];

const envelopeBase = {
  v: z.literal(1),
  eventId: z.string().regex(ULID),
  occurredAt: z.number().int().positive(),
  recordedAt: z.number().int().positive(),
  product: z.enum(CI_PRODUCTS),
  storeId: z.string().uuid(),
  xstore: z.boolean(),
  orderId: z.string().uuid().nullable(),
  buyerKey: z.string().regex(HEX64).nullable(),
  keyVersion: z.number().int().positive(),
};

export const ciEnvelopeSchema = z.discriminatedUnion(
  'type',
  CI_EVENT_TYPES.map(type =>
    z.strictObject({ ...envelopeBase, type: z.literal(type), data: dataByType[type] })
  ) as unknown as [
    z.ZodDiscriminatedUnionOption<'type'>,
    ...z.ZodDiscriminatedUnionOption<'type'>[],
  ]
);

export type CiEnvelope = {
  [T in CiEventType]: Omit<z.infer<z.ZodObject<typeof envelopeBase>>, never> & {
    type: T;
    data: z.infer<(typeof dataByType)[T]>;
  };
}[CiEventType];

/** What an emit site / planner supplies; the port adds `v`, `recordedAt`, `product`, `keyVersion`, `eventId`. */
export type CiOutcomeInput = {
  [T in CiEventType]: {
    type: T;
    /** Seed of the deterministic eventId: the same occurrence ALWAYS yields the same id. */
    seed: string;
    occurredAt: Date;
    storeId: string;
    orderId: string | null;
    buyerKey: string | null;
    xstore: boolean;
    data: z.infer<(typeof dataByType)[T]>;
  };
}[CiEventType];

// ---------------------------------------------------------------- ids

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A time-sortable ULID (batch file names). */
export function newUlid(now = Date.now(), rand: (n: number) => Uint8Array = randomBytes): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const r = rand(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[r[i]! % 32];
  return time + tail;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * A ULID-shaped id derived from a seed (SHA-256), so a retry or a second poll of the same occurrence
 * yields the SAME `eventId` and every consumer dedupes on it. The first character is capped at 7 (a
 * ULID's 128-bit range), the rest are 5 bits of digest each.
 */
export async function deterministicEventId(seed: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ebda-ci-v1:${seed}`))
  );
  let bits = '';
  for (const b of d.slice(0, 17)) bits += b.toString(2).padStart(8, '0');
  let out = CROCKFORD[parseInt(bits.slice(0, 3), 2)]!;
  for (let i = 0; i < 25; i++) out += CROCKFORD[parseInt(bits.slice(3 + i * 5, 8 + i * 5), 2)];
  return out;
}

// ---------------------------------------------------------------- privacy guard (Ruling CI-2)

const PHONE_SHAPE = /(?:\+|00)?\d[\d\s().-]{6,}\d/;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Defence in depth behind the strict schema: no string anywhere in `data` may look like a phone or an
 * email. (`returnReasonRaw` is scrubbed before it gets here; this catches a future field that is not.)
 */
export function assertNoPiiShapes(data: unknown, path = 'data'): void {
  if (typeof data === 'string') {
    const t = asciiDigits(data);
    if (PHONE_SHAPE.test(t) || EMAIL_SHAPE.test(t)) {
      throw new Error(`CI envelope refused: ${path} looks like a phone number or email`);
    }
  } else if (Array.isArray(data)) {
    data.forEach((v, i) => assertNoPiiShapes(v, `${path}[${i}]`));
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) assertNoPiiShapes(v, `${path}.${k}`);
  }
}

export function parseEnvelope(body: unknown): CiEnvelope {
  const parsed = ciEnvelopeSchema.parse(body) as CiEnvelope;
  // `orderId` is nullable in the shape only for the two order-less types; every other type needs one.
  const orderless = (ORDERLESS_TYPES as readonly string[]).includes(parsed.type);
  if (orderless !== (parsed.orderId === null)) {
    throw new Error(
      `CI envelope refused: ${parsed.type} ${orderless ? 'carries no orderId' : 'needs an orderId'}`
    );
  }
  assertNoPiiShapes(parsed.data);
  return parsed;
}
