/**
 * VAT / e-invoice (ETA) vocabulary of Ebda's OWN subscription billing (NEON-ZERO-1 FOLD TAX-1). One rate constant, one
 * seller snapshot constant and two pure integer functions; the D1 `billing_events` columns (migration 0003) store what
 * these produce. No ETA submission code lives here.
 */

/** Egyptian standard VAT, basis points (14%). The ONE place the billing code reads the default rate from. */
export const BILLING_VAT_RATE_BP = 1400;

/**
 * Who issues the invoice. Snapshotted onto every billing_events row so a later change of legal name or tax id never
 * rewrites an old invoice. NULL until the company's registration number is filled in.
 */
export const SELLER: { legalName: string | null; taxId: string | null } = {
  legalName: null,
  taxId: null,
};

const assertMinor = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`${what} must be a non-negative integer (minor units)`);
};
const assertRate = (bp: number) => {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000)
    throw new RangeError('rateBp must be an integer in 0..10000');
};

/** Round half up on non-negative integers: round(num / den). */
const divRound = (num: number, den: number) => Math.floor((2 * num + den) / (2 * den));

/** VAT-exclusive price -> its VAT, net and gross. gross = net + vat holds exactly. */
export function addVat(netMinor: number, rateBp: number = BILLING_VAT_RATE_BP) {
  assertMinor(netMinor, 'netMinor');
  assertRate(rateBp);
  const vatMinor = divRound(netMinor * rateBp, 10_000);
  return { netMinor, vatMinor, grossMinor: netMinor + vatMinor, rateBp };
}

/** VAT-inclusive amount paid -> the VAT carved out of it. gross = net + vat holds exactly. */
export function splitGross(grossMinor: number, rateBp: number = BILLING_VAT_RATE_BP) {
  assertMinor(grossMinor, 'grossMinor');
  assertRate(rateBp);
  const vatMinor = divRound(grossMinor * rateBp, 10_000 + rateBp);
  return { netMinor: grossMinor - vatMinor, vatMinor, grossMinor, rateBp };
}

export const ETA_STATUSES = ['not_submitted', 'submitted', 'accepted', 'rejected'] as const;
export type EtaStatus = (typeof ETA_STATUSES)[number];
