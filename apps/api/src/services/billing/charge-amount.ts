/**
 * THE single place a subscription charge amount is computed (plan price -> what
 * the merchant pays), so Ebda's platform VAT is applied in one spot.
 *
 * `resolvePlatformVat()` reads the super-admin "Ebda VAT" setting through
 * `getPlatformVat()` (default OFF, fail closed, uncached: it decides money).
 * While it is OFF the total equals the plan price exactly and there is no VAT
 * line. Integer piastres only; rate in basis points (14% = 1400).
 * Ruling EBDA-BILLFU-3.
 */
import type { PlatformVat as StoredPlatformVat } from '@force/shared';
import { getPlatformVat } from '../platform-vat.service';

export interface PlatformVat {
  enabled: boolean;
  rateBps: number;
  mode: 'inclusive' | 'exclusive';
  trn?: string | null;
  legalName?: string | null;
}

export interface ChargeAmount {
  /** What is charged / shown as the total. */
  totalMinor: number;
  /** Price before VAT. */
  netMinor: number;
  vatMinor: number;
  /** Present only when VAT applies: the line + Ebda's TRN for the invoice. */
  vat: {
    rateBps: number;
    mode: 'inclusive' | 'exclusive';
    trn: string | null;
    legalName: string | null;
  } | null;
}

export const PLATFORM_VAT_OFF: PlatformVat = { enabled: false, rateBps: 0, mode: 'exclusive' };

/** The stored setting (rate in percent) -> the charge math's shape (basis points). */
export function toChargeVat(v: StoredPlatformVat): PlatformVat {
  if (!v.enabled) return PLATFORM_VAT_OFF;
  return {
    enabled: true,
    rateBps: Math.round(v.rate * 100),
    mode: v.mode,
    trn: v.trn,
    legalName: v.legalName,
  };
}

/** Ebda's VAT right now (one indexed read; never cached, see platform-vat.service). */
export async function resolvePlatformVat(): Promise<PlatformVat> {
  return toChargeVat(await getPlatformVat());
}

/**
 * The amount for a plan price under the CURRENT platform VAT. Call it once per
 * charge and use the same result for the ledger row and the provider call.
 */
export async function chargeFor(priceMinor: number): Promise<ChargeAmount> {
  return subscriptionChargeAmount(priceMinor, await resolvePlatformVat());
}

/**
 * VAT inside an amount already PAID (a manual InstaPay/bank payment the
 * super-admin records): whatever the mode, the money received is the gross, so
 * the VAT is carved out of it. OFF -> no VAT.
 */
export function vatOfPaidAmount(paidMinor: number, vat: PlatformVat): ChargeAmount {
  return subscriptionChargeAmount(paidMinor, { ...vat, mode: 'inclusive' });
}

/** What a `billing_events` row records about VAT (column `vat_minor` + `vat` JSON). */
export function ledgerVat(a: ChargeAmount): { vatMinor: number; vat: LedgerVat | null } {
  if (!a.vat) return { vatMinor: 0, vat: null };
  return {
    vatMinor: a.vatMinor,
    vat: {
      netMinor: a.netMinor,
      vatMinor: a.vatMinor,
      rateBps: a.vat.rateBps,
      mode: a.vat.mode,
      trn: a.vat.trn,
      legalName: a.vat.legalName,
    },
  };
}

export interface LedgerVat {
  netMinor: number;
  vatMinor: number;
  rateBps: number;
  mode: 'inclusive' | 'exclusive';
  trn: string | null;
  legalName: string | null;
}

/** Pure math. `vat` is required on purpose: every caller must decide where VAT comes from. */
export function subscriptionChargeAmount(priceMinor: number, vat: PlatformVat): ChargeAmount {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) {
    throw new RangeError(`Invalid price ${priceMinor}: integer piastres expected`);
  }
  if (!vat.enabled || vat.rateBps <= 0) {
    return { totalMinor: priceMinor, netMinor: priceMinor, vatMinor: 0, vat: null };
  }
  const line = {
    rateBps: vat.rateBps,
    mode: vat.mode,
    trn: vat.trn ?? null,
    legalName: vat.legalName ?? null,
  };
  if (vat.mode === 'inclusive') {
    // price already contains VAT: net = price * 10000 / (10000 + rate), half-up.
    const net = Math.floor(
      (priceMinor * 10000 + Math.floor((10000 + vat.rateBps) / 2)) / (10000 + vat.rateBps)
    );
    return { totalMinor: priceMinor, netMinor: net, vatMinor: priceMinor - net, vat: line };
  }
  const vatMinor = Math.floor((priceMinor * vat.rateBps + 5000) / 10000);
  return { totalMinor: priceMinor + vatMinor, netMinor: priceMinor, vatMinor, vat: line };
}
