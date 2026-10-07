/**
 * THE single place a subscription charge amount is computed (plan price -> what
 * the merchant pays), so Ebda's platform VAT can be applied in one spot later.
 *
 * `resolvePlatformVat()` is the seam for the VAT agent's `getPlatformVat()`
 * (super-admin switch, default OFF). While it is OFF the total equals the plan
 * price exactly and there is no VAT line — today it always is OFF. Integer
 * piastres only; rate in basis points (14% = 1400).
 */
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

const OFF: PlatformVat = { enabled: false, rateBps: 0, mode: 'exclusive' };

/** Seam: replace the body with `getPlatformVat()` when the VAT setting lands. */
export function resolvePlatformVat(): PlatformVat {
  return OFF;
}

export function subscriptionChargeAmount(
  priceMinor: number,
  vat: PlatformVat = resolvePlatformVat()
): ChargeAmount {
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
